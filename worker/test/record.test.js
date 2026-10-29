// GET /api/record/{item_id} — one item's scoring record for fresh_app's scoring-record reader
// (fresh-assistant-api#168, its docs/api/scoring_record_contract.md). Same harness as food.test.js:
// a local RS256 key pair stands in for Clerk, a stubbed fetch for the JWKS and the upstream, and a
// real in-memory SQLite behind the D1 binding so the ceiling's SQL is what is tested.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, { RECORD_PER_HOUR, RECORD_PER_HOUR_IP, FOOD_PER_HOUR, ENGINE_PER_HOUR } from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

// One id of each kind the spec names, each in both colon forms, and the upstream path it becomes.
const IDS = [
  ["fndds", "fndds:22311510", "fndds%3A22311510", "fndds%3A22311510"],
  ["sr", "sr:5062", "sr%3a5062", "sr%3A5062"],
  ["usda", "usda:black-bean-and-rice-salad", "usda%3Ablack-bean-and-rice-salad", "usda%3Ablack-bean-and-rice-salad"],
];
const BEAN = "/api/record/fndds:22311510";
const LABEL = "/record/:item_id";
const FOOD_LABEL = "/food/:source/:code/attributes";
// The upstream's ETag shape: "<32 hex>-<16 hex>-c1" (lib/scoring_record.js there).
const ETAG = '"e7ff7ae80123456789abcdef01234567-8ffbc5e201234567-c1"';
const RELEASE = "scoring-record-1.2.2-2026-10-24";

function baseEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com,http://localhost:8081",
    ASK_UPSTREAM,
    ASK_TOKEN,
    CLERK_ISSUER: ISSUER,
    CLERK_JWKS_URL: JWKS_URL,
    DB: makeSqliteDB(),
    ...overrides,
  };
}

let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody, upstreamHeaders;

const RECORD = {
  scoring_record: { release: RELEASE, tuple_sha256: "8ffbc5e2" + "0".repeat(56) },
  record_sha256: "e7ff7ae8" + "0".repeat(56),
  record: { schema: "1.2.0", item_id: "fndds:22311510" },
};

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "record-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify(RECORD);
  upstreamHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "ETag": ETAG,
    "Cache-Control": "private, no-cache",
    "X-Scoring-Record-Release": RELEASE,
  };
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      // The upstream's own 304: the validator it was sent matches its ETag.
      const inm = init.headers?.get?.("If-None-Match");
      const status = inm && inm === ETAG ? 304 : upstreamStatus;
      return new Response(status === 304 ? null : upstreamBody, { status, headers: upstreamHeaders });
    }
    throw new Error("unexpected fetch in test: " + url);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function validToken(claimOverrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signTestJWT(keyPair.privateKey, kid, {
    iss: ISSUER, sub: "user_test_record", exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
    ...claimOverrides,
  });
}
const auth = async (claims) => ({ Authorization: `Bearer ${await validToken(claims)}` });

function get(route, headers = {}, method = "GET") {
  return new Request("https://worker.example" + route, { method, headers });
}

async function callerHash() {
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("0.0.0.0|" + day));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
async function acctKey(sub) {
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("acct:" + sub + "|" + day));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
async function seed(db, path, n, { sub = "user_test_record", ip = null, subs = 0 } = {}) {
  const hash = ip ?? await callerHash();
  const ins = db.sqlite.prepare(
    "INSERT INTO engine_log (path, ip_hash, status, acct_hash, created_at) VALUES (?, ?, 200, ?, datetime('now'))");
  const keys = subs ? await Promise.all(Array.from({ length: subs }, (_, i) => acctKey("user_other_" + i)))
                    : [await acctKey(sub)];
  for (let i = 0; i < n; i++) ins.run(path, hash, keys[i % keys.length]);
}
const rows = db => db.sqlite.prepare("SELECT path, ip_hash, status FROM engine_log ORDER BY id").all();

describe("GET /api/record/{item_id}", () => {
  describe("valid ids, raw and %3A", () => {
    for (const [kind, raw, encoded, upstreamId] of IDS) {
      for (const [form, id] of [["raw colon", raw], ["%3A", encoded]]) {
        it(`${kind} (${form}): 200 with the body as sent, upstream URL built from the parts`, async () => {
          const env = baseEnv();
          const res = await worker.fetch(get(`/api/record/${id}`, await auth()), env);
          expect(res.status).toBe(200);
          expect(await res.text()).toBe(upstreamBody);
          expect(upstreamCalls.length).toBe(1);
          expect(upstreamCalls[0].url).toBe(`${ASK_UPSTREAM}/api/record/${upstreamId}`);
          expect(upstreamCalls[0].init.method).toBe("GET");
          expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 200 }]);
        });
      }
    }

    // The catalog recipes' four prefixes in the pinned release (gen 82, nhlbi 53, usda 45, hhs 6).
    for (const [id, upstreamId] of [
      ["gen:cajun-spiced-shrimp-cauliflower-rice-bowl", "gen%3Acajun-spiced-shrimp-cauliflower-rice-bowl"],
      ["nhlbi:red-beans-and-rice", "nhlbi%3Ared-beans-and-rice"],
      ["hhs%3Acrispy-salmon-cakes-with-apple-white-bean-greens-salad", "hhs%3Acrispy-salmon-cakes-with-apple-white-bean-greens-salad"],
    ]) {
      it(`the recipe id ${id} forwards`, async () => {
        const env = baseEnv();
        const res = await worker.fetch(get(`/api/record/${id}`, await auth()), env);
        expect(res.status).toBe(200);
        expect(upstreamCalls[0].url).toBe(`${ASK_UPSTREAM}/api/record/${upstreamId}`);
        expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 200 }]);
      });
    }

    it("a code of every allowed character, 160 long, is forwarded as sent", async () => {
      const code = "Ab9._~-".padEnd(160, "z");
      await worker.fetch(get(`/api/record/usda:${code}`, await auth()), baseEnv());
      expect(upstreamCalls[0].url).toBe(`${ASK_UPSTREAM}/api/record/usda%3A${code}`);
    });

    it("a trailing slash on ASK_UPSTREAM does not double up", async () => {
      await worker.fetch(get(BEAN, await auth()), baseEnv({ ASK_UPSTREAM: ASK_UPSTREAM + "/" }));
      expect(upstreamCalls[0].url).toBe(`${ASK_UPSTREAM}/api/record/fndds%3A22311510`);
    });
  });

  describe("the upstream request is built, not passed through", () => {
    it("carries the service bearer and nothing the caller sent", async () => {
      const token = await validToken();
      await worker.fetch(get(BEAN, {
        Authorization: `Bearer ${token}`, "X-Fresh-User": "user_forged", Cookie: "a=b", "X-Account-Id": "user_forged",
      }), baseEnv());
      const { init } = upstreamCalls[0];
      expect([...init.headers.keys()].sort()).toEqual(["authorization"]);
      expect(init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
      expect(init.body).toBeUndefined();
      expect(JSON.stringify([...init.headers])).not.toContain("user_forged");
      expect(JSON.stringify([...init.headers])).not.toContain(token);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("drops the query string and fragment", async () => {
      await worker.fetch(get(BEAN + "?account_id=user_2victim&release=other#x", await auth()), baseEnv());
      expect(upstreamCalls[0].url).toBe(`${ASK_UPSTREAM}/api/record/fndds%3A22311510`);
      expect(JSON.stringify(upstreamCalls[0])).not.toContain("user_2victim");
    });
  });

  describe("bad ids are this hop's 400", () => {
    const BAD = [
      ["an unknown source", "/api/record/branded:123"],
      ["a source that only begins with a known one", "/api/record/nhlbix:red-beans-and-rice"],
      ["a source that ends with a known one", "/api/record/xhhs:crispy-salmon-cakes"],
      ["an uppercase recipe source", "/api/record/NHLBI:red-beans-and-rice"],
      ["an uppercase source", "/api/record/FNDDS:22311510"],
      ["no colon", "/api/record/fndds22311510"],
      ["an empty code", "/api/record/fndds:"],
      ["no source", "/api/record/:22311510"],
      ["a double-encoded colon", "/api/record/fndds%253A22311510"],
      ["a code with a space", "/api/record/fndds:2231%201510"],
      ["a code with an encoded slash", "/api/record/fndds:..%2F..%2Fhealth"],
      ["a code with a second colon", "/api/record/usda:a:b"],
      ["a code over 160 chars", `/api/record/usda:${"a".repeat(161)}`],
      ["a sub-path", "/api/record/fndds:22311510/extra"],
      ["a trailing slash", "/api/record/fndds:22311510/"],
      ["an empty id", "/api/record/"],
    ];
    for (const [label, route] of BAD) {
      it(`400s ${label} (${route}), never calling upstream or writing a row`, async () => {
        const env = baseEnv();
        const res = await worker.fetch(get(route, await auth()), env);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "not an item id", reason: "an item id is source:code, e.g. fndds:22311510" });
        expect(upstreamCalls.length).toBe(0);
        expect(rows(env.DB).length).toBe(0);
      });
    }

    it("a bad id from an anonymous caller is the 401, not the 400", async () => {
      const res = await worker.fetch(get("/api/record/branded:123"), baseEnv());
      expect(res.status).toBe(401);
    });

    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      it(`404s a ${method}, never calling upstream`, async () => {
        const res = await worker.fetch(get(BEAN, await auth(), method), baseEnv());
        expect(res.status).toBe(404);
        expect(upstreamCalls.length).toBe(0);
      });
    }
  });

  describe("authentication", () => {
    it("401s with no Authorization header, never calling upstream or writing a row", async () => {
      const env = baseEnv();
      const res = await worker.fetch(get(BEAN), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(0);
    });

    it("401s a forged, an expired and a garbage bearer (the service token itself)", async () => {
      const other = await generateTestKeyPair();
      const nowSec = Math.floor(Date.now() / 1000);
      const forged = await signTestJWT(other.privateKey, kid, {
        iss: ISSUER, sub: "user_2victim", exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
      });
      const expired = await validToken({ exp: nowSec - 60 });
      const wrongIssuer = await validToken({ iss: "https://evil.example" });
      for (const bearer of [forged, expired, wrongIssuer, ASK_TOKEN, "not.a.jwt"]) {
        const res = await worker.fetch(get(BEAN, { Authorization: `Bearer ${bearer}` }), baseEnv());
        expect(res.status).toBe(401);
      }
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s a bearer when Clerk is not configured", async () => {
      const res = await worker.fetch(get(BEAN, await auth()), baseEnv({ CLERK_JWKS_URL: undefined }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("sign-in verification not configured");
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s, not 401s, when Clerk's JWKS is unreachable", async () => {
      vi.resetModules();
      const coldWorker = (await import("../src/index.js")).default;
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) throw new TypeError("network down");
        upstreamCalls.push({ url });
        return new Response("{}", { status: 200 });
      }));
      const res = await coldWorker.fetch(get(BEAN, await auth()), baseEnv());
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("sign-in verification unavailable");
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s an authenticated caller when ASK_UPSTREAM or ASK_TOKEN is unset; 401s an anonymous one", async () => {
      const headers = await auth();
      for (const missing of [{ ASK_UPSTREAM: undefined }, { ASK_TOKEN: undefined }]) {
        const res = await worker.fetch(get(BEAN, headers), baseEnv(missing));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "record service not configured",
          reason: "scoring records are not configured on this server",
        });
        expect((await worker.fetch(get(BEAN), baseEnv(missing))).status).toBe(401);
      }
      expect(upstreamCalls.length).toBe(0);
    });
  });

  describe("ETag and 304", () => {
    it("the API's ETag shape passes IF_NONE_MATCH_SHAPE: forwarded, and the upstream's 304 comes back with no body", async () => {
      const env = baseEnv();
      const first = await worker.fetch(get(BEAN, await auth()), env);
      expect(first.status).toBe(200);
      const etag = first.headers.get("ETag");
      expect(etag).toBe(ETAG);
      expect(etag).toMatch(/^"[0-9a-f]{32}-[0-9a-f]{16}-c1"$/);

      const second = await worker.fetch(get(BEAN, { ...(await auth()), "If-None-Match": etag }), env);
      expect(upstreamCalls[1].init.headers.get("If-None-Match")).toBe(ETAG);
      expect(second.status).toBe(304);
      expect(await second.text()).toBe("");
      expect(second.headers.get("ETag")).toBe(ETAG);
      expect(second.headers.get("X-Scoring-Record-Release")).toBe(RELEASE);
      expect(rows(env.DB).map(r => r.status)).toEqual([200, 304]);
    });

    it("a W/-prefixed and a comma list of validators are forwarded as sent", async () => {
      for (const v of [`W/${ETAG}`, `"old", ${ETAG}`]) {
        upstreamCalls.length = 0;
        await worker.fetch(get(BEAN, { ...(await auth()), "If-None-Match": v }), baseEnv());
        expect(upstreamCalls[0].init.headers.get("If-None-Match")).toBe(v);
      }
    });

    it("drops an If-None-Match that is not printable ASCII or is over 500 bytes, and still answers 200", async () => {
      for (const bad of ["x".repeat(501), "café", ""]) {
        upstreamCalls.length = 0;
        const res = await worker.fetch(get(BEAN, { ...(await auth()), "If-None-Match": bad }), baseEnv());
        expect(res.status).toBe(200);
        expect(upstreamCalls[0].init.headers.get("If-None-Match")).toBeNull();
      }
    });

    it("a 304 whose body the runtime exposes as a stream is still passed through, not a 500", async () => {
      const headers = await auth();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return { status: 304, headers: new Headers(upstreamHeaders), body: new ReadableStream({ start(c) { c.close(); } }) };
      }));
      const res = await worker.fetch(get(BEAN, { ...headers, "If-None-Match": ETAG }), baseEnv());
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
    });
  });

  describe("response headers", () => {
    it("passes back content-type, etag, cache-control and x-scoring-record-release; drops everything else", async () => {
      upstreamHeaders = {
        ...upstreamHeaders,
        "Retry-After": "7",
        "X-Upstream-Banner": "fresh-assistant-api/1.2.3",
        "Set-Cookie": "session=upstream-secret",
        "Content-Length": "999",
      };
      const res = await worker.fetch(get(BEAN, { ...(await auth()), Origin: "http://localhost:8081" }), baseEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("ETag")).toBe(ETAG);
      expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
      expect(res.headers.get("X-Scoring-Record-Release")).toBe(RELEASE);
      expect(res.headers.get("Retry-After")).toBe("7");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Upstream-Banner")).toBeNull();
      expect(res.headers.get("Content-Length")).not.toBe("999");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    });

    it("exposes X-Scoring-Record-Release and ETag to page JavaScript, beside the version headers when deployed", async () => {
      const plain = await worker.fetch(get(BEAN, await auth()), baseEnv());
      expect(plain.headers.get("Access-Control-Expose-Headers")).toBe("X-Scoring-Record-Release, ETag");

      const deployed = await worker.fetch(get(BEAN, await auth()),
        baseEnv({ CF_VERSION_METADATA: { id: "v-123", timestamp: "2026-10-28T00:00:00Z" } }));
      const exposed = deployed.headers.get("Access-Control-Expose-Headers").split(",").map(s => s.trim());
      expect(exposed).toEqual(expect.arrayContaining(["X-Scoring-Record-Release", "ETag", "X-Worker-Version", "X-Worker-Deployed"]));
      expect(deployed.headers.get("X-Worker-Version")).toBe("v-123");
    });

    it("other routes' exposed headers are unchanged: the version pair only", async () => {
      const res = await worker.fetch(get("/health"),
        baseEnv({ CF_VERSION_METADATA: { id: "v-123", timestamp: "2026-10-28T00:00:00Z" } }));
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe("X-Worker-Version, X-Worker-Deployed");
    });

    it("a ~210 KB body passes through byte for byte", async () => {
      upstreamBody = JSON.stringify({ ...RECORD, record: { schema: "1.2.0", pad: "x".repeat(210_000) } });
      const res = await worker.fetch(get(BEAN, await auth()), baseEnv());
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(upstreamBody);
    });
  });

  describe("upstream statuses pass through", () => {
    for (const [status, body] of [
      [400, { error: "not an item id" }],
      [404, { error: "unknown item" }],
      [503, { error: "scoring record not ready", detail: "pack is being verified" }],
      [500, { error: "record failed verification" }],
    ]) {
      it(`passes the upstream's ${status} through with its body`, async () => {
        upstreamStatus = status;
        upstreamBody = JSON.stringify(body);
        const env = baseEnv();
        const res = await worker.fetch(get(BEAN, await auth()), env);
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual(body);
        expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status }]);
      });
    }

    it("502s when the upstream is unreachable, recording the attempt as 502", async () => {
      const headers = await auth();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }));
      const env = baseEnv();
      const res = await worker.fetch(get(BEAN, headers), env);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: "record service unreachable",
        reason: "record service did not respond; try again later",
      });
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 502 }]);
    });

    it("a failed log write never discards the upstream's response", async () => {
      const env = baseEnv({ DB: makeSqliteDB({ failOn: /^INSERT/ }) });
      const res = await worker.fetch(get(BEAN, await auth()), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(upstreamBody);
    });
  });

  describe("logging and the ceiling", () => {
    it("writes only the fixed label, status and opaque account key: no item id, no source, no sub", async () => {
      const env = baseEnv();
      await worker.fetch(get("/api/record/usda:black-bean-and-rice-salad", await auth()), env);
      const row = env.DB.sqlite.prepare("SELECT path, status, acct_hash FROM engine_log").get();
      expect(row).toEqual({ path: LABEL, status: 200, acct_hash: await acctKey("user_test_record") });
      const everything = JSON.stringify(env.DB.calls) + JSON.stringify(row);
      expect(everything).not.toContain("black-bean");
      expect(everything).not.toContain("usda");
      expect(everything).not.toContain("user_test_record");
    });

    it(`429s at RECORD_PER_HOUR (${RECORD_PER_HOUR}) per account, never calling upstream or adding a row`, async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RECORD_PER_HOUR);
      const res = await worker.fetch(get(BEAN, await auth()), env);
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body).toMatchObject({
        reason: expect.stringContaining(`scoring record limit reached for this account (${RECORD_PER_HOUR} per hour)`),
        scope: "account",
      });
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(RECORD_PER_HOUR);
    });

    it(`the per-address backstop (${RECORD_PER_HOUR_IP}) refuses a new account on a saturated address`, async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RECORD_PER_HOUR_IP, { subs: 5 });
      const res = await worker.fetch(get(BEAN, await auth({ sub: "user_brand_new" })), env);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("address");
    });

    it("one under the ceiling is admitted, and that row fills it", async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RECORD_PER_HOUR - 1);
      expect((await worker.fetch(get(BEAN, await auth()), env)).status).toBe(200);
      expect((await worker.fetch(get(BEAN, await auth()), env)).status).toBe(429);
    });

    it("food rows do not count against the record ceiling, nor record rows against the food one", async () => {
      const env = baseEnv();
      await seed(env.DB, FOOD_LABEL, FOOD_PER_HOUR);
      expect((await worker.fetch(get(BEAN, await auth()), env)).status).toBe(200);

      const env2 = baseEnv();
      await seed(env2.DB, LABEL, RECORD_PER_HOUR);
      expect((await worker.fetch(get("/api/food/fndds/51101000/attributes", await auth()), env2)).status).toBe(200);
    });

    it("record rows do not count against the engine ceiling", async () => {
      const token = await validToken();
      const env = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env.DB, LABEL, ENGINE_PER_HOUR);
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return new Response("{}", { status: 200 });
      }));
      const res = await worker.fetch(new Request("https://worker.example/api/engine/version", {
        headers: { Authorization: `Bearer ${token}` },
      }), env);
      expect(res.status).toBe(200);
    });

    it("reads the count before the upstream call and writes ONE row after it", async () => {
      const headers = await auth();
      const env = baseEnv();
      let callsAtUpstream = null;
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        callsAtUpstream = env.DB.calls.map(c => c.sql);
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }));
      await worker.fetch(get(BEAN, headers), env);
      expect(callsAtUpstream).toHaveLength(1);
      expect(callsAtUpstream[0]).toMatch(/AND path LIKE '\/record\/%'/);
      const writes = env.DB.calls.filter(c => /^(INSERT|UPDATE)/.test(c.sql));
      expect(writes).toHaveLength(1);
    });
  });

  it("a preflight from the app's web build is allowed to send Authorization and If-None-Match", async () => {
    const res = await worker.fetch(new Request("https://worker.example" + BEAN, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:8081",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,if-none-match",
      },
    }), baseEnv());
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("If-None-Match");
  });
});
