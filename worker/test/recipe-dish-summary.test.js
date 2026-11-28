// POST /api/recipe/dish/summary (dish contract 1.4, fresh-assistant-api#387): forwarded exactly as /api/recipe/dish, over its OWN label and ceiling.
// Same harness as recipe-dish.test.js.
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
const ROUTE = "/api/recipe/dish/summary", LABEL = "/recipe/dish/summary";
const HASH = "a".repeat(64);
const BODY = JSON.stringify({ ids: [HASH, "gen:lemon-salmon-patties"], mine: ["b".repeat(64)] });

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

describe("/api/recipe/dish/summary", () => {
  it("is 401 without a valid bearer and calls nothing upstream", async () => {
    const env = baseEnv();
    expect((await worker.fetch(post(ROUTE, BODY), env)).status).toBe(401);
    expect((await worker.fetch(post(ROUTE, BODY, { Authorization: "Bearer nope" }), env)).status).toBe(401);
    expect(upstreamCalls.length).toBe(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("forwards to the same path with the service bearer, the verified sub and token, and logs its own label", async () => {
    const env = baseEnv();
    const headers = await auth();
    const res = await worker.fetch(post(ROUTE, BODY, { ...headers, "X-Account-Id": "user_victim", "X-User-Token": "forged" }), env);
    expect(res.status).toBe(200);
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + ROUTE);
    const h = upstreamCalls[0].init.headers;
    expect(h.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(h.get("X-Account-Id")).toBe(SUB);
    expect(h.get("X-User-Token")).toBe(headers.Authorization.slice("Bearer ".length));
    const sent = forwardedJson(upstreamCalls[0]);
    expect(sent.ids).toEqual([HASH, "gen:lemon-salmon-patties"]);
    expect(sent.mine).toEqual(["b".repeat(64)]);
    expect(rows(env.DB)).toEqual([{ path: LABEL, status: 200 }]);
  });

  it("has its own ceiling, not a share of /api/recipe/dish's", async () => {
    const env = baseEnv();
    await seed(env.DB, "/recipe/dish", RECIPE_DISH_PER_HOUR);
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), env)).status).toBe(200);
    const full = baseEnv();
    await seed(full.DB, LABEL, RECIPE_DISH_PER_HOUR);
    const res = await worker.fetch(post(ROUTE, BODY, await auth()), full);
    expect(res.status).toBe(429);
    expect(upstreamCalls.length).toBe(1);
  });
});
