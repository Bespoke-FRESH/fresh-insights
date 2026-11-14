// POST /api/recipe/suggest-swaps/stored and /stored/batch (fresh-assistant-api#296, recipe_swaps_contract.md section 12): read-only lookups of a held
// healthier answer, forwarded as the recipe routes are, each with a ceiling of its OWN that neither spends nor is spent by suggest-swaps or the import count.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  RECIPE_PER_HOUR, RECIPE_SWAPS_PER_HOUR, SWAPS_STORED_PER_HOUR, SWAPS_STORED_PER_HOUR_DEV, SWAPS_STORED_BODY_BYTES,
  SWAPS_STORED_BATCH_BODY_BYTES, SWAPS_STORED_UPSTREAM_TIMEOUT_MS,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";
const SUB = "user_test_stored";
const ONE = "/api/recipe/suggest-swaps/stored", ONE_LABEL = "/recipe/suggest-swaps/stored";
const BATCH = "/api/recipe/suggest-swaps/stored/batch", BATCH_LABEL = "/recipe/suggest-swaps/stored/batch";
const SWAP_BODY = { title: "Soup", servings: 2, lines: [{ text: "1 cup rice" }], version: "1.2" };
const ONE_BODY = JSON.stringify(SWAP_BODY);
const BATCH_BODY = JSON.stringify({ recipes: [{ id: "a", body: SWAP_BODY }, { id: "b", body: SWAP_BODY }], include: ["single", "combined"] });

function baseEnv(overrides = {}) {
  return { ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com", ASK_UPSTREAM, ASK_TOKEN, CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: JWKS_URL, DB: makeSqliteDB(), ...overrides };
}

let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody;
beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "stored-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});
beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ status: "none" });
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      return new Response(upstreamBody, { status: upstreamStatus, headers: { "Content-Type": "application/json" } });
    }
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
const callerIp = () => hashOf("0.0.0.0|" + new Date().toISOString().slice(0, 10));
async function seed(db, path, n) {
  const ins = db.sqlite.prepare("INSERT INTO engine_log (path, ip_hash, status, created_at) VALUES (?, ?, 200, datetime('now'))");
  const ip = await callerIp();
  for (let i = 0; i < n; i++) ins.run(path, ip);
}

describe.each([[ONE, ONE_LABEL, ONE_BODY], [BATCH, BATCH_LABEL, BATCH_BODY]])("%s", (route, label, body) => {
  it("is 401 without a valid bearer and calls nothing upstream", async () => {
    const env = baseEnv();
    expect((await worker.fetch(post(route, body), env)).status).toBe(401);
    expect((await worker.fetch(post(route, body, { Authorization: "Bearer nope" }), env)).status).toBe(401);
    expect(upstreamCalls.length).toBe(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("forwards to the same path with the service bearer and the verified sub, never a body-supplied account_id, and logs its own label", async () => {
    const env = baseEnv();
    const withVictim = JSON.stringify({ account_id: "user_victim", ...JSON.parse(body) });
    const res = await worker.fetch(post(route, withVictim, await auth()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(JSON.parse(upstreamBody));
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + route);
    expect(upstreamCalls[0].init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(upstreamCalls[0].init.headers.get("X-User-Token")).toBeNull();
    expect(forwardedJson(upstreamCalls[0]).account_id).toBe(SUB);
    expect(rows(env.DB)).toEqual([{ path: label, status: 200 }]);
    expect(upstreamCalls[0].init.signal).toBeDefined();
    expect(SWAPS_STORED_UPSTREAM_TIMEOUT_MS).toBe(15000);
  });

  it("passes the upstream's status and body through (400, 503)", async () => {
    for (const [status, b] of [[400, { error: "subset is not available on a stored lookup" }], [503, { error: "not configured" }]]) {
      upstreamStatus = status; upstreamBody = JSON.stringify(b);
      const env = baseEnv();
      const res = await worker.fetch(post(route, body, await auth()), env);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(b);
      expect(rows(env.DB)).toEqual([{ path: label, status }]);
    }
  });

  it("an unreachable upstream is this hop's 502, logged as 502", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
      throw new Error("boom");
    }));
    const env = baseEnv();
    const res = await worker.fetch(post(route, body, await auth()), env);
    expect(res.status).toBe(502);
    expect(rows(env.DB)).toEqual([{ path: label, status: 502 }]);
  });

  it("a body that is not a JSON object is a 400 with nothing forwarded", async () => {
    const env = baseEnv();
    const res = await worker.fetch(post(route, "[1,2]", await auth()), env);
    expect(res.status).toBe(400);
    expect(upstreamCalls.length).toBe(0);
  });

  it("has its own ceiling: 429 at the figure, the compute and import routes untouched, and a listed tester gets the raise", async () => {
    const env = baseEnv();
    await seed(env.DB, label, SWAPS_STORED_PER_HOUR);
    const res = await worker.fetch(post(route, body, await auth()), env);
    expect(res.status).toBe(429);
    expect(upstreamCalls.length).toBe(0);
    expect((await worker.fetch(post("/api/recipe/suggest-swaps", ONE_BODY, await auth()), env)).status).toBe(200);
    expect((await worker.fetch(post("/api/recipe/rate", ONE_BODY, await auth()), env)).status).toBe(200);
    const env2 = baseEnv({ RECIPE_DEV_SUBS: SUB });
    await seed(env2.DB, label, SWAPS_STORED_PER_HOUR);
    expect((await worker.fetch(post(route, body, await auth()), env2)).status).toBe(200);
    const env3 = baseEnv({ RECIPE_DEV_SUBS: SUB });
    await seed(env3.DB, label, SWAPS_STORED_PER_HOUR_DEV);
    expect((await worker.fetch(post(route, body, await auth()), env3)).status).toBe(429);
  });

  it("is not spent by the compute route's ceiling or by the import count", async () => {
    const env = baseEnv();
    await seed(env.DB, "/recipe/suggest-swaps", RECIPE_SWAPS_PER_HOUR * 3);
    await seed(env.DB, "/recipe/rate", RECIPE_PER_HOUR * 3);
    expect((await worker.fetch(post(route, body, await auth()), env)).status).toBe(200);
  });

  it("its rows do not count against the import ceiling", async () => {
    const env = baseEnv();
    await seed(env.DB, label, SWAPS_STORED_PER_HOUR_DEV * 2);
    expect((await worker.fetch(post("/api/recipe/rate", ONE_BODY, await auth()), env)).status).toBe(200);
  });
});

describe("body caps", () => {
  it("the single is refused over its cap with a 413 before a slot is claimed", async () => {
    const env = baseEnv();
    const over = '{"servings":1,"lines":[],"pad":"' + "x".repeat(SWAPS_STORED_BODY_BYTES) + '"}';
    const res = await worker.fetch(post(ONE, over, await auth()), env);
    expect(res.status).toBe(413);
    expect(upstreamCalls.length).toBe(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("the batch takes a body past the single's cap and is refused over its own", async () => {
    const env = baseEnv();
    const big = JSON.stringify({ recipes: [{ id: "a", body: { ...SWAP_BODY, pad: "x".repeat(SWAPS_STORED_BODY_BYTES + 1000) } }] });
    expect((await worker.fetch(post(BATCH, big, await auth()), env)).status).toBe(200);
    expect(forwardedJson(upstreamCalls[0]).recipes[0].body.pad.length).toBe(SWAPS_STORED_BODY_BYTES + 1000);
    const over = '{"recipes":[],"pad":"' + "x".repeat(SWAPS_STORED_BATCH_BODY_BYTES) + '"}';
    const res = await worker.fetch(post(BATCH, over, await auth()), env);
    expect(res.status).toBe(413);
    expect(upstreamCalls.length).toBe(1);
  });
});
