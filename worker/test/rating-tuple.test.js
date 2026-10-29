// GET /api/rating-tuple — the rate host's tuple of rating inputs, read from fresh-assistant-api's
// /health (its docs/api/recipe_rate_contract.md 3.19, fresh-assistant-api#172), for fresh_app's saved
// recipes. Same harness as record.test.js: a local RS256 key pair stands in for Clerk, a stubbed fetch
// for the JWKS and the upstream, and a real in-memory SQLite behind the D1 binding.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, { RATING_TUPLE_PER_HOUR, RATING_TUPLE_PER_HOUR_IP, ENGINE_PER_HOUR, FOOD_PER_HOUR, RECIPE_PER_HOUR }
  from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

const ROUTE = "/api/rating-tuple";
const LABEL = "/rating-tuple";
const TUPLE = "2fd881e95c75a165f5911630517768ccdab6f15f964764584a369a3e4189e1f5";
const ETAG = `"${TUPLE}"`;

// What /health says besides the tuple: none of it may reach the caller.
const HEALTH = {
  ok: true, backend: "anthropic",
  service: { name: "fresh-assistant-api", version: "0.1.0", image: "registry.fly.io/fresh-assistant-api:deployment-X" },
  scoring_record: { pinned: true, release: "scoring-record-1.2.2-2026-10-24", tuple_sha256: "8ffbc5e2" + "0".repeat(56) },
  rating_tuple: { tuple_sha256: TUPLE },
  mode: "full (model pass enabled)", model: "claude-sonnet-5-5",
};

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

let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody;

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "tuple-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify(HEALTH);
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      return new Response(upstreamBody, { status: upstreamStatus, headers: {
        "Content-Type": "application/json; charset=utf-8", "Set-Cookie": "upstream=secret", "X-Upstream-Banner": "fly" } });
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
    iss: ISSUER, sub: "user_test_tuple", exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
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
async function seed(db, path, n, { sub = "user_test_tuple", ip = null, subs = 0 } = {}) {
  const hash = ip ?? await callerHash();
  const ins = db.sqlite.prepare(
    "INSERT INTO engine_log (path, ip_hash, status, acct_hash, created_at) VALUES (?, ?, 200, ?, datetime('now'))");
  const keys = subs ? await Promise.all(Array.from({ length: subs }, (_, i) => acctKey("user_other_" + i)))
                    : [await acctKey(sub)];
  for (let i = 0; i < n; i++) ins.run(path, hash, keys[i % keys.length]);
}
const rows = db => db.sqlite.prepare("SELECT path, ip_hash, status FROM engine_log ORDER BY id").all();

describe("GET /api/rating-tuple", () => {
  describe("the tuple", () => {
    it("200s with only {rating_tuple: {tuple_sha256}}, a strong ETag of the hash and Cache-Control private, max-age=60", async () => {
      const env = baseEnv();
      const res = await worker.fetch(get(ROUTE, await auth()), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rating_tuple: { tuple_sha256: TUPLE } });
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("ETag")).toBe(ETAG);
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 200 }]);
    });

    it("nothing else from /health crosses: not its fields, not its headers", async () => {
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
      const text = await res.text();
      expect(Object.keys(JSON.parse(text))).toEqual(["rating_tuple"]);
      expect(Object.keys(JSON.parse(text).rating_tuple)).toEqual(["tuple_sha256"]);
      for (const leaked of ["anthropic", "claude-sonnet", "deployment-X", "scoring-record", "full (model"]) {
        expect(text).not.toContain(leaked);
      }
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Upstream-Banner")).toBeNull();
    });

    it("reads the upstream on every call (a new tuple is seen at once, not after the cache)", async () => {
      const headers = await auth();
      const env = baseEnv();
      await worker.fetch(get(ROUTE, headers), env);
      const NEW = "ab".repeat(32);
      upstreamBody = JSON.stringify({ ...HEALTH, rating_tuple: { tuple_sha256: NEW } });
      const res = await worker.fetch(get(ROUTE, headers), env);
      expect(upstreamCalls.length).toBe(2);
      expect((await res.json()).rating_tuple.tuple_sha256).toBe(NEW);
      expect(res.headers.get("ETag")).toBe(`"${NEW}"`);
    });
  });

  describe("null: the rate host has not answered since a boot", () => {
    for (const [label, body] of [
      ["rating_tuple null", { ...HEALTH, rating_tuple: null }],
      ["rating_tuple absent", (({ rating_tuple, ...rest }) => rest)(HEALTH)],
      ["tuple_sha256 absent", { ...HEALTH, rating_tuple: {} }],
    ]) {
      it(`passes ${label} through as null, with no validator and no caching`, async () => {
        upstreamBody = JSON.stringify(body);
        const env = baseEnv();
        const res = await worker.fetch(get(ROUTE, await auth()), env);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ rating_tuple: null });
        expect(res.headers.get("ETag")).toBeNull();
        expect(res.headers.get("Cache-Control")).toBe("private, no-cache");
        expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 200 }]);
      });
    }

    it("a null is never a 304, whatever the caller sends", async () => {
      upstreamBody = JSON.stringify({ ...HEALTH, rating_tuple: null });
      const res = await worker.fetch(get(ROUTE, { ...(await auth()), "If-None-Match": "*" }), baseEnv());
      expect(res.status).toBe(200);
    });

    for (const bad of ["abc", "A".repeat(64), TUPLE.slice(0, 63), TUPLE + "0", 12345, { x: 1 }, ["a"], ""]) {
      it(`a tuple that is not 64 lowercase hex (${JSON.stringify(bad).slice(0, 30)}) is answered as null`, async () => {
        upstreamBody = JSON.stringify({ ...HEALTH, rating_tuple: { tuple_sha256: bad } });
        const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ rating_tuple: null });
      });
    }
  });

  describe("ETag and 304", () => {
    it("304s with no body when If-None-Match names the tuple, keeping the ETag and Cache-Control", async () => {
      const env = baseEnv();
      const res = await worker.fetch(get(ROUTE, { ...(await auth()), "If-None-Match": ETAG }), env);
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("ETag")).toBe(ETAG);
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 304 }]);
    });

    it("a W/-prefixed validator (the edge weakens the ETag), a list and * all match", async () => {
      for (const v of [`W/${ETAG}`, `"old", ${ETAG}`, `"old", W/${ETAG}`, "*"]) {
        const res = await worker.fetch(get(ROUTE, { ...(await auth()), "If-None-Match": v }), baseEnv());
        expect(res.status, v).toBe(304);
      }
    });

    it("200s with the body when the validator is another tuple's, a near miss or malformed", async () => {
      for (const v of [`"${"ab".repeat(32)}"`, TUPLE, `"${TUPLE.slice(1)}"`, "x".repeat(501), "café", ""]) {
        const res = await worker.fetch(get(ROUTE, { ...(await auth()), "If-None-Match": v }), baseEnv());
        expect(res.status, v).toBe(200);
        expect((await res.json()).rating_tuple.tuple_sha256).toBe(TUPLE);
      }
    });

    it("a 304 still reads the upstream and still counts against the ceiling", async () => {
      const env = baseEnv();
      await worker.fetch(get(ROUTE, { ...(await auth()), "If-None-Match": ETAG }), env);
      expect(upstreamCalls.length).toBe(1);
      expect(rows(env.DB).length).toBe(1);
    });
  });

  describe("the upstream request", () => {
    it("is GET <ASK_UPSTREAM>/health with no headers: no bearer, nothing the caller sent", async () => {
      const token = await validToken();
      await worker.fetch(get(ROUTE + "?account_id=user_2victim&x=1", {
        Authorization: `Bearer ${token}`, "X-Fresh-User": "user_forged", Cookie: "a=b", "If-None-Match": ETAG,
      }), baseEnv());
      const { url, init } = upstreamCalls[0];
      expect(url).toBe(ASK_UPSTREAM + "/health");
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect([...init.headers.keys()]).toEqual([]);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(upstreamCalls[0])).not.toContain("user_2victim");
      expect(JSON.stringify([...init.headers])).not.toContain(token);
      expect(JSON.stringify([...init.headers])).not.toContain(ASK_TOKEN);
    });

    it("a trailing slash on ASK_UPSTREAM does not double up", async () => {
      await worker.fetch(get(ROUTE, await auth()), baseEnv({ ASK_UPSTREAM: ASK_UPSTREAM + "/" }));
      expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + "/health");
    });

    it("works with ASK_TOKEN unset: /health is public and the token is not needed for it", async () => {
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv({ ASK_TOKEN: undefined }));
      expect(res.status).toBe(200);
    });
  });

  describe("upstream failures are this hop's 502", () => {
    const expected = { error: "rating service unreachable", reason: "rating service did not respond; try again later" };

    for (const status of [500, 503, 404]) {
      it(`an upstream ${status} is a 502, not a null the app would store`, async () => {
        upstreamStatus = status;
        const env = baseEnv();
        const res = await worker.fetch(get(ROUTE, await auth()), env);
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual(expected);
        expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 502 }]);
      });
    }

    for (const [label, body] of [["not JSON", "<html>fly error</html>"], ["JSON null", "null"], ["a JSON string", '"ok"']]) {
      it(`a 200 whose body is ${label} is a 502`, async () => {
        upstreamBody = body;
        const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual(expected);
      });
    }

    it("unreachable or over the timeout is a 502, recorded as 502", async () => {
      const headers = await auth();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }));
      const env = baseEnv();
      const res = await worker.fetch(get(ROUTE, headers), env);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual(expected);
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 502 }]);
    });

    it("a failed log write never discards the answer", async () => {
      const env = baseEnv({ DB: makeSqliteDB({ failOn: /^INSERT/ }) });
      const res = await worker.fetch(get(ROUTE, await auth()), env);
      expect(res.status).toBe(200);
      expect((await res.json()).rating_tuple.tuple_sha256).toBe(TUPLE);
    });
  });

  describe("authentication and configuration", () => {
    it("401s with no Authorization header, never calling upstream or writing a row", async () => {
      const env = baseEnv();
      const res = await worker.fetch(get(ROUTE), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(0);
    });

    it("401s a forged, an expired, a wrong-issuer and a garbage bearer (the service token included)", async () => {
      const other = await generateTestKeyPair();
      const nowSec = Math.floor(Date.now() / 1000);
      const forged = await signTestJWT(other.privateKey, kid, {
        iss: ISSUER, sub: "user_2victim", exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
      });
      const expired = await validToken({ exp: nowSec - 60 });
      const wrongIssuer = await validToken({ iss: "https://evil.example" });
      for (const bearer of [forged, expired, wrongIssuer, ASK_TOKEN, "not.a.jwt"]) {
        const res = await worker.fetch(get(ROUTE, { Authorization: `Bearer ${bearer}` }), baseEnv());
        expect(res.status).toBe(401);
      }
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s a bearer when Clerk is not configured; still 401s with no bearer", async () => {
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv({ CLERK_ISSUER: undefined }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("sign-in verification not configured");
      expect((await worker.fetch(get(ROUTE), baseEnv({ CLERK_ISSUER: undefined }))).status).toBe(401);
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
      const res = await coldWorker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("sign-in verification unavailable");
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s an authenticated caller when ASK_UPSTREAM is unset; 401s an anonymous one", async () => {
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv({ ASK_UPSTREAM: undefined }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "rating service not configured",
        reason: "the rating tuple is not configured on this server",
      });
      expect((await worker.fetch(get(ROUTE), baseEnv({ ASK_UPSTREAM: undefined }))).status).toBe(401);
    });

    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      it(`404s a ${method}, never calling upstream`, async () => {
        const res = await worker.fetch(get(ROUTE, await auth(), method), baseEnv());
        expect(res.status).toBe(404);
        expect(upstreamCalls.length).toBe(0);
      });
    }

    for (const route of ["/api/rating-tuple/", "/api/rating-tuples", "/api/rating-tuple/x"]) {
      it(`404s ${route}, never calling upstream`, async () => {
        const res = await worker.fetch(get(route, await auth()), baseEnv());
        expect(res.status).toBe(404);
        expect(upstreamCalls.length).toBe(0);
      });
    }
  });

  describe("CORS", () => {
    it("exposes ETag to page JavaScript, beside the version headers when deployed", async () => {
      const plain = await worker.fetch(get(ROUTE, { ...(await auth()), Origin: "http://localhost:8081" }), baseEnv());
      expect(plain.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
      expect(plain.headers.get("Access-Control-Expose-Headers")).toBe("ETag");

      const deployed = await worker.fetch(get(ROUTE, await auth()),
        baseEnv({ CF_VERSION_METADATA: { id: "v-123", timestamp: "2026-10-29T00:00:00Z" } }));
      const exposed = deployed.headers.get("Access-Control-Expose-Headers").split(",").map(s => s.trim());
      expect(exposed).toEqual(expect.arrayContaining(["ETag", "X-Worker-Version", "X-Worker-Deployed"]));
    });

    it("a 304 exposes it too", async () => {
      const res = await worker.fetch(get(ROUTE, { ...(await auth()), "If-None-Match": ETAG }), baseEnv());
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe("ETag");
    });
  });

  describe("logging and the ceiling", () => {
    it("writes only the fixed label, status and opaque account key: never the tuple or the sub", async () => {
      const env = baseEnv();
      await worker.fetch(get(ROUTE, await auth()), env);
      const row = env.DB.sqlite.prepare("SELECT path, status, acct_hash FROM engine_log").get();
      expect(row).toEqual({ path: LABEL, status: 200, acct_hash: await acctKey("user_test_tuple") });
      const everything = JSON.stringify(env.DB.calls) + JSON.stringify(row);
      expect(everything).not.toContain(TUPLE);
      expect(everything).not.toContain("user_test_tuple");
    });

    it(`429s at RATING_TUPLE_PER_HOUR (${RATING_TUPLE_PER_HOUR}) per account, never calling upstream or adding a row`, async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RATING_TUPLE_PER_HOUR);
      const res = await worker.fetch(get(ROUTE, await auth()), env);
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({
        reason: expect.stringContaining(`rating tuple limit reached for this account (${RATING_TUPLE_PER_HOUR} per hour)`),
        scope: "account",
      });
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(RATING_TUPLE_PER_HOUR);
    });

    it(`the per-address backstop (${RATING_TUPLE_PER_HOUR_IP}) refuses a new account on a saturated address`, async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RATING_TUPLE_PER_HOUR_IP, { subs: 5 });
      const res = await worker.fetch(get(ROUTE, await auth({ sub: "user_brand_new" })), env);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("address");
    });

    it("one under the ceiling is admitted, and that row fills it", async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RATING_TUPLE_PER_HOUR - 1);
      expect((await worker.fetch(get(ROUTE, await auth()), env)).status).toBe(200);
      expect((await worker.fetch(get(ROUTE, await auth()), env)).status).toBe(429);
    });

    it("the ceilings are disjoint: tuple rows leave food, record, recipe and engine open, and theirs leave the tuple open", async () => {
      const token = await validToken();
      const env = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env.DB, LABEL, RATING_TUPLE_PER_HOUR);
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return new Response("{}", { status: 200 });
      }));
      const call = path => worker.fetch(new Request("https://worker.example" + path, { headers: { Authorization: `Bearer ${token}` } }), env);
      expect((await call("/api/engine/version")).status).toBe(200);
      expect((await call("/api/food/fndds/51101000/attributes")).status).toBe(200);
      expect((await call("/api/record/fndds:22311510")).status).toBe(200);

      const env2 = baseEnv();
      await seed(env2.DB, "/version", ENGINE_PER_HOUR);
      await seed(env2.DB, "/food/:source/:code/attributes", FOOD_PER_HOUR);
      await seed(env2.DB, "/record/:item_id", FOOD_PER_HOUR);
      await seed(env2.DB, "/recipe/rate", RECIPE_PER_HOUR);
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return new Response(upstreamBody, { status: 200 });
      }));
      expect((await worker.fetch(get(ROUTE, await auth()), env2)).status).toBe(200);
    });

    it("reads the count before the upstream call and writes ONE row after it", async () => {
      const headers = await auth();
      const env = baseEnv();
      let callsAtUpstream = null;
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        callsAtUpstream = env.DB.calls.map(c => c.sql);
        return new Response(upstreamBody, { status: 200 });
      }));
      await worker.fetch(get(ROUTE, headers), env);
      expect(callsAtUpstream).toHaveLength(1);
      expect(callsAtUpstream[0]).toMatch(/AND path LIKE '\/rating-tuple%'/);
      expect(env.DB.calls.filter(c => /^(INSERT|UPDATE)/.test(c.sql))).toHaveLength(1);
    });
  });

  it("a preflight from the app's web build is allowed to send Authorization and If-None-Match", async () => {
    const res = await worker.fetch(new Request("https://worker.example" + ROUTE, {
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
