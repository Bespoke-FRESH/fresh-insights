// GET /api/recipe/catalog/{id}/ledger: a catalog recipe's Ledger v3 view (fresh-assistant-api PR #286), the record route's shape.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ETAG = '"cat-etag-1"';
let keyPair, kid, jwksDoc, calls;

const env = () => ({ ALLOWED_ORIGINS: "http://localhost:8081", ASK_UPSTREAM, ASK_TOKEN: "svc", CLERK_ISSUER: ISSUER,
  CLERK_JWKS_URL: JWKS_URL, DB: makeSqliteDB() });
const token = async () => { const n = Math.floor(Date.now() / 1000);
  return signTestJWT(keyPair.privateKey, kid, { iss: ISSUER, sub: "user_cat", exp: n + 3600, nbf: n - 10, iat: n - 10 }); };
const get = (route, headers = {}) => new Request("https://worker.example" + route, { method: "GET", headers });

beforeAll(async () => { keyPair = await generateTestKeyPair(); kid = "cat-kid"; jwksDoc = await exportJwks(keyPair.publicKey, kid); });
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.startsWith(ASK_UPSTREAM)) {
      calls.push({ url, init });
      const inm = init.headers?.get?.("If-None-Match");
      if (inm === ETAG) return new Response(null, { status: 304, headers: { ETag: ETAG } });
      if (url.includes("unknown")) return new Response(JSON.stringify({ error: "unknown_recipe" }), { status: 404 });
      return new Response(JSON.stringify({ view: true }), { status: 200, headers: { "Content-Type": "application/json", ETag: ETAG } });
    }
    throw new Error("unexpected fetch " + url);
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("/api/recipe/catalog/{id}/ledger", () => {
  it("forwards a catalog id with the service bearer, encoded colon", async () => {
    const res = await worker.fetch(get("/api/recipe/catalog/gen%3Acajun-spiced-shrimp-cauliflower-rice-bowl/ledger", { Authorization: `Bearer ${await token()}` }), env());
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(ETAG);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(ASK_UPSTREAM + "/api/recipe/catalog/gen%3Acajun-spiced-shrimp-cauliflower-rice-bowl/ledger");
    expect(calls[0].init.headers.get("Authorization")).toBe("Bearer svc");
  });
  it("passes the upstream's 404 and a 304 through", async () => {
    const a = { Authorization: `Bearer ${await token()}` };
    expect((await worker.fetch(get("/api/recipe/catalog/gen:unknown-thing/ledger", a), env())).status).toBe(404);
    expect((await worker.fetch(get("/api/recipe/catalog/nhlbi:minestrone-soup/ledger", { ...a, "If-None-Match": ETAG }), env())).status).toBe(304);
  });
  it("refuses an anonymous caller and a malformed id without calling upstream", async () => {
    expect((await worker.fetch(get("/api/recipe/catalog/gen:x/ledger"), env())).status).toBe(401);
    expect((await worker.fetch(get("/api/recipe/catalog/evil:x/ledger", { Authorization: `Bearer ${await token()}` }), env())).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
