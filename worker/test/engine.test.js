import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeMockDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ENGINE_UPSTREAM = "https://fresh-diet-engine.fly.dev";

function baseEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com",
    ENGINE_UPSTREAM,
    ENGINE_TOKEN: "svc-secret-token",
    CLERK_ISSUER: ISSUER,
    CLERK_JWKS_URL: JWKS_URL,
    DB: makeMockDB(),
    ...overrides,
  };
}

let keyPair, kid, jwksDoc, engineCalls, engineStatus, engineBody;

beforeEach(async () => {
  keyPair = await generateTestKeyPair();
  kid = `kid-${Math.random().toString(36).slice(2)}`; // unique per test forces a fresh JWKS lookup
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
  engineCalls = [];
  engineStatus = 200;
  engineBody = { chat_tool_envelope: true, version: "0.1.0" };

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
      if (url.startsWith(ENGINE_UPSTREAM)) {
        engineCalls.push({ url, init });
        return new Response(JSON.stringify(engineBody), {
          status: engineStatus,
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
    sub: "user_test_1",
    exp: nowSec + 3600,
    nbf: nowSec - 10,
    iat: nowSec - 10,
    ...claimOverrides,
  });
}

describe("/api/engine/* proxy", () => {
  it("401s with no Authorization header, never calling the engine", async () => {
    const req = new Request("https://worker.example/api/engine/version");
    const res = await worker.fetch(req, baseEnv());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(engineCalls.length).toBe(0);
  });

  it("401s on a garbage bearer token, never calling the engine", async () => {
    const req = new Request("https://worker.example/api/engine/version", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    const res = await worker.fetch(req, baseEnv());
    expect(res.status).toBe(401);
    expect(engineCalls.length).toBe(0);
  });

  it("401s on an expired token", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const token = await validToken({ exp: nowSec - 60 });
    const req = new Request("https://worker.example/api/engine/version", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await worker.fetch(req, baseEnv());
    expect(res.status).toBe(401);
    expect(engineCalls.length).toBe(0);
  });

  it("401s on the wrong issuer", async () => {
    const token = await validToken({ iss: "https://not-clerk.example" });
    const req = new Request("https://worker.example/api/engine/version", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await worker.fetch(req, baseEnv());
    expect(res.status).toBe(401);
    expect(engineCalls.length).toBe(0);
  });

  it("503s when ENGINE_UPSTREAM is unset, before even checking the JWT", async () => {
    const req = new Request("https://worker.example/api/engine/version"); // no Authorization at all
    const res = await worker.fetch(req, baseEnv({ ENGINE_UPSTREAM: undefined }));
    expect(res.status).toBe(503);
    expect(engineCalls.length).toBe(0);
  });

  it("503s when ENGINE_TOKEN is unset", async () => {
    const req = new Request("https://worker.example/api/engine/version");
    const res = await worker.fetch(req, baseEnv({ ENGINE_TOKEN: undefined }));
    expect(res.status).toBe(503);
  });

  it("proxies GET /api/engine/version to engine GET /version with the service token and X-Fresh-User, and passes the response through unchanged", async () => {
    const token = await validToken();
    const req = new Request("https://worker.example/api/engine/version", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Fresh-User": "smuggled-user-id", // an inbound caller trying to spoof this header
      },
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(engineBody);

    expect(engineCalls.length).toBe(1);
    const call = engineCalls[0];
    expect(call.url).toBe(ENGINE_UPSTREAM + "/version");
    expect(call.init.method).toBe("GET");

    const headers = call.init.headers;
    expect(headers.get("Authorization")).toBe("Bearer svc-secret-token");
    expect(headers.get("X-Fresh-User")).toBe("user_test_1"); // verified sub, not the smuggled one
  });

  it("forwards a JSON POST body and query string to the engine", async () => {
    const token = await validToken();
    const req = new Request("https://worker.example/api/engine/score?dry_run=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ meal: "oatmeal" }),
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(200);
    expect(engineCalls.length).toBe(1);
    const call = engineCalls[0];
    expect(call.url).toBe(ENGINE_UPSTREAM + "/score?dry_run=1");
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBe(JSON.stringify({ meal: "oatmeal" }));
    expect(call.init.headers.get("Content-Type")).toBe("application/json");
  });

  it("429s once the per-IP ceiling is hit, without calling the engine", async () => {
    const token = await validToken();
    const req = new Request("https://worker.example/api/engine/version", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const env = baseEnv({ DB: makeMockDB({ countAll: 60 }) }); // at ENGINE_PER_HOUR
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(429);
    expect(engineCalls.length).toBe(0);
  });

  it("502s when the engine is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) {
          return new Response(JSON.stringify(jwksDoc), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new TypeError("network down");
      })
    );
    const token = await validToken();
    const req = new Request("https://worker.example/api/engine/version", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const res = await worker.fetch(req, baseEnv());
    expect(res.status).toBe(502);
  });
});
