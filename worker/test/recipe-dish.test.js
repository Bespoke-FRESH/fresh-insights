// POST /api/recipe/dish (fresh-assistant-api docs/api/recipe_dish_contract.md): forwarded as the signed-in recipe routes are, with X-Account-Id and X-User-Token from the
// verified token, its own per-account ceiling and a 15 s upstream timeout. Same harness as ledger-view.test.js.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  RECIPE_PER_HOUR, RECIPE_DISH_PER_HOUR, RECIPE_DISH_PER_HOUR_DEV, RECIPE_DISH_UPSTREAM_TIMEOUT_MS, LEDGER_VIEW_PER_HOUR,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ENGINE_UPSTREAM = "https://fresh-diet-engine.fly.dev";
const ASK_TOKEN = "svc-ask-token";
const SUB = "user_test_dish";
const ROUTE = "/api/recipe/dish", LABEL = "/recipe/dish";
const HASH = "a".repeat(64);
const BODY = JSON.stringify({ corpus_hash: HASH, mine: ["b".repeat(64)] });

function baseEnv(overrides = {}) {
  return { ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com", ASK_UPSTREAM, ASK_TOKEN, ENGINE_UPSTREAM, ENGINE_TOKEN: "engine-token", CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: JWKS_URL, DB: makeSqliteDB(), ...overrides };
}

let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody;
beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "plan-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});
beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ status: "ready", corpus_hash: HASH, dish_name: "lemon garlic shrimp", menu_line: null, about: null, versions: [], versions_total: 0 });
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      return new Response(upstreamBody, { status: upstreamStatus, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ENGINE_UPSTREAM)) return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    throw new Error("unexpected fetch in test: " + url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function validToken(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  return signTestJWT(keyPair.privateKey, kid, { iss: ISSUER, sub: SUB, exp: now + 3600, nbf: now - 10, iat: now - 10, ...claims });
}
const post = (route, body, headers = {}) => {
  const bytes = new TextEncoder().encode(body);
  return new Request("https://worker.example" + route, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(bytes.byteLength), ...headers }, body: bytes });
};
const auth = async (claims) => ({ Authorization: `Bearer ${await validToken(claims)}` });
const forwardedJson = call => JSON.parse(typeof call.init.body === "string" ? call.init.body : new TextDecoder().decode(call.init.body));
const rows = db => db.sqlite.prepare("SELECT path, status FROM engine_log ORDER BY id").all();
async function hashOf(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}
const day = () => new Date().toISOString().slice(0, 10);
const acctOf = sub => hashOf("acct:" + sub + "|" + day());
const callerIp = () => hashOf("0.0.0.0|" + day());
// n rows for a label, as the Worker writes them: the address hash and the account's daily hash
async function seed(db, path, n, { sub = SUB, ip, subs = 0 } = {}) {
  const ins = db.sqlite.prepare("INSERT INTO engine_log (path, ip_hash, status, acct_hash, created_at) VALUES (?, ?, 200, ?, datetime('now'))");
  const address = ip ?? await callerIp();
  const keys = subs ? await Promise.all(Array.from({ length: subs }, (_, i) => acctOf("user_other_" + i))) : [await acctOf(sub)];
  for (let i = 0; i < n; i++) ins.run(path, address, keys[i % keys.length]);
}

describe("/api/recipe/dish", () => {
  it("is 401 without a bearer, with a wrong one and with an expired one, calls nothing upstream and logs nothing", async () => {
    const env = baseEnv();
    expect((await worker.fetch(post(ROUTE, BODY), env)).status).toBe(401);
    expect((await worker.fetch(post(ROUTE, BODY, { Authorization: "Bearer nope" }), env)).status).toBe(401);
    expect((await worker.fetch(post(ROUTE, BODY, await auth({ exp: Math.floor(Date.now() / 1000) - 60 })), env)).status).toBe(401);
    expect(upstreamCalls.length).toBe(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("forwards to the same path with the service bearer, the verified sub as X-Account-Id (a forged one ignored) and the verified token as X-User-Token", async () => {
    const env = baseEnv();
    const headers = await auth();
    const res = await worker.fetch(post(ROUTE, BODY, { ...headers, "X-Account-Id": "user_victim", "X-User-Token": "forged", Cookie: "c=1" }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(upstreamBody));
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + ROUTE);
    const h = upstreamCalls[0].init.headers;
    expect(h.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(h.get("X-Account-Id")).toBe(SUB);
    expect(h.get("X-User-Token")).toBe(headers.Authorization.slice("Bearer ".length));
    expect(h.get("Cookie")).toBeNull();
    const sent = forwardedJson(upstreamCalls[0]);
    expect(sent.corpus_hash).toBe(HASH);
    expect(sent.mine).toEqual(["b".repeat(64)]);
    expect(sent.account_id).toBe(SUB);
    expect(rows(env.DB)).toEqual([{ path: LABEL, status: 200 }]);
    expect(upstreamCalls[0].init.signal).toBeDefined();
    expect(RECIPE_DISH_UPSTREAM_TIMEOUT_MS).toBeGreaterThanOrEqual(15000);
  });

  it("passes the upstream's status and body through unchanged (pending, 400, 404, 503)", async () => {
    for (const [status, body] of [[200, { status: "pending", corpus_hash: HASH, retry_after_ms: 2000 }], [400, { code: "bad_request" }], [404, { code: "not_found" }], [503, { code: "not_ready" }]]) {
      upstreamStatus = status; upstreamBody = JSON.stringify(body);
      const env = baseEnv();
      const res = await worker.fetch(post(ROUTE, BODY, await auth()), env);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
      expect(rows(env.DB)).toEqual([{ path: LABEL, status }]);
    }
  });

  it("has its own per-account ceiling (600 an hour, 2000 for a listed tester), counted per account with the address backstop", async () => {
    expect(RECIPE_DISH_PER_HOUR).toBe(600);
    expect(RECIPE_DISH_PER_HOUR_DEV).toBe(2000);
    const env = baseEnv();
    await seed(env.DB, LABEL, RECIPE_DISH_PER_HOUR);
    const res = await worker.fetch(post(ROUTE, BODY, await auth()), env);
    expect(res.status).toBe(429);
    const j = await res.json();
    expect(j.scope).toBe("account");
    expect(j.reason).toContain("recipe details");
    expect(upstreamCalls.length).toBe(0);
    const other = baseEnv();
    await seed(other.DB, LABEL, RECIPE_DISH_PER_HOUR, { sub: "user_someone_else", ip: "otheraddress" });
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), other)).status).toBe(200);
    const dev = baseEnv({ ASK_DEV_SUBS: SUB });
    await seed(dev.DB, LABEL, RECIPE_DISH_PER_HOUR);
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), dev)).status).toBe(200);
  });

  it("does not count against the import budget, and imports do not count against it", async () => {
    const env = baseEnv();
    await seed(env.DB, LABEL, RECIPE_DISH_PER_HOUR_DEV);
    await seed(env.DB, "/recipe/rate", RECIPE_PER_HOUR - 1);
    expect((await worker.fetch(post("/api/recipe/rate", '{"servings":1,"lines":[]}', await auth()), env)).status).toBe(200);
    const full = baseEnv();
    for (const p of ["/recipe/extract", "/recipe/rate", "/recipe/transcribe-video"]) await seed(full.DB, p, RECIPE_PER_HOUR);
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), full)).status).toBe(200);
  });

  it("other routes are unaffected: ledger-view still forwards without X-Account-Id or X-User-Token and keeps its own count", async () => {
    const env = baseEnv();
    await seed(env.DB, LABEL, RECIPE_DISH_PER_HOUR_DEV);
    const res = await worker.fetch(post("/api/recipe/ledger-view", JSON.stringify({ ledger_rows: { id: "live:0123456789abcdef" }, name: "Soup" }), await auth()), env);
    expect(res.status).toBe(200);
    const h = upstreamCalls[0].init.headers;
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + "/api/recipe/ledger-view");
    expect(h.get("X-Account-Id")).toBeNull();
    expect(h.get("X-User-Token")).toBeNull();
    const full = baseEnv();
    await seed(full.DB, "/recipe/ledger-view", LEDGER_VIEW_PER_HOUR);
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), full)).status).toBe(200);
  });

  it("answers an OPTIONS preflight and does not forward a neighbouring path or a GET", async () => {
    const res = await worker.fetch(new Request("https://worker.example" + ROUTE, { method: "OPTIONS", headers: { Origin: "https://insights.freshfoodrecs.com", "Access-Control-Request-Method": "POST" } }), baseEnv());
    expect(res.status).toBeLessThan(300);
    for (const route of ["/api/recipe/dishes", "/api/recipe/dish/x"]) {
      expect((await worker.fetch(post(route, "{}", await auth()), baseEnv())).status).toBe(404);
    }
    const get = await worker.fetch(new Request("https://worker.example" + ROUTE, { method: "GET", headers: await auth() }), baseEnv());
    expect(get.status).not.toBe(200);
    expect(upstreamCalls.length).toBe(0);
  });
});
