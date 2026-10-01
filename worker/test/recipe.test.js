import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, { RECIPE_PER_HOUR, RECIPE_PER_HOUR_DEV } from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB, readAllBytes } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

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

// One key for the whole file, for the same reason as engine.test.js: the module-level JWKS cache
// throttles refetching on an unknown kid.
let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody;

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "recipe-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ candidates: [{ title: "Soda bread" }], source: "url" });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) {
        return new Response(JSON.stringify(jwksDoc), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith(ASK_UPSTREAM)) {
        upstreamCalls.push({ url, init });
        return new Response(upstreamBody, {
          status: upstreamStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("unexpected fetch in test: " + url);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function validToken(claimOverrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signTestJWT(keyPair.privateKey, kid, {
    iss: ISSUER,
    sub: "user_test_recipe",
    exp: nowSec + 3600,
    nbf: nowSec - 10,
    iat: nowSec - 10,
    ...claimOverrides,
  });
}

function post(route, body, headers = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Request("https://worker.example" + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(bytes.byteLength),
      ...headers,
    },
    body: bytes,
  });
}

const ROUTES = ["/api/recipe/extract", "/api/recipe/transcribe", "/api/recipe/rate"];

describe("/api/recipe/* proxy", () => {
  describe("authentication", () => {
    for (const route of ROUTES) {
      it(`401s on ${route} with no Authorization header, never calling upstream`, async () => {
        const res = await worker.fetch(post(route, '{"url":"https://example.com/r"}'), baseEnv());
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
        expect(upstreamCalls.length).toBe(0);
      });
    }

    it("401s on an expired JWT", async () => {
      const token = await validToken({ exp: Math.floor(Date.now() / 1000) - 60 });
      const res = await worker.fetch(
        post("/api/recipe/extract", "{}", { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls.length).toBe(0);
    });

    it("401s on a garbage bearer (e.g. the service token itself)", async () => {
      const res = await worker.fetch(
        post("/api/recipe/rate", "{}", { Authorization: `Bearer ${ASK_TOKEN}` }), baseEnv());
      expect(res.status).toBe(401);
      expect(upstreamCalls.length).toBe(0);
    });
  });

  describe("configuration", () => {
    it("401s an anonymous caller when ASK_UPSTREAM is unset, so config state is not disclosed", async () => {
      const res = await worker.fetch(post("/api/recipe/extract", "{}"), baseEnv({ ASK_UPSTREAM: undefined }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
    });

    it("503s an authenticated caller when ASK_UPSTREAM is unset", async () => {
      const token = await validToken();
      const res = await worker.fetch(
        post("/api/recipe/extract", "{}", { Authorization: `Bearer ${token}` }),
        baseEnv({ ASK_UPSTREAM: undefined }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "recipe service not configured",
        reason: "recipe service is not configured on this server",
      });
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s when ASK_TOKEN is unset", async () => {
      const token = await validToken();
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }),
        baseEnv({ ASK_TOKEN: undefined }));
      expect(res.status).toBe(503);
      expect(upstreamCalls.length).toBe(0);
    });
  });

  describe("forwarding", () => {
    for (const route of ROUTES) {
      it(`${route}: upstream gets the service bearer, never the caller's JWT, and the exact bytes`, async () => {
        const token = await validToken();
        const payload = JSON.stringify({ url: "https://example.com/soda-bread", note: "café — ½ cup" });
        const res = await worker.fetch(
          post(route, payload, { Authorization: `Bearer ${token}` }), baseEnv());

        expect(res.status).toBe(200);
        expect(upstreamCalls.length).toBe(1);
        const call = upstreamCalls[0];
        expect(call.url).toBe(ASK_UPSTREAM + route);
        expect(call.init.method).toBe("POST");
        expect(call.init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
        expect(call.init.headers.get("Authorization")).not.toContain(token);
        expect(call.init.headers.get("Content-Type")).toBe("application/json");
        expect(call.init.body).toBeInstanceOf(ReadableStream);
        expect(call.init.duplex).toBe("half");
        const forwarded = await readAllBytes(call.init.body);
        expect(Array.from(forwarded)).toEqual(Array.from(new TextEncoder().encode(payload)));
      });
    }

    it("transcribe: a base64 image payload arrives byte-for-byte", async () => {
      const token = await validToken();
      // Every byte value, so the base64 alphabet (+, /, =) is fully exercised.
      const raw = new Uint8Array(3000).map((_, i) => (i * 7919) % 256);
      let bin = "";
      for (const b of raw) bin += String.fromCharCode(b);
      const payload = JSON.stringify({ images: [{ data: btoa(bin), media_type: "image/jpeg" }] });
      const bytes = new TextEncoder().encode(payload);

      const res = await worker.fetch(
        post("/api/recipe/transcribe", bytes, { Authorization: `Bearer ${token}` }), baseEnv());

      expect(res.status).toBe(200);
      const forwarded = await readAllBytes(upstreamCalls[0].init.body);
      expect(forwarded.byteLength).toBe(bytes.byteLength);
      expect(Array.from(forwarded)).toEqual(Array.from(bytes));
      expect(upstreamCalls[0].init.headers.get("Content-Length")).toBe(String(bytes.byteLength));
    });

    it("never forwards an inbound X-Fresh-User or Cookie header", async () => {
      const token = await validToken();
      await worker.fetch(post("/api/recipe/extract", "{}", {
        Authorization: `Bearer ${token}`, "X-Fresh-User": "user_forged", Cookie: "a=b",
      }), baseEnv());
      const h = upstreamCalls[0].init.headers;
      expect(h.get("X-Fresh-User")).toBeNull();
      expect(h.get("Cookie")).toBeNull();
    });
  });

  describe("size cap", () => {
    it("413s one byte over the engine route's cap, never calling upstream", async () => {
      const token = await validToken();
      const req = new Request("https://worker.example/api/recipe/transcribe", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": String(10 * 1024 * 1024 + 1),
        },
        body: new Uint8Array(1),
      });
      const res = await worker.fetch(req, baseEnv());
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "request body too large", reason: "photos too large; send fewer or smaller photos" });
      expect(upstreamCalls.length).toBe(0);
    });

    // A body with no Content-Length is counted as it streams. The upstream stub drains what it
    // is sent, as a real upstream would, so the cut-off surfaces as a failed fetch.
    function chunkedReq(token, totalBytes, chunkBytes = 1024 * 1024) {
      let sent = 0;
      const body = new ReadableStream({
        pull(controller) {
          if (sent >= totalBytes) return controller.close();
          const n = Math.min(chunkBytes, totalBytes - sent);
          sent += n;
          controller.enqueue(new Uint8Array(n));
        },
      });
      return new Request("https://worker.example/api/recipe/transcribe", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        duplex: "half",
      });
    }
    function drainingUpstream() {
      vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        const bytes = init.body ? await readAllBytes(init.body) : new Uint8Array(0);
        upstreamCalls.push({ url, init, received: bytes.byteLength });
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }));
    }

    it("413s a chunked body that streams past the cap, recording the attempt as 413", async () => {
      drainingUpstream();
      const token = await validToken();
      const env = baseEnv();
      const req = chunkedReq(token, 10 * 1024 * 1024 + 1);
      expect(req.headers.get("Content-Length")).toBeNull();
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "request body too large", reason: "photos too large; send fewer or smaller photos" });
      expect(env.DB.sqlite.prepare("SELECT path, status FROM engine_log").all())
        .toEqual([{ path: "/recipe/transcribe", status: 413 }]);
    });

    it("forwards a chunked body under the cap byte-for-byte", async () => {
      drainingUpstream();
      const token = await validToken();
      const res = await worker.fetch(chunkedReq(token, 3 * 1024 * 1024 + 7), baseEnv());
      expect(res.status).toBe(200);
      expect(upstreamCalls[0].received).toBe(3 * 1024 * 1024 + 7);
    });
  });

  describe("upstream passthrough", () => {
    for (const status of [400, 500, 503]) {
      it(`passes an upstream ${status} through with its body unchanged`, async () => {
        upstreamStatus = status;
        upstreamBody = JSON.stringify({ error: `upstream said ${status}`, reason: "model pass disabled" });
        const token = await validToken();
        const res = await worker.fetch(
          post("/api/recipe/extract", '{"url":"x"}', { Authorization: `Bearer ${token}` }), baseEnv());
        expect(res.status).toBe(status);
        expect(await res.text()).toBe(upstreamBody);
      });
    }

    it("passes back only Content-Type and Retry-After from the upstream's headers", async () => {
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        const headers = new Headers({
          "Content-Type": "application/json",
          "Retry-After": "120",
          "X-Upstream-Banner": "fresh-assistant-api/1.2.3",
          "Content-Encoding": "identity",
        });
        headers.append("Set-Cookie", "session=upstream-secret");
        return new Response('{"error":"busy"}', { status: 503, headers });
      }));
      const token = await validToken();
      const res = await worker.fetch(post("/api/recipe/extract", '{"url":"x"}', {
        Authorization: `Bearer ${token}`, Origin: "http://localhost:8081",
      }), baseEnv());
      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Retry-After")).toBe("120");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Upstream-Banner")).toBeNull();
      expect(res.headers.get("Content-Encoding")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    });

    it("502s when the upstream is unreachable", async () => {
      const token = await validToken();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new TypeError("network down");
      }));
      const res = await worker.fetch(
        post("/api/recipe/rate", "{}", { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: "recipe service unreachable",
        reason: "recipe service did not respond; try again later",
      });
    });
  });

  describe("logging and the ceiling", () => {
    // The hash the Worker computes for a request with no CF-Connecting-IP, so a test can seed
    // rows that count against the same caller.
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

    it("writes only the route label and status to engine_log — no URL, body, or sub", async () => {
      upstreamStatus = 422;
      const token = await validToken();
      const env = baseEnv();
      const secretUrl = "https://private.example/my-grandmothers-recipe";
      await worker.fetch(post("/api/recipe/extract", JSON.stringify({ url: secretUrl }),
        { Authorization: `Bearer ${token}` }), env);

      const logged = rows(env.DB);
      expect(logged.length).toBe(1);
      expect(logged[0].path).toBe("/recipe/extract");
      expect(logged[0].status).toBe(422);
      expect(logged[0].ip_hash).toMatch(/^[0-9a-f]{24}$/);
      const everything = JSON.stringify(env.DB.calls) + JSON.stringify(logged);
      expect(everything).not.toContain(secretUrl);
      expect(everything).not.toContain("user_test_recipe");
    });

    it("429s at the ceiling, never calling upstream or adding a row", async () => {
      const token = await validToken();
      const env = baseEnv();
      await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(res.status).toBe(429);
      // recipeService.ts shows `reason` in its withheld state; `error` stays for parity.
      expect(await res.json()).toEqual({
        error: "too many requests — try again later",
        reason: `recipe limit reached (${RECIPE_PER_HOUR} per hour); try again later`,
      });
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(RECIPE_PER_HOUR);
    });

    describe("development ceiling (RECIPE_DEV_SUBS)", () => {
      // Josh, 2026-09-30: "Keep per-address". A listed, verified sub gets a higher ceiling on the
      // same IP-hash key; nothing else about the route changes.
      it("a listed sub gets RECIPE_PER_HOUR_DEV on the same IP-hash key", async () => {
        const token = await validToken();
        const env = baseEnv({ RECIPE_DEV_SUBS: "user_other, user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(200);
        const logged = rows(env.DB);
        expect(logged.length).toBe(RECIPE_PER_HOUR + 1);
        expect(logged.at(-1).ip_hash).toBe(await callerHash());
        expect(JSON.stringify(env.DB.calls) + JSON.stringify(logged)).not.toContain("user_test_recipe");
      });

      it("a listed sub still stops at RECIPE_PER_HOUR_DEV, with the raised figure in `reason`", async () => {
        const token = await validToken();
        const env = baseEnv({ RECIPE_DEV_SUBS: "user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR_DEV);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(429);
        expect((await res.json()).reason)
          .toBe(`recipe limit reached (${RECIPE_PER_HOUR_DEV} per hour); try again later`);
        expect(upstreamCalls.length).toBe(0);
      });

      it("RECIPE_DEV_SUBS unset: falls back to ASK_DEV_SUBS, one tester list for both ceilings", async () => {
        const token = await validToken();
        const env = baseEnv({ ASK_DEV_SUBS: "user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(200);
      });

      it("RECIPE_DEV_SUBS unset and ASK_DEV_SUBS not listing the caller: the fallback grants nothing", async () => {
        const token = await validToken();
        const env = baseEnv({ ASK_DEV_SUBS: "user_other" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(429);
      });

      for (const [label, subs] of [["set to another list", "user_other"], ["set to empty", ""], ["set to the sentinel", "none"]]) {
        it(`RECIPE_DEV_SUBS ${label}: it overrides ASK_DEV_SUBS for this route`, async () => {
          const token = await validToken();
          const env = baseEnv({ ASK_DEV_SUBS: "user_test_recipe", RECIPE_DEV_SUBS: subs });
          await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
          const res = await worker.fetch(
            post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
          expect(res.status).toBe(429);
        });
      }

      for (const [label, subs] of [["unset", undefined], ["empty", " , "], ["not listing the caller", "user_other"]]) {
        it(`RECIPE_DEV_SUBS ${label}: the public ceiling applies, same 429 body`, async () => {
          const token = await validToken();
          const env = baseEnv({ RECIPE_DEV_SUBS: subs });
          await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
          const res = await worker.fetch(
            post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
          expect(res.status).toBe(429);
          expect(await res.json()).toEqual({
            error: "too many requests — try again later",
            reason: `recipe limit reached (${RECIPE_PER_HOUR} per hour); try again later`,
          });
        });
      }
    });

    it("concurrent requests cannot overshoot the ceiling while earlier calls are in flight", async () => {
      // 28 used, 2 left. Ten requests arrive together and the upstream holds every call open until
      // all ten have been dispatched — the window in which a count-then-log-later check lets all
      // ten through.
      const token = await validToken();
      const env = baseEnv();
      await seed(env.DB, "/recipe/rate", 28);
      let release;
      const gate = new Promise(r => { release = r; });
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        upstreamCalls.push({ url });
        await gate;
        return new Response("{}", { status: 200 });
      }));
      const pending = Array.from({ length: 10 }, () => worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env));
      await new Promise(r => setTimeout(r, 50));
      release();
      const statuses = (await Promise.all(pending)).map(r => r.status).sort();
      expect(statuses.filter(s => s === 200).length).toBe(2);
      expect(statuses.filter(s => s === 429).length).toBe(8);
      expect(upstreamCalls.length).toBe(2);
      expect(rows(env.DB).length).toBe(30);
    });

    it("the ceiling check and the claim are ONE statement, issued before the upstream call", async () => {
      // node:sqlite runs synchronously, so the concurrency test above passes for a check-then-
      // insert pair too; atomicity in D1 rests on the claim being a single statement. Pin that.
      const token = await validToken();
      const env = baseEnv();
      let callsAtUpstream = null;
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        callsAtUpstream = env.DB.calls.map(c => c.sql);
        return new Response("{}", { status: 200 });
      }));
      await worker.fetch(post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(callsAtUpstream).toHaveLength(1);
      expect(callsAtUpstream[0]).toMatch(/^INSERT INTO engine_log .* SELECT .* WHERE \(SELECT COUNT\(\*\) FROM engine_log/s);
    });

    it("an attempt that ends in 502 still counts, with status 502", async () => {
      const token = await validToken();
      const env = baseEnv();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }));
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(res.status).toBe(502);
      expect(rows(env.DB)).toEqual([{ path: "/recipe/transcribe", ip_hash: await callerHash(), status: 502 }]);
    });

    it("a failed status write never discards the upstream's response", async () => {
      const token = await validToken();
      const env = baseEnv({ DB: makeSqliteDB({ failOn: /^UPDATE/ }) });
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(upstreamBody);
      // The claim stands, so the attempt still counts; only its status is missing.
      expect(rows(env.DB)).toEqual([{ path: "/recipe/transcribe", ip_hash: await callerHash(), status: null }]);
    });

    it("the two ceilings are independent: engine rows never count against recipe, nor recipe against engine", async () => {
      const token = await validToken();
      const env = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env.DB, "/version", 60);            // engine ceiling spent
      const recipe = await worker.fetch(
        post("/api/recipe/rate", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(recipe.status).toBe(200);

      const env2 = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env2.DB, "/recipe/rate", 30);       // recipe ceiling spent
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return new Response("{}", { status: 200 });
      }));
      const engine = await worker.fetch(new Request("https://worker.example/api/engine/version", {
        headers: { Authorization: `Bearer ${token}` },
      }), env2);
      expect(engine.status).toBe(200);
    });
  });

  describe("routing and CORS", () => {
    it("404s an unknown recipe route and a GET, never calling upstream", async () => {
      const token = await validToken();
      const r1 = await worker.fetch(post("/api/recipe/delete", "{}", { Authorization: `Bearer ${token}` }), baseEnv());
      const r2 = await worker.fetch(new Request("https://worker.example/api/recipe/extract", {
        headers: { Authorization: `Bearer ${token}` },
      }), baseEnv());
      expect(r1.status).toBe(404);
      expect(r2.status).toBe(404);
      expect(upstreamCalls.length).toBe(0);
    });

    it("a preflight from the app's web build is allowed to send Authorization", async () => {
      const res = await worker.fetch(new Request("https://worker.example/api/recipe/extract", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8081",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      }), baseEnv());
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    });

    it("adds the Worker's CORS headers on top of the upstream response", async () => {
      const token = await validToken();
      const res = await worker.fetch(post("/api/recipe/extract", "{}", {
        Authorization: `Bearer ${token}`, Origin: "http://localhost:8081",
      }), baseEnv());
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    });
  });
});
