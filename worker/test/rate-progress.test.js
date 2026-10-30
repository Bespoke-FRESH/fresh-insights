// GET /api/recipe/rate/progress/{request_id} — where a rating (or a swap search) is, for fresh_app's
// import screen (fresh-assistant-api docs/api/recipe_rate_contract.md 3.21 and 3.22). Same harness as
// rating-tuple.test.js: a local RS256 key pair stands in for Clerk, a stubbed fetch for the JWKS and the
// upstream, and a real in-memory SQLite behind the D1 binding.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  RATE_PROGRESS_PER_HOUR, RATE_PROGRESS_PER_HOUR_IP, RATING_TUPLE_PER_HOUR, ENGINE_PER_HOUR, FOOD_PER_HOUR, RECIPE_PER_HOUR,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

const PREFIX = "/api/recipe/rate/progress/";
const LABEL = "/rate-progress";
const SUB = "user_test_progress";
const RID = "import-9f3a.1_b-2";
const ROUTE = PREFIX + RID;

const RATING = { stage: "checking", lines_matched: 7, lines_total: 9, updated_at: "2026-10-29T22:50:01.123Z" };
const SWAP = { kind: "swap", stage: "scoring", versions_total: 3, versions_done: 1, variants: 2, updated_at: "2026-10-29T22:50:02.000Z" };
const UNKNOWN = { error: "unknown request_id" };

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
  kid = "progress-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify(RATING);
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      const nullBody = upstreamStatus === 204 || upstreamStatus === 304;
      return new Response(nullBody ? null : upstreamBody, { status: upstreamStatus, headers: {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600",
        "ETag": "\"x\"", "Set-Cookie": "upstream=secret", "X-Upstream-Banner": "fly" } });
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
    iss: ISSUER, sub: SUB, exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
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
async function seed(db, path, n, { sub = SUB, ip = null, subs = 0 } = {}) {
  const hash = ip ?? await callerHash();
  const ins = db.sqlite.prepare(
    "INSERT INTO engine_log (path, ip_hash, status, acct_hash, created_at) VALUES (?, ?, 200, ?, datetime('now'))");
  const keys = subs ? await Promise.all(Array.from({ length: subs }, (_, i) => acctKey("user_other_" + i)))
                    : [await acctKey(sub)];
  for (let i = 0; i < n; i++) ins.run(path, hash, keys[i % keys.length]);
}
const rows = db => db.sqlite.prepare("SELECT path, ip_hash, status FROM engine_log ORDER BY id").all();

describe("GET /api/recipe/rate/progress/{request_id}", () => {
  describe("the answer", () => {
    it("passes a rating's status and JSON body through unchanged, with no-store and one label-only row", async () => {
      const env = baseEnv();
      const res = await worker.fetch(get(ROUTE, await auth()), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RATING);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 200 }]);
    });

    it("passes a swap search's different shape through untouched (the Worker does not know the fields)", async () => {
      upstreamBody = JSON.stringify(SWAP);
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(await res.json()).toEqual(SWAP);
    });

    it("passes the body byte for byte", async () => {
      upstreamBody = '{"stage":"done",  "lines_matched":9,"lines_total":9,"updated_at":"2026-10-29T22:50:09.000Z","extra":[1,2]}';
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(await res.text()).toBe(upstreamBody);
    });

    for (const [status, body] of [[404, UNKNOWN], [401, { error: "unauthorized" }], [503, { error: "not ready" }], [500, { error: "boom" }], [405, { error: "method" }]]) {
      it(`passes the upstream's ${status} through with its body, no-store, logged as ${status}`, async () => {
        upstreamStatus = status;
        upstreamBody = JSON.stringify(body);
        const env = baseEnv();
        const res = await worker.fetch(get(ROUTE, await auth()), env);
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual(body);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status }]);
      });
    }

    it("a 204 from the upstream is a 204 with no body", async () => {
      upstreamStatus = 204;
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(res.status).toBe(204);
      expect(await res.text()).toBe("");
    });

    it("of the upstream's headers only Content-Type crosses; Cache-Control is always no-store", async () => {
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("ETag")).toBeNull();
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Upstream-Banner")).toBeNull();
    });
  });

  describe("the upstream request", () => {
    it("is GET <ASK_UPSTREAM>/api/recipe/rate/progress/<id> with only the service bearer and the verified subject", async () => {
      await worker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(upstreamCalls).toHaveLength(1);
      const { url, init } = upstreamCalls[0];
      expect(url).toBe(ASK_UPSTREAM + PREFIX + RID);
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect([...headers.keys()].sort()).toEqual(["authorization", "x-account-id"]);
      expect(headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
      expect(headers.get("X-Account-Id")).toBe(SUB);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("sets X-Account-Id from the verified token, never from the client's header, and drops everything else the client sent", async () => {
      const token = await validToken();
      await worker.fetch(get(ROUTE + "?account_id=user_2victim&x=1", {
        Authorization: `Bearer ${token}`, "X-Account-Id": "user_2victim", "X-Fresh-User": "user_forged",
        Cookie: "a=b", "If-None-Match": "\"x\"",
      }), baseEnv());
      const { url, init } = upstreamCalls[0];
      const headers = new Headers(init.headers);
      expect(headers.get("X-Account-Id")).toBe(SUB);
      expect([...headers.keys()].sort()).toEqual(["authorization", "x-account-id"]);
      expect(url).not.toContain("?");
      expect(JSON.stringify(upstreamCalls[0])).not.toContain("user_2victim");
      expect(JSON.stringify([...headers])).not.toContain(token);
    });

    it("sends the account of the same shape the rate route puts in the body (a sub that is not fit to forward has none)", async () => {
      await worker.fetch(get(ROUTE, await auth({ sub: "user with space" })), baseEnv());
      const headers = new Headers(upstreamCalls[0].init.headers);
      expect(headers.has("X-Account-Id")).toBe(false);
      expect(headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    });

    it("a trailing slash on ASK_UPSTREAM does not double up", async () => {
      await worker.fetch(get(ROUTE, await auth()), baseEnv({ ASK_UPSTREAM: ASK_UPSTREAM + "/" }));
      expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + PREFIX + RID);
    });

    it("times out at 3 s and does not retry", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      await worker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(spy).toHaveBeenCalledWith(3000);
      spy.mockRestore();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        upstreamCalls.push({ url });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }));
      upstreamCalls = [];
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv());
      expect(res.status).toBe(502);
      expect(upstreamCalls).toHaveLength(1);
    });

    for (const id of ["a", "A.b_c-9", "x".repeat(200), "9", "_lead", "-lead", "a..b", "a.", "UPPER-lower_09.x"]) {
      it(`forwards the id ${JSON.stringify(id.length > 30 ? id.slice(0, 12) + "…(" + id.length + ")" : id)} as given`, async () => {
        const res = await worker.fetch(get(PREFIX + id, await auth()), baseEnv());
        expect(res.status).toBe(200);
        expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + PREFIX + id);
      });
    }
  });

  describe("an id that is not a request_id", () => {
    // The contract's 404 for a string that is not an id, answered here with its body and no call, no row.
    for (const [label, tail] of [
      ["empty", ""], ["too long (201)", "x".repeat(201)], ["starting with a dot", ".hidden"], ["a dot only", "."],
      ["with a slash", "a%2Fb"], ["with a space", "a%20b"], ["with a colon", "fndds:1"], ["with a percent escape", "a%25b"],
      ["with a plus", "a+b"], ["with a tilde", "a~b"], ["non-ASCII", "caf%C3%A9"], ["with a nested path", "a/b"],
      ["with a semicolon", "a;b"], ["with a quote", "a%22b"], ["with a backslash", "a%5Cb"], ["with a null byte", "a%00b"],
    ]) {
      it(`404s an id that is ${label}, never calling upstream or writing a row`, async () => {
        const env = baseEnv();
        const res = await worker.fetch(get(PREFIX + tail, await auth()), env);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual(UNKNOWN);
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect(upstreamCalls).toHaveLength(0);
        expect(rows(env.DB)).toHaveLength(0);
      });
    }

    it("401s an anonymous caller whatever the id", async () => {
      for (const tail of ["", "a%20b", RID]) {
        const res = await worker.fetch(get(PREFIX + tail), baseEnv());
        expect(res.status).toBe(401);
      }
      expect(upstreamCalls).toHaveLength(0);
    });
  });

  describe("upstream failure", () => {
    it("an unreachable upstream is this hop's 502, no-store, logged as 502", async () => {
      const headers = await auth();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new TypeError("network down");
      }));
      const env = baseEnv();
      const res = await worker.fetch(get(ROUTE, headers), env);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: "progress service unreachable", reason: "rating progress did not respond; try again later",
      });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 502 }]);
    });

    it("a failed log write never discards the answer", async () => {
      const env = baseEnv({ DB: makeSqliteDB({ failOn: /^INSERT/ }) });
      const res = await worker.fetch(get(ROUTE, await auth()), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(RATING);
    });
  });

  describe("authentication and configuration", () => {
    it("401s with no Authorization header, never calling upstream or writing a row", async () => {
      const env = baseEnv();
      const res = await worker.fetch(get(ROUTE), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls).toHaveLength(0);
      expect(rows(env.DB)).toHaveLength(0);
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
      expect(upstreamCalls).toHaveLength(0);
    });

    it("503s a bearer when Clerk is not configured; still 401s with no bearer", async () => {
      const res = await worker.fetch(get(ROUTE, await auth()), baseEnv({ CLERK_ISSUER: undefined }));
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("sign-in verification not configured");
      expect((await worker.fetch(get(ROUTE), baseEnv({ CLERK_ISSUER: undefined }))).status).toBe(401);
      expect(upstreamCalls).toHaveLength(0);
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
      expect(upstreamCalls).toHaveLength(0);
    });

    for (const unset of ["ASK_UPSTREAM", "ASK_TOKEN"]) {
      it(`503s an authenticated caller when ${unset} is unset (no-store); 401s an anonymous one`, async () => {
        const res = await worker.fetch(get(ROUTE, await auth()), baseEnv({ [unset]: undefined }));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "progress service not configured", reason: "rating progress is not configured on this server",
        });
        expect(res.headers.get("Cache-Control")).toBe("no-store");
        expect((await worker.fetch(get(ROUTE), baseEnv({ [unset]: undefined }))).status).toBe(401);
        expect(upstreamCalls).toHaveLength(0);
      });
    }

    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      it(`404s a ${method}, never calling upstream`, async () => {
        const res = await worker.fetch(get(ROUTE, await auth(), method), baseEnv());
        expect(res.status).toBe(404);
        expect(upstreamCalls).toHaveLength(0);
      });
    }

    it("the rate route's own path is untouched: /api/recipe/rate/progress without an id is not this route", async () => {
      const res = await worker.fetch(get("/api/recipe/rate/progress", await auth()), baseEnv());
      expect(res.status).toBe(404);
      expect(upstreamCalls).toHaveLength(0);
    });
  });

  describe("CORS", () => {
    it("allows the page origin on the answer and the 404", async () => {
      const origin = "http://localhost:8081";
      const ok = await worker.fetch(get(ROUTE, { ...(await auth()), Origin: origin }), baseEnv());
      expect(ok.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      const missing = await worker.fetch(get(PREFIX + "a%20b", { ...(await auth()), Origin: origin }), baseEnv());
      expect(missing.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    });

    it("a preflight from the app's web build is allowed to send Authorization", async () => {
      const res = await worker.fetch(new Request("https://worker.example" + ROUTE, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8081",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      }), baseEnv());
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
      expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    });
  });

  describe("logging and the ceiling", () => {
    it("writes only the fixed label, status and opaque account key: never the request id or the sub", async () => {
      const env = baseEnv();
      await worker.fetch(get(ROUTE, await auth()), env);
      const row = env.DB.sqlite.prepare("SELECT path, status, acct_hash FROM engine_log").get();
      expect(row).toEqual({ path: LABEL, status: 200, acct_hash: await acctKey(SUB) });
      const everything = JSON.stringify(env.DB.calls) + JSON.stringify(row);
      expect(everything).not.toContain(RID);
      expect(everything).not.toContain(SUB);
    });

    it(`429s at RATE_PROGRESS_PER_HOUR (${RATE_PROGRESS_PER_HOUR}) per account, no-store, never calling upstream or adding a row`, async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RATE_PROGRESS_PER_HOUR);
      const res = await worker.fetch(get(ROUTE, await auth()), env);
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({
        reason: expect.stringContaining(`rating progress limit reached for this account (${RATE_PROGRESS_PER_HOUR} per hour)`),
        scope: "account",
      });
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
      expect(upstreamCalls).toHaveLength(0);
      expect(rows(env.DB)).toHaveLength(RATE_PROGRESS_PER_HOUR);
    });

    it(`the per-address backstop (${RATE_PROGRESS_PER_HOUR_IP}) refuses a new account on a saturated address`, async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RATE_PROGRESS_PER_HOUR_IP, { subs: 5 });
      const res = await worker.fetch(get(ROUTE, await auth({ sub: "user_brand_new" })), env);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("address");
    });

    it("one under the ceiling is admitted, and that row fills it", async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, RATE_PROGRESS_PER_HOUR - 1);
      expect((await worker.fetch(get(ROUTE, await auth()), env)).status).toBe(200);
      expect((await worker.fetch(get(ROUTE, await auth()), env)).status).toBe(429);
    });

    it("the ceiling is far above the rate route's: a poll every second for an hour fits", () => {
      expect(RATE_PROGRESS_PER_HOUR).toBeGreaterThanOrEqual(3600);
      expect(RATE_PROGRESS_PER_HOUR).toBeGreaterThan(RECIPE_PER_HOUR);
    });

    it("polls do not spend the rate route's ceiling, and the rate route's rows do not block polls", async () => {
      // Polls: a full day of them leaves a rate call open.
      const env = baseEnv();
      await seed(env.DB, LABEL, RATE_PROGRESS_PER_HOUR - 1);
      const rate = await worker.fetch(new Request("https://worker.example/api/recipe/rate", {
        method: "POST",
        headers: { ...(await auth()), "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: RID, lines: ["1 cup rice"] }),
      }), env);
      expect(rate.status).toBe(200);

      // Rate rows: a saturated rate ceiling leaves polls open.
      const env2 = baseEnv();
      await seed(env2.DB, "/recipe/rate", RECIPE_PER_HOUR);
      expect((await worker.fetch(get(ROUTE, await auth()), env2)).status).toBe(200);
    });

    it("the ceilings are disjoint: progress rows leave engine, food, record and tuple open, and theirs leave progress open", async () => {
      const token = await validToken();
      const env = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env.DB, LABEL, RATE_PROGRESS_PER_HOUR);
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return new Response(JSON.stringify({ rating_tuple: { tuple_sha256: "ab".repeat(32) } }), { status: 200 });
      }));
      const call = path => worker.fetch(new Request("https://worker.example" + path, { headers: { Authorization: `Bearer ${token}` } }), env);
      expect((await call("/api/engine/version")).status).toBe(200);
      expect((await call("/api/food/fndds/51101000/attributes")).status).toBe(200);
      expect((await call("/api/record/fndds:22311510")).status).toBe(200);
      expect((await call("/api/rating-tuple")).status).toBe(200);

      const env2 = baseEnv();
      await seed(env2.DB, "/version", ENGINE_PER_HOUR);
      await seed(env2.DB, "/food/:source/:code/attributes", FOOD_PER_HOUR);
      await seed(env2.DB, "/record/:item_id", FOOD_PER_HOUR);
      await seed(env2.DB, "/rating-tuple", RATING_TUPLE_PER_HOUR);
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
      expect(callsAtUpstream[0]).toMatch(/AND path LIKE '\/rate-progress%'/);
      expect(env.DB.calls.filter(c => /^(INSERT|UPDATE)/.test(c.sql))).toHaveLength(1);
    });
  });
});
