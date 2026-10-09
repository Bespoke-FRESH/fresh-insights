// GET /api/food/{source}/{code}/attributes — the per-food attribute panel for fresh_app's food
// card (fresh_app#495, fresh-assistant-api#62, fresh-insights#54). Same harness as recipe.test.js:
// a local RS256 key pair stands in for Clerk, a stubbed fetch for the JWKS and the upstream, and a
// real in-memory SQLite behind the D1 binding so the ceiling's SQL is what is tested.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, { FOOD_PER_HOUR, RECIPE_PER_HOUR } from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

const BREAD = "/api/food/fndds/51101000/attributes";   // white bread, the contract's first fixture
const SR = "/api/food/sr/01001/attributes";
const LABEL = "/food/:source/:code/attributes";

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

const PANEL = {
  release: "food-attributes-2017-2018-v2.0.1", source: "fndds", code: "51101000",
  name: "Bread, white", basis: "per100g",
  rows: [{ key: "fiber", name: "Fiber", amount: 2.7, unit: "g", status: "measured", source: "fndds", confidence: 1 }],
};

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "food-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify(PANEL);
  upstreamHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "ETag": '"fa-2.0.1-fndds-51101000"',
    "Cache-Control": "public, max-age=31536000, immutable",
  };
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      return new Response(upstreamStatus === 304 ? null : upstreamBody, { status: upstreamStatus, headers: upstreamHeaders });
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
    iss: ISSUER, sub: "user_test_food", exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
    ...claimOverrides,
  });
}
const auth = async (claims) => ({ Authorization: `Bearer ${await validToken(claims)}` });

function get(route, headers = {}, method = "GET") {
  return new Request("https://worker.example" + route, { method, headers });
}

// The hash the Worker computes for a request with no CF-Connecting-IP, so a test can seed rows
// that count against the same caller.
async function callerHash() {
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("0.0.0.0|" + day));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
async function seed(db, path, n) {
  const hash = await callerHash();
  const ins = db.sqlite.prepare("INSERT INTO engine_log (path, ip_hash, status) VALUES (?, ?, 200)");
  for (let i = 0; i < n; i++) ins.run(path, hash);
}
const rows = db => db.sqlite.prepare("SELECT path, ip_hash, status FROM engine_log ORDER BY id").all();

describe("GET /api/food/{source}/{code}/attributes", () => {
  describe("authentication", () => {
    for (const route of [BREAD, SR]) {
      it(`401s on ${route} with no Authorization header, never calling upstream or claiming a slot`, async () => {
        const env = baseEnv();
        const res = await worker.fetch(get(route), env);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
        expect(upstreamCalls.length).toBe(0);
        expect(rows(env.DB).length).toBe(0);
      });
    }

    it("401s a token signed by a key the JWKS does not hold (a forged account)", async () => {
      const other = await generateTestKeyPair();
      const nowSec = Math.floor(Date.now() / 1000);
      const forged = await signTestJWT(other.privateKey, kid, {
        iss: ISSUER, sub: "user_2victim", exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
      });
      const env = baseEnv();
      const res = await worker.fetch(get(BREAD, { Authorization: `Bearer ${forged}` }), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(0);
    });

    it("401s an expired JWT and a garbage bearer (the service token itself)", async () => {
      const expired = await validToken({ exp: Math.floor(Date.now() / 1000) - 60 });
      for (const bearer of [expired, ASK_TOKEN, "not.a.jwt"]) {
        const res = await worker.fetch(get(BREAD, { Authorization: `Bearer ${bearer}` }), baseEnv());
        expect(res.status).toBe(401);
      }
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s a bearer when Clerk is not configured; still 401s with no bearer, so config state is not disclosed", async () => {
      const headers = await auth();
      for (const missing of [{ CLERK_ISSUER: undefined }, { CLERK_JWKS_URL: undefined }]) {
        const res = await worker.fetch(get(BREAD, headers), baseEnv(missing));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "sign-in verification not configured",
          reason: "sign-in cannot be checked on this server right now; try again later",
        });
        const anon = await worker.fetch(get(BREAD), baseEnv(missing));
        expect(anon.status).toBe(401);
      }
      expect(upstreamCalls.length).toBe(0);
    });

    for (const [label, jwksFetch] of [
      ["unreachable", async () => { throw new TypeError("network down"); }],
      ["answering 500", async () => new Response("nope", { status: 500 })],
    ]) {
      it(`503s, not 401s, when Clerk's JWKS is ${label}`, async () => {
        vi.resetModules();
        const coldWorker = (await import("../src/index.js")).default;
        vi.stubGlobal("fetch", vi.fn(async (input) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.startsWith(JWKS_URL)) return jwksFetch();
          upstreamCalls.push({ url });
          return new Response("{}", { status: 200 });
        }));
        const env = baseEnv();
        const res = await coldWorker.fetch(get(BREAD, await auth()), env);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "sign-in verification unavailable",
          reason: "sign-in cannot be checked right now; try again later",
        });
        expect(upstreamCalls.length).toBe(0);
        expect(rows(env.DB).length).toBe(0);
      });
    }
  });

  describe("configuration", () => {
    it("503s an authenticated caller when ASK_UPSTREAM or ASK_TOKEN is unset; 401s an anonymous one", async () => {
      const headers = await auth();
      for (const missing of [{ ASK_UPSTREAM: undefined }, { ASK_TOKEN: undefined }]) {
        const res = await worker.fetch(get(BREAD, headers), baseEnv(missing));
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "food service not configured",
          reason: "food attributes are not configured on this server",
        });
        expect((await worker.fetch(get(BREAD), baseEnv(missing))).status).toBe(401);
      }
      expect(upstreamCalls.length).toBe(0);
    });
  });

  describe("forwarding", () => {
    it("fndds: upstream gets GET on the same path with the service bearer, never the caller's JWT", async () => {
      const token = await validToken();
      const res = await worker.fetch(get(BREAD, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(PANEL);
      expect(upstreamCalls.length).toBe(1);
      const { url, init } = upstreamCalls[0];
      expect(url).toBe(ASK_UPSTREAM + BREAD);
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
      expect(init.headers.get("Authorization")).not.toContain(token);
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it("sr: the source segment is forwarded as sent", async () => {
      await worker.fetch(get(SR, await auth()), baseEnv());
      expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + SR);
    });

    it("a trailing slash on ASK_UPSTREAM does not double up", async () => {
      await worker.fetch(get(BREAD, await auth()), baseEnv({ ASK_UPSTREAM: ASK_UPSTREAM + "/" }));
      expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + BREAD);
    });

    // Nothing caller-supplied can name an account upstream: not a header, not the query string.
    it("never forwards the inbound X-Fresh-User, Cookie or Authorization, nor adds an account of its own", async () => {
      const token = await validToken();
      await worker.fetch(get(BREAD, {
        Authorization: `Bearer ${token}`, "X-Fresh-User": "user_forged", Cookie: "a=b", "X-Account-Id": "user_forged",
      }), baseEnv());
      const h = upstreamCalls[0].init.headers;
      expect([...h.keys()].sort()).toEqual(["authorization"]);
      expect(JSON.stringify([...h])).not.toContain("user_forged");
      expect(JSON.stringify([...h])).not.toContain("user_test_food");
    });

    it("drops the query string: ?account_id= and anything else there never reaches the upstream", async () => {
      await worker.fetch(get(BREAD + "?account_id=user_2victim&release=other&x=1", await auth()), baseEnv());
      expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + BREAD);
      expect(JSON.stringify(upstreamCalls[0])).not.toContain("user_2victim");
    });

    it("forwards a well-shaped If-None-Match and passes the upstream's 304 through with no body", async () => {
      upstreamStatus = 304;
      const res = await worker.fetch(get(BREAD, { ...(await auth()), "If-None-Match": '"fa-2.0.1-fndds-51101000"' }), baseEnv());
      expect(upstreamCalls[0].init.headers.get("If-None-Match")).toBe('"fa-2.0.1-fndds-51101000"');
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("ETag")).toBe('"fa-2.0.1-fndds-51101000"');
    });

    it("drops an If-None-Match that is not printable ASCII or is over 500 bytes, and still answers", async () => {
      // A value with a CR or LF cannot be built into a Request at all, so it is not a case here.
      for (const bad of ["x".repeat(501), "café", ""]) {
        upstreamCalls.length = 0;
        const res = await worker.fetch(get(BREAD, { ...(await auth()), "If-None-Match": bad }), baseEnv());
        expect(res.status).toBe(200);
        expect(upstreamCalls[0].init.headers.get("If-None-Match")).toBeNull();
      }
    });
  });

  describe("response headers", () => {
    it("passes back content-type, etag and cache-control, adds CORS, and drops everything else", async () => {
      upstreamHeaders = {
        ...upstreamHeaders,
        "Retry-After": "7",
        "X-Upstream-Banner": "fresh-assistant-api/1.2.3",
        "Content-Encoding": "identity",
        "Set-Cookie": "session=upstream-secret",
        "Content-Length": "999",
      };
      const res = await worker.fetch(get(BREAD, { ...(await auth()), Origin: "http://localhost:8081" }), baseEnv());
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(res.headers.get("ETag")).toBe('"fa-2.0.1-fndds-51101000"');
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
      expect(res.headers.get("Retry-After")).toBe("7");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Upstream-Banner")).toBeNull();
      expect(res.headers.get("Content-Encoding")).toBeNull();
      expect(res.headers.get("Content-Length")).not.toBe("999");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    });

    it("an upstream with no etag or cache-control yields a response with neither, not an empty value", async () => {
      upstreamHeaders = { "Content-Type": "application/json" };
      const res = await worker.fetch(get(BREAD, await auth()), baseEnv());
      expect(res.headers.has("ETag")).toBe(false);
      expect(res.headers.has("Cache-Control")).toBe(false);
    });
  });

  describe("upstream passthrough", () => {
    it("passes the upstream's 404 for an unknown code through with its body", async () => {
      upstreamStatus = 404;
      upstreamBody = JSON.stringify({ error: "unknown food", reason: "no fndds food 99999999 in food-attributes-2017-2018-v2.0.1" });
      const env = baseEnv();
      const res = await worker.fetch(get("/api/food/fndds/99999999/attributes", await auth()), env);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(upstreamBody);
      expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 404 }]);
    });

    for (const status of [400, 429, 500, 503]) {
      it(`passes an upstream ${status} through with its body unchanged`, async () => {
        upstreamStatus = status;
        upstreamBody = JSON.stringify({ error: `upstream said ${status}` });
        const res = await worker.fetch(get(BREAD, await auth()), baseEnv());
        expect(res.status).toBe(status);
        expect(await res.text()).toBe(upstreamBody);
      });
    }

    it("502s when the upstream is unreachable or times out, recording the attempt as 502", async () => {
      const headers = await auth();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }));
      const env = baseEnv();
      const res = await worker.fetch(get(BREAD, headers), env);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: "food service unreachable",
        reason: "food service did not respond; try again later",
      });
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 502 }]);
    });

    it("a failed status write never discards the upstream's response", async () => {
      const env = baseEnv({ DB: makeSqliteDB({ failOn: /^UPDATE/ }) });
      const res = await worker.fetch(get(BREAD, await auth()), env);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(PANEL);
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: null }]);
    });
  });

  describe("logging and the ceiling", () => {
    it("writes only the fixed label and status to engine_log: no code, no source, no sub", async () => {
      const env = baseEnv();
      await worker.fetch(get("/api/food/sr/01001/attributes", await auth()), env);
      const logged = rows(env.DB);
      expect(logged).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 200 }]);
      const everything = JSON.stringify(env.DB.calls) + JSON.stringify(logged);
      expect(everything).not.toContain("01001");
      expect(everything).not.toMatch(/\/sr\b/);
      expect(everything).not.toContain("user_test_food");
    });

    it(`429s at FOOD_PER_HOUR (${FOOD_PER_HOUR}), never calling upstream or adding a row`, async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, FOOD_PER_HOUR);
      const res = await worker.fetch(get(BREAD, await auth()), env);
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({
        error: "too many requests — try again later",
        reason: `food lookup limit reached (${FOOD_PER_HOUR} per hour); try again later`,
      });
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(FOOD_PER_HOUR);
    });

    it("one under the ceiling is still admitted, and that claim fills it", async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, FOOD_PER_HOUR - 1);
      expect((await worker.fetch(get(BREAD, await auth()), env)).status).toBe(200);
      expect((await worker.fetch(get(SR, await auth()), env)).status).toBe(429);
      expect(upstreamCalls.length).toBe(1);
    });

    it("the ceiling is the food route's own: 600 of these is not 30 recipe calls", async () => {
      expect(FOOD_PER_HOUR).toBeGreaterThan(RECIPE_PER_HOUR);
      expect(FOOD_PER_HOUR).toBe(600);
    });

    it("a listed dev sub gets no raise here: the public ceiling is the only ceiling", async () => {
      const env = baseEnv({ RECIPE_DEV_SUBS: "user_test_food", ASK_DEV_SUBS: "user_test_food" });
      await seed(env.DB, LABEL, FOOD_PER_HOUR);
      expect((await worker.fetch(get(BREAD, await auth()), env)).status).toBe(429);
    });

    it("recipe and engine rows do not count against the food ceiling", async () => {
      const env = baseEnv();
      await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
      await seed(env.DB, "/version", 60);
      await seed(env.DB, "/recipe/rate", FOOD_PER_HOUR);
      expect((await worker.fetch(get(BREAD, await auth()), env)).status).toBe(200);
    });

    it("food rows do not count against the recipe ceiling", async () => {
      const token = await validToken();
      const env = baseEnv();
      await seed(env.DB, LABEL, FOOD_PER_HOUR);
      const res = await worker.fetch(new Request("https://worker.example/api/recipe/rate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: '{"servings":1,"lines":[]}',
      }), env);
      expect(res.status).toBe(200);
    });

    it("food rows do not count against the engine ceiling", async () => {
      const token = await validToken();
      const env = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env.DB, LABEL, FOOD_PER_HOUR);
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

    it("the ceiling check and the claim are ONE statement, issued before the upstream call", async () => {
      const headers = await auth();
      const env = baseEnv();
      let callsAtUpstream = null;
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        callsAtUpstream = env.DB.calls.map(c => c.sql);
        return new Response("{}", { status: 200 });
      }));
      await worker.fetch(get(BREAD, headers), env);
      expect(callsAtUpstream).toHaveLength(1);
      expect(callsAtUpstream[0]).toMatch(/^INSERT INTO engine_log .* SELECT .* WHERE \(SELECT COUNT\(\*\) FROM engine_log .* path LIKE '\/food\/%'/s);
    });

    it("concurrent card opens cannot overshoot the ceiling while earlier calls are in flight", async () => {
      const headers = await auth();
      const env = baseEnv();
      await seed(env.DB, LABEL, FOOD_PER_HOUR - 2);
      let release;
      const gate = new Promise(r => { release = r; });
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        upstreamCalls.push({ url });
        await gate;
        return new Response("{}", { status: 200 });
      }));
      const pending = Array.from({ length: 10 }, () => worker.fetch(get(BREAD, headers), env));
      await new Promise(r => setTimeout(r, 50));
      release();
      const statuses = (await Promise.all(pending)).map(r => r.status);
      expect(statuses.filter(s => s === 200).length).toBe(2);
      expect(statuses.filter(s => s === 429).length).toBe(8);
      expect(upstreamCalls.length).toBe(2);
      expect(rows(env.DB).length).toBe(FOOD_PER_HOUR);
    });
  });

  describe("routing and CORS", () => {
    const BAD_PATHS = [
      ["an unknown source", "/api/food/branded/123/attributes"],
      ["an uppercase source", "/api/food/FNDDS/51101000/attributes"],
      ["a code with a slash", "/api/food/fndds/511/01000/attributes"],
      ["a code with a space", "/api/food/fndds/511%2001000/attributes"],
      ["an empty code", "/api/food/fndds//attributes"],
      ["a code over 40 chars", `/api/food/fndds/${"1".repeat(41)}/attributes`],
      ["no /attributes", "/api/food/fndds/51101000"],
      ["a different leaf", "/api/food/fndds/51101000/nutrients"],
      ["a trailing slash", "/api/food/fndds/51101000/attributes/"],
      ["a dotted traversal", "/api/food/fndds/..%2F..%2Fhealth/attributes"],
    ];
    for (const [label, route] of BAD_PATHS) {
      it(`404s ${label} (${route}), never calling upstream or claiming a slot`, async () => {
        const env = baseEnv();
        const res = await worker.fetch(get(route, await auth()), env);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "not found" });
        expect(upstreamCalls.length).toBe(0);
        expect(rows(env.DB).length).toBe(0);
      });
    }

    it("a code of letters, digits, dot, dash and underscore up to 40 chars is forwarded as sent", async () => {
      const code = "Ab-9_.z".padEnd(40, "0");
      await worker.fetch(get(`/api/food/sr/${code}/attributes`, await auth()), baseEnv());
      expect(upstreamCalls[0].url).toBe(`${ASK_UPSTREAM}/api/food/sr/${code}/attributes`);
    });

    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
      it(`404s a ${method} to the route, never calling upstream`, async () => {
        const res = await worker.fetch(get(BREAD, await auth(), method), baseEnv());
        expect(res.status).toBe(404);
        expect(upstreamCalls.length).toBe(0);
      });
    }

    it("a preflight from the app's web build is allowed to send Authorization", async () => {
      const res = await worker.fetch(new Request("https://worker.example" + BREAD, {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8081",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      }), baseEnv());
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    });
  });
});
