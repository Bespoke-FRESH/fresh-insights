import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeMockDB, readAllBytes } from "./helpers.js";

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
    DB: makeMockDB(),
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
        expect(await res.json()).toEqual({ error: "unauthorized" });
        expect(upstreamCalls.length).toBe(0);
      });
    }

    it("401s on an expired JWT", async () => {
      const token = await validToken({ exp: Math.floor(Date.now() / 1000) - 60 });
      const res = await worker.fetch(
        post("/api/recipe/extract", "{}", { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
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
    it("503s when ASK_UPSTREAM is unset, before checking the JWT", async () => {
      const res = await worker.fetch(post("/api/recipe/extract", "{}"), baseEnv({ ASK_UPSTREAM: undefined }));
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
      expect(await res.json()).toEqual({ error: "request body too large" });
      expect(upstreamCalls.length).toBe(0);
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
      expect(await res.json()).toEqual({ error: "recipe service unreachable" });
    });
  });

  describe("logging", () => {
    it("writes only the route label and status to engine_log — no URL, body, or sub", async () => {
      upstreamStatus = 422;
      const token = await validToken();
      const env = baseEnv();
      const secretUrl = "https://private.example/my-grandmothers-recipe";
      await worker.fetch(post("/api/recipe/extract", JSON.stringify({ url: secretUrl }),
        { Authorization: `Bearer ${token}` }), env);

      const inserts = env.DB.calls.filter(c => c.sql.startsWith("INSERT"));
      expect(inserts.length).toBe(1);
      expect(inserts[0].sql).toBe("INSERT INTO engine_log (path, ip_hash, status) VALUES (?1, ?2, ?3)");
      const [label, ipHash, status] = inserts[0].args;
      expect(label).toBe("/recipe/extract");
      expect(status).toBe(422);
      const logged = JSON.stringify(env.DB.calls);
      expect(logged).not.toContain(secretUrl);
      expect(logged).not.toContain("user_test_recipe");
      expect(ipHash).toMatch(/^[0-9a-f]{24}$/);
    });

    it("rate-limits on recipe rows only, and 429s at the ceiling", async () => {
      const token = await validToken();
      const env = baseEnv({ DB: makeMockDB({ countAll: 30 }) });
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(res.status).toBe(429);
      // recipeService.ts shows `reason` in its withheld state; `error` stays for parity.
      expect(await res.json()).toEqual({
        error: "too many requests — try again later",
        reason: "recipe limit reached (30 per hour); try again later",
      });
      expect(upstreamCalls.length).toBe(0);
      expect(env.DB.calls[0].sql).toContain("path LIKE '/recipe/%'");
    });

    it("the engine ceiling excludes recipe rows", async () => {
      const env = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      const token = await validToken();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return new Response("{}", { status: 200 });
      }));
      await worker.fetch(new Request("https://worker.example/api/engine/version", {
        headers: { Authorization: `Bearer ${token}` },
      }), env);
      expect(env.DB.calls[0].sql).toContain("path NOT LIKE '/recipe/%'");
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
