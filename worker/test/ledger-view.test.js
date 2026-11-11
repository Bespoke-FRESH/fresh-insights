// POST /api/recipe/ledger-view (fresh-assistant-api docs/api/ledger_contract.md "Own recipes", PR #270): forwarded as the recipe routes are, with its own
// per-account ceiling, a 700 KB body cap (the contract's 600 KB maximum is never refused here) and a response of about 200 KB passed through. Same harness as plan.test.js.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  RECIPE_PER_HOUR, LEDGER_VIEW_PER_HOUR, LEDGER_VIEW_PER_HOUR_DEV, LEDGER_VIEW_BODY_BYTES, LEDGER_VIEW_UPSTREAM_TIMEOUT_MS,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ENGINE_UPSTREAM = "https://fresh-diet-engine.fly.dev";
const ASK_TOKEN = "svc-ask-token";
const SUB = "user_test_ledger";
const ROUTE = "/api/recipe/ledger-view", LABEL = "/recipe/ledger-view";
const BODY = JSON.stringify({ ledger_rows: { id: "live:0123456789abcdef", key: "k" }, composition: { x: 1 }, name: "Soup" });

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
  upstreamBody = JSON.stringify({ ideas: [], shortfall: 0 });
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

describe("/api/recipe/ledger-view", () => {
  it("is 401 without a bearer, with a wrong one and with an expired one, exactly as /api/recipe/rate is, and calls nothing upstream", async () => {
    const env = baseEnv();
    for (const route of [ROUTE, "/api/recipe/rate"]) {
      expect((await worker.fetch(post(route, BODY), env)).status).toBe(401);
      expect((await worker.fetch(post(route, BODY, { Authorization: "Bearer nope" }), env)).status).toBe(401);
      expect((await worker.fetch(post(route, BODY, await auth({ exp: Math.floor(Date.now() / 1000) - 60 })), env)).status).toBe(401);
    }
    const r = await (await worker.fetch(post(ROUTE, BODY), env)).json();
    const rate = await (await worker.fetch(post("/api/recipe/rate", BODY), env)).json();
    expect(r).toEqual(rate);
    expect(upstreamCalls.length).toBe(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("a GET is not this route", async () => {
    const res = await worker.fetch(new Request("https://worker.example" + ROUTE, { method: "GET", headers: await auth() }), baseEnv());
    expect(res.status).not.toBe(200);
    expect(upstreamCalls.length).toBe(0);
  });

  it("forwards to the same path with the service bearer and the verified sub in the body (a body-supplied account_id never reaches it), and logs its own label", async () => {
    const env = baseEnv();
    const res = await worker.fetch(post(ROUTE, JSON.stringify({ account_id: "user_victim", ...JSON.parse(BODY) }), await auth()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(upstreamBody));
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + ROUTE);
    expect(upstreamCalls[0].init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(upstreamCalls[0].init.headers.get("X-User-Token")).toBeNull();
    const sent = forwardedJson(upstreamCalls[0]);
    expect(sent.account_id).toBe(SUB);
    expect(sent.ledger_rows).toEqual(JSON.parse(BODY).ledger_rows);
    expect(sent.name).toBe("Soup");
    expect(rows(env.DB)).toEqual([{ path: LABEL, status: 200 }]);
    expect(upstreamCalls[0].init.signal).toBeDefined();
    expect(LEDGER_VIEW_UPSTREAM_TIMEOUT_MS).toBe(15000);
  });

  it("passes the upstream's status and body through unchanged (400, 422, 503, 404)", async () => {
    for (const [status, body] of [[400, { error: "bad_row", detail: "id" }], [422, { error: "layout_mismatch" }], [503, { error: "not_ready" }], [404, { error: "not found" }]]) {
      upstreamStatus = status; upstreamBody = JSON.stringify(body);
      const env = baseEnv();
      const res = await worker.fetch(post(ROUTE, BODY, await auth()), env);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(body);
      expect(rows(env.DB)).toEqual([{ path: LABEL, status }]);
    }
  });

  it("takes a 600 KB request (the contract's maximum) and passes a 200 KB response through whole", async () => {
    const pad = "x".repeat(600 * 1024 - 100);
    const big = JSON.stringify({ ledger_rows: { id: "live:0123456789abcdef", pad }, name: "Big" });
    expect(big.length).toBeGreaterThanOrEqual(600_000);
    upstreamBody = JSON.stringify({ register: "y".repeat(200 * 1024) });
    const res = await worker.fetch(post(ROUTE, big, await auth()), baseEnv());
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBe(upstreamBody.length);
    expect(forwardedJson(upstreamCalls[0]).ledger_rows.pad.length).toBe(pad.length);
  });

  it("refuses a body over the cap with a 413 before claiming a slot or forwarding", async () => {
    const env = baseEnv();
    const over = '{"ledger_rows":{"pad":"' + "x".repeat(LEDGER_VIEW_BODY_BYTES) + '"}}';
    const res = await worker.fetch(post(ROUTE, over, await auth()), env);
    expect(res.status).toBe(413);
    expect(upstreamCalls.length).toBe(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("an unreachable upstream is this hop's 502, logged as 502", async () => {
    const headers = await auth();
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }));
    const env = baseEnv();
    const res = await worker.fetch(post(ROUTE, BODY, headers), env);
    expect(res.status).toBe(502);
    expect(rows(env.DB)).toEqual([{ path: LABEL, status: 502 }]);
  });

  it("a body that is not a JSON object is this hop's 400 and nothing is forwarded", async () => {
    const res = await worker.fetch(post(ROUTE, "[1,2]", await auth()), baseEnv());
    expect(res.status).toBe(400);
    expect(upstreamCalls.length).toBe(0);
  });

  it("has its own per-account ceiling (120 an hour, 400 for a listed tester), counted per account with the address backstop", async () => {
    expect(LEDGER_VIEW_PER_HOUR).toBe(120);
    expect(LEDGER_VIEW_PER_HOUR_DEV).toBe(400);
    const env = baseEnv();
    await seed(env.DB, LABEL, LEDGER_VIEW_PER_HOUR);
    const res = await worker.fetch(post(ROUTE, BODY, await auth()), env);
    expect(res.status).toBe(429);
    expect((await res.json()).scope).toBe("account");
    expect(upstreamCalls.length).toBe(0);
    // another account on another address is not held by it
    const other = baseEnv();
    await seed(other.DB, LABEL, LEDGER_VIEW_PER_HOUR, { sub: "user_someone_else", ip: "otheraddress" });
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), other)).status).toBe(200);
    // a listed tester gets the raised figure
    const dev = baseEnv({ ASK_DEV_SUBS: SUB });
    await seed(dev.DB, LABEL, LEDGER_VIEW_PER_HOUR);
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), dev)).status).toBe(200);
  });

  it("does not count against the import budget, and imports do not count against it", async () => {
    const env = baseEnv();
    await seed(env.DB, LABEL, LEDGER_VIEW_PER_HOUR_DEV);
    await seed(env.DB, "/recipe/rate", RECIPE_PER_HOUR - 1);
    expect((await worker.fetch(post("/api/recipe/rate", '{"servings":1,"lines":[]}', await auth()), env)).status).toBe(200);
    const full = baseEnv();
    for (const p of ["/recipe/extract", "/recipe/rate", "/recipe/transcribe-video"]) await seed(full.DB, p, RECIPE_PER_HOUR);
    expect((await worker.fetch(post(ROUTE, BODY, await auth()), full)).status).toBe(200);
  });

  it("answers an OPTIONS preflight and does not forward a neighbouring path", async () => {
    const res = await worker.fetch(new Request("https://worker.example" + ROUTE, { method: "OPTIONS", headers: { Origin: "https://insights.freshfoodrecs.com", "Access-Control-Request-Method": "POST" } }), baseEnv());
    expect(res.status).toBeLessThan(300);
    for (const route of ["/api/recipe/ledger-views", "/api/recipe/ledger-view/x"]) {
      expect((await worker.fetch(post(route, "{}", await auth()), baseEnv())).status).toBe(404);
    }
  });
});
