import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeMockDB, readAllBytes } from "./helpers.js";

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

// `index.js` keeps its Clerk JWKS cache in a module-level singleton (by design — it's meant to
// survive across requests within a warm isolate) and that cache now throttles refetching on an
// unknown kid. Generating the signing key ONCE for the whole file (rather than per test) keeps
// every test using the same kid the cache already knows, so none of them accidentally exercise
// (or get blocked by) that throttle — the throttle itself is covered in clerkAuth.test.js.
let keyPair, kid, jwksDoc, engineCalls, engineStatus, engineBody;

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "engine-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(async () => {
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

  it("forwards a JSON POST body and query string to the engine, streamed rather than buffered", async () => {
    const token = await validToken();
    const payload = JSON.stringify({ meal: "oatmeal" });
    const req = new Request("https://worker.example/api/engine/score?dry_run=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: payload,
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(200);
    expect(engineCalls.length).toBe(1);
    const call = engineCalls[0];
    expect(call.url).toBe(ENGINE_UPSTREAM + "/score?dry_run=1");
    expect(call.init.method).toBe("POST");
    // The body is the inbound ReadableStream passed straight through, not a re-encoded
    // string — this is the fix: no `await req.text()` / decode-then-re-encode round trip.
    expect(call.init.body).toBeInstanceOf(ReadableStream);
    expect(call.init.duplex).toBe("half");
    const forwarded = await readAllBytes(call.init.body);
    expect(new TextDecoder().decode(forwarded)).toBe(payload);
    expect(call.init.headers.get("Content-Type")).toBe("application/json");
  });

  it("forwards the exact inbound bytes upstream, not a UTF-8 decode/re-encode of them " +
     "(regression: a CP1252 byte and a UTF-8 byte sequence must both survive untouched)", async () => {
    const token = await validToken();
    // "caf" + CP1252 0xE9 ("é" in CP1252, NOT valid UTF-8 on its own) + a UTF-8 em dash
    // (—, U+2014 = 0xE2 0x80 0x94) + " done". A decode-as-UTF-8-then-re-encode round trip
    // (the bug: `await req.text()` then `body: raw`) mangles the CP1252 byte (replaced with
    // U+FFFD and re-encoded as 3 different bytes), so this is the test that would have
    // caught it.
    const bytes = new Uint8Array([
      0x63, 0x61, 0x66, 0xe9,
      0x20,
      0xe2, 0x80, 0x94,
      0x20, 0x64, 0x6f, 0x6e, 0x65,
    ]);
    const req = new Request("https://worker.example/api/engine/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/csv",
        "Content-Length": String(bytes.byteLength),
      },
      body: bytes,
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(200);
    expect(engineCalls.length).toBe(1);
    const forwarded = await readAllBytes(engineCalls[0].init.body);
    expect(Array.from(forwarded)).toEqual(Array.from(bytes)); // byte-for-byte, not decoded text
    expect(engineCalls[0].init.headers.get("Content-Type")).toBe("text/csv");
    expect(engineCalls[0].init.headers.get("Content-Length")).toBe(String(bytes.byteLength));
  });

  it("forwards a multipart body unchanged", async () => {
    const token = await validToken();
    const boundary = "----freshTestBoundary123";
    const parts = [
      `--${boundary}\r\n`,
      `Content-Disposition: form-data; name="file"; filename="intake.csv"\r\n`,
      `Content-Type: text/csv\r\n\r\n`,
      "date,food,calories\r\n2026-09-01,oatmeal,150\r\n",
      `\r\n--${boundary}--\r\n`,
    ].join("");
    const bytes = new TextEncoder().encode(parts);
    const req = new Request("https://worker.example/api/engine/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": String(bytes.byteLength),
      },
      body: bytes,
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(200);
    expect(engineCalls.length).toBe(1);
    const forwarded = await readAllBytes(engineCalls[0].init.body);
    expect(new TextDecoder().decode(forwarded)).toBe(parts);
    expect(engineCalls[0].init.headers.get("Content-Type")).toBe(`multipart/form-data; boundary=${boundary}`);
  });

  it("refuses a body over the size cap with the envelope shape, never reaching the upstream", async () => {
    const token = await validToken();
    const req = new Request("https://worker.example/api/engine/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/csv",
        "Content-Length": String(10 * 1024 * 1024 + 1), // one byte over ENGINE_MAX_BODY_BYTES
      },
      body: new Uint8Array(1), // the declared Content-Length is what trips the cap
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "request body too large" });
    expect(engineCalls.length).toBe(0);
  });

  it("allows a body exactly at the size cap", async () => {
    const token = await validToken();
    const req = new Request("https://worker.example/api/engine/upload", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/csv",
        "Content-Length": String(10 * 1024 * 1024), // exactly ENGINE_MAX_BODY_BYTES
      },
      body: new Uint8Array(1),
    });
    const res = await worker.fetch(req, baseEnv());

    expect(res.status).toBe(200);
    expect(engineCalls.length).toBe(1);
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

  // engine_log's schema comment promises this table is never for who called it. These assert
  // the row records a known-route TEMPLATE or the constant ROUTE_UNKNOWN — see routeLabelFor in
  // src/index.js — never the raw or partially-redacted request path. The old segment-SHAPE
  // heuristic this replaced could not tell a purely alphabetic id from a route word; the
  // "alphabetic id" case below is exactly the one it failed and this must now pass.
  describe("engine_log path redaction", () => {
    function loggedPath(env) {
      const insert = env.DB.calls.find(c => c.sql.includes("INSERT INTO engine_log"));
      expect(insert).toBeTruthy();
      // INSERT INTO engine_log (path, ip_hash, status) VALUES (?1, ?2, ?3)
      return insert.args[0];
    }

    async function loggedPathFor(suffix) {
      const token = await validToken();
      const req = new Request(`https://worker.example/api/engine${suffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const env = baseEnv();
      await worker.fetch(req, env);
      return loggedPath(env);
    }

    // Every route template fresh_diet's docs/api/CONTRACT.md currently documents for the
    // engine, exercised with a concrete id where the template has one. Each must log its own
    // template string verbatim.
    const KNOWN_ROUTES = [
      ["/version", "/version"],
      ["/healthz", "/healthz"],
      ["/intake/cronometer", "/intake/cronometer"],
      ["/intake/190283/score", "/intake/:id/score"],
      ["/intake/190283/signature", "/intake/:id/signature"],
      ["/intake/190283/framework", "/intake/:id/framework"],
      ["/intake/190283/projection", "/intake/:id/projection"],
      ["/intake/190283/recommendations", "/intake/:id/recommendations"],
      ["/intake/190283/recipes", "/intake/:id/recipes"],
      ["/intake/190283/match", "/intake/:id/match"],
      ["/day/2026-09-12", "/day/:id"],
      ["/days", "/days"],
    ];

    for (const [suffix, template] of KNOWN_ROUTES) {
      it(`logs the template for ${suffix}`, async () => {
        expect(await loggedPathFor(suffix)).toBe(template);
      });
    }

    it("redacts a purely alphabetic id in a known template position to :id — the case the " +
       "old shape heuristic failed, since a word-slug id has no shape that marks it as an id",
       async () => {
        expect(await loggedPathFor("/intake/wordslug/score")).toBe("/intake/:id/score");
      });

    it("redacts a uuid id in a known template position to :id", async () => {
      const uuid = "9f8e7d6c-5b4a-4210-8dcb-a98765432100";
      expect(await loggedPathFor(`/intake/${uuid}/score`)).toBe("/intake/:id/score");
    });

    it("logs the constant for a route matching no known template", async () => {
      expect(await loggedPathFor("/reports/9f8e7d6c5b4a3210fedcba9876543210/export"))
        .toBe("/unknown");
    });

    it("logs the constant — not the id — for an unknown route that contains a plausible id",
       async () => {
        // A route family that does not exist anywhere in this file or the engine today —
        // stands in for "the engine ships a new route nobody added to the table yet."
        expect(await loggedPathFor("/wearables/sync/device-7f3a9c2e1b8d/status"))
          .toBe("/unknown");
      });

    it("logs the constant, not a partial match, when only the segment count differs from a " +
       "known template", async () => {
        expect(await loggedPathFor("/intake/190283/score/extra")).toBe("/unknown");
        expect(await loggedPathFor("/intake/190283")).toBe("/unknown");
      });
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
