// X-User-Token: the verified caller's own Clerk session token, forwarded to fresh-assistant-api on
// POST /api/ask and POST /api/recipe/write and on no other route (D-2026-10-29-1, fresh_app
// DECISION_LOG: the API reads that person's own synced rows during their own request, against the
// database's owner-only rules; no master key, nothing stored, no token or value logged).
// What must hold, and what each test below is a way of getting it wrong:
//   - the header carries the token the caller presented, byte for byte, after it verified
//   - an anonymous request, or one whose token fails verification, sends none
//   - a client-sent X-User-Token is never forwarded as the caller's own
//   - the two routes only: every other route that reaches the upstream carries no X-User-Token
//   - the token is never in a body, a response, an error body, a log row or a response header
//   - a redirect cannot carry it away (fetch strips Authorization cross-origin, not this header)
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB, makeMockDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ENGINE_UPSTREAM = "https://fresh-diet-engine.fly.dev";
const ASK_TOKEN = "svc-ask-token";
const SUB = "user_test_token";

let keyPair, kid, jwksDoc, calls, upstreamStatus, upstreamBody, upstreamHeaders, throwAt;

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "user-token-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  calls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ actions: [], reply: "ok", candidates: [], rating_tuple: { tuple_sha256: "ab".repeat(32) } });
  upstreamHeaders = { "Content-Type": "application/json" };
  throwAt = null;
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ASK_UPSTREAM) || url.startsWith(ENGINE_UPSTREAM)) {
      let body = null;
      if (init.body instanceof Uint8Array) body = new TextDecoder().decode(init.body);
      else if (typeof init.body === "string") body = init.body;
      calls.push({ url, init, headers: new Headers(init.headers || {}), body });
      if (throwAt && url.includes(throwAt)) throw new TypeError("network down");
      const nullBody = [204, 205, 304].includes(upstreamStatus);
      return new Response(nullBody ? null : upstreamBody, { status: upstreamStatus, headers: upstreamHeaders });
    }
    throw new Error("unexpected fetch in test: " + url);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com,http://localhost:8081",
    ASK_UPSTREAM, ASK_TOKEN,
    ENGINE_UPSTREAM, ENGINE_TOKEN: "svc-engine-token",
    CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: JWKS_URL,
    DB: makeSqliteDB(),
    ...overrides,
  };
}

async function token(claims = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signTestJWT(keyPair.privateKey, kid, {
    iss: ISSUER, sub: SUB, exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10, ...claims,
  });
}

const json = (route, body, headers = {}) => new Request("https://worker.example" + route, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const getReq = (route, headers = {}) => new Request("https://worker.example" + route, { headers });

describe("X-User-Token on POST /api/ask", () => {
  const ASK = { app: "fresh_app", q: "how is my diet" };

  it("carries the token the caller presented, after it verified, beside the service bearer", async () => {
    const t = await token();
    const res = await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${t}` }), baseEnv({ DB: makeMockDB() }));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ASK_UPSTREAM + "/ask");
    expect(calls[0].headers.get("X-User-Token")).toBe(t);
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
  });

  it("still sends account_id = the verified sub in the body, and the token nowhere in the body", async () => {
    const t = await token();
    await worker.fetch(json("/api/ask", { ...ASK, account_id: "user_2victim" }, { Authorization: `Bearer ${t}` }), baseEnv({ DB: makeMockDB() }));
    expect(JSON.parse(calls[0].body).account_id).toBe(SUB);
    expect(calls[0].body).not.toContain(t);
  });

  it("an anonymous request sends no X-User-Token, and never asks Clerk", async () => {
    await worker.fetch(json("/api/ask", ASK), baseEnv({ DB: makeMockDB() }));
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.has("X-User-Token")).toBe(false);
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
  });

  it("a client-sent X-User-Token is dropped on an anonymous request", async () => {
    await worker.fetch(json("/api/ask", ASK, { "X-User-Token": "forged.client.value" }), baseEnv({ DB: makeMockDB() }));
    expect(calls[0].headers.has("X-User-Token")).toBe(false);
  });

  it("a client-sent X-User-Token never replaces the verified bearer's: the upstream sees the bearer", async () => {
    const t = await token();
    await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${t}`, "X-User-Token": "forged.client.value" }), baseEnv({ DB: makeMockDB() }));
    expect(calls[0].headers.get("X-User-Token")).toBe(t);
    expect(JSON.stringify([...calls[0].headers])).not.toContain("forged.client.value");
  });

  it("a token that fails verification is a 401 and nothing, the token included, goes upstream", async () => {
    const other = await generateTestKeyPair();
    const nowSec = Math.floor(Date.now() / 1000);
    const forged = await signTestJWT(other.privateKey, kid, { iss: ISSUER, sub: "user_2victim", exp: nowSec + 3600, iat: nowSec - 10 });
    const expired = await token({ exp: nowSec - 60 });
    for (const bearer of [forged, expired, "not.a.jwt"]) {
      const res = await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${bearer}` }), baseEnv({ DB: makeMockDB() }));
      expect(res.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("a verified sub that is not fit to forward as account_id still sends the token (it is the caller's own)", async () => {
    const t = await token({ sub: "user with space" });
    await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${t}` }), baseEnv({ DB: makeMockDB() }));
    expect(calls[0].headers.get("X-User-Token")).toBe(t);
    expect("account_id" in JSON.parse(calls[0].body)).toBe(false);
  });

  it("fails on a redirect rather than following it with the token", async () => {
    await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${await token()}` }), baseEnv({ DB: makeMockDB() }));
    expect(calls[0].init.redirect).toBe("error");
  });

  it("is not in the response, its headers, an upstream-failure body or the ask_log row", async () => {
    const t = await token();
    const db = makeMockDB();
    const ok = await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${t}`, Origin: "http://localhost:8081" }), baseEnv({ DB: db }));
    expect(await ok.text()).not.toContain(t);
    expect(JSON.stringify([...ok.headers])).not.toContain(t);
    expect(JSON.stringify(db.calls)).not.toContain(t);
    expect(JSON.stringify(db.calls)).not.toContain(SUB);

    upstreamStatus = 500;
    upstreamBody = JSON.stringify({ error: "boom", echo: "upstream says nothing about tokens" });
    const failed = await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${t}` }), baseEnv({ DB: makeMockDB() }));
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(t);

    throwAt = "/ask";
    const unreachable = await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${t}` }), baseEnv({ DB: makeMockDB() }));
    expect(unreachable.status).toBe(502);
    expect(await unreachable.text()).not.toContain(t);
  });

  it("a Clerk-unconfigured server answers 503 and sends nothing, the token included", async () => {
    const res = await worker.fetch(json("/api/ask", ASK, { Authorization: `Bearer ${await token()}` }),
      baseEnv({ DB: makeMockDB(), CLERK_ISSUER: undefined }));
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("X-User-Token on POST /api/recipe/write", () => {
  const WRITE = { request: "a quick weeknight chickpea curry", context: { servings: 2 } };

  it("carries the token the caller presented, beside the service bearer, and sets redirect to error", async () => {
    const t = await token();
    const res = await worker.fetch(json("/api/recipe/write", WRITE, { Authorization: `Bearer ${t}` }), baseEnv());
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ASK_UPSTREAM + "/api/recipe/write");
    expect(calls[0].headers.get("X-User-Token")).toBe(t);
    expect(calls[0].headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(calls[0].init.redirect).toBe("error");
  });

  it("keeps account_id = the verified sub in the body, and the token nowhere in the body", async () => {
    const t = await token();
    await worker.fetch(json("/api/recipe/write", { ...WRITE, account_id: "user_2victim" }, { Authorization: `Bearer ${t}` }), baseEnv());
    expect(JSON.parse(calls[0].body).account_id).toBe(SUB);
    expect(calls[0].body).not.toContain(t);
  });

  it("a client-sent X-User-Token never replaces the verified bearer's", async () => {
    const t = await token();
    await worker.fetch(json("/api/recipe/write", WRITE, { Authorization: `Bearer ${t}`, "X-User-Token": "forged.client.value" }), baseEnv());
    expect(calls[0].headers.get("X-User-Token")).toBe(t);
    expect(JSON.stringify([...calls[0].headers])).not.toContain("forged.client.value");
  });

  it("an anonymous or unverifiable request is a 401 and nothing goes upstream", async () => {
    for (const headers of [{}, { Authorization: "Bearer not.a.jwt" }, { "X-User-Token": "forged.client.value" }]) {
      const res = await worker.fetch(json("/api/recipe/write", WRITE, headers), baseEnv());
      expect(res.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });

  it("is not in the response, its headers, the engine_log row or an upstream-failure body", async () => {
    const t = await token();
    const env = baseEnv();
    const ok = await worker.fetch(json("/api/recipe/write", WRITE, { Authorization: `Bearer ${t}`, Origin: "http://localhost:8081" }), env);
    expect(await ok.text()).not.toContain(t);
    expect(JSON.stringify([...ok.headers])).not.toContain(t);
    expect(JSON.stringify(env.DB.sqlite.prepare("SELECT * FROM engine_log").all())).not.toContain(t);

    throwAt = "/api/recipe/write";
    const unreachable = await worker.fetch(json("/api/recipe/write", WRITE, { Authorization: `Bearer ${t}` }), baseEnv());
    expect(unreachable.status).toBe(502);
    expect(await unreachable.text()).not.toContain(t);
    throwAt = null;

    upstreamStatus = 400;
    upstreamBody = JSON.stringify({ error: "unknown field" });
    const bad = await worker.fetch(json("/api/recipe/write", WRITE, { Authorization: `Bearer ${t}` }), baseEnv());
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain(t);
  });

  it("a photo body carries it too, and the photo bytes are unchanged", async () => {
    const t = await token();
    const photo = { request: "what I cooked", image: { media_type: "image/jpeg", data: "A".repeat(100_000) } };
    await worker.fetch(json("/api/recipe/write", photo, { Authorization: `Bearer ${t}` }), baseEnv());
    expect(calls[0].headers.get("X-User-Token")).toBe(t);
    expect(JSON.parse(calls[0].body).image.data).toBe(photo.image.data);
    expect(calls[0].body).not.toContain(t);
  });
});

describe("no other route carries X-User-Token", () => {
  // Every other route that reaches an upstream, called signed in with a client-sent X-User-Token too.
  const POSTS = [
    ["/api/recipe/extract", { url: "https://example.com/r" }],
    ["/api/recipe/extract", { conversation: "User: a recipe\nAssistant: ..." }],
    ["/api/recipe/transcribe", { images: [{ data: "QUJD", media_type: "image/jpeg" }] }],
    ["/api/recipe/transcribe-video", { url: "https://www.tiktok.com/@c/video/1" }],
    ["/api/recipe/rate", { servings: 1, lines: [{ text: "1 cup rice" }], request_id: "r1" }],
    ["/api/recipe/image", { title: "Soup", ingredients: ["1 cup stock"] }],
    ["/api/recipe/archive-video", { url: "https://www.tiktok.com/@c/video/1" }],
    ["/api/recipe/suggest-swaps", { servings: 1, lines: [{ text: "1 cup rice" }] }],
    ["/api/recipe/photo", { url: "https://www.tiktok.com/@c/video/1" }],
  ];
  for (const [route, body] of POSTS) {
    it(`POST ${route} (${Object.keys(body)[0]}) sends no X-User-Token`, async () => {
      const t = await token();
      const res = await worker.fetch(json(route, body, { Authorization: `Bearer ${t}`, "X-User-Token": "forged.client.value" }), baseEnv());
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.has("X-User-Token")).toBe(false);
      expect(JSON.stringify([...calls[0].headers])).not.toContain(t);
      expect(calls[0].body ?? "").not.toContain(t);
      expect(calls[0].init.redirect).toBeUndefined();
    });
  }

  const GETS = [
    "/api/food/fndds/51101000/attributes",
    "/api/record/fndds:22311510",
    "/api/rating-tuple",
    "/api/recipe/rate/progress/import-1",
    "/api/engine/version",
  ];
  for (const route of GETS) {
    it(`GET ${route} sends no X-User-Token`, async () => {
      const t = await token();
      const res = await worker.fetch(getReq(route, { Authorization: `Bearer ${t}`, "X-User-Token": "forged.client.value" }), baseEnv());
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.has("X-User-Token")).toBe(false);
      expect(JSON.stringify([...calls[0].headers])).not.toContain(t);
    });
  }

  it("POST /api/retrieve sends no X-User-Token", async () => {
    const t = await token();
    const res = await worker.fetch(json("/api/retrieve", { q: "ultra-processed foods" }, { Authorization: `Bearer ${t}` }),
      baseEnv({ RETRIEVE_UPSTREAM: ASK_UPSTREAM }));
    for (const c of calls) expect(c.headers.has("X-User-Token")).toBe(false);
    expect(res.status).toBeLessThan(500);
  });
});

describe("the forwarded header only ever exists on the two routes in the source", () => {
  it("X-User-Token appears in index.js only in the /api/ask and /api/recipe/write code", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
    const uses = src.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /["'`]X-User-Token["'`]/.test(l));
    expect(uses.map(([, l]) => l.trim())).toEqual([
      expect.stringContaining('"X-User-Token": userToken'),
      expect.stringContaining('"X-User-Token": m[1]'),
    ]);
  });
});
