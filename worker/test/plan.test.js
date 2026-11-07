// /api/plan/ideas, /api/plan/idea-image and /api/recipe/allergy-check: forwarded to fresh-assistant-api (docs/api/recipe_write_contract.md sections 4d and 4e),
// each with the verified account id in the body, a ceiling of its own counted per account (with the address backstop), and, for the two that read the person's saved
// rows, the verified token as X-User-Token. Same harness as recipe.test.js.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  RECIPE_PER_HOUR, RECIPE_WRITE_PER_HOUR, RECIPE_WRITE_IP_FACTOR, ENGINE_PER_HOUR,
  PLAN_IDEAS_PER_HOUR, PLAN_IDEAS_PER_HOUR_DEV, IDEA_IMAGE_PER_HOUR, IDEA_IMAGE_PER_HOUR_DEV, ALLERGY_CHECK_PER_HOUR, ALLERGY_CHECK_PER_HOUR_DEV,
  PLAN_UPSTREAM_TIMEOUT_MS, ALLERGY_CHECK_UPSTREAM_TIMEOUT_MS,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ENGINE_UPSTREAM = "https://fresh-diet-engine.fly.dev";
const ASK_TOKEN = "svc-ask-token";
const SUB = "user_test_plan";

const IDEAS = "/api/plan/ideas", IMAGE = "/api/plan/idea-image", CHECK = "/api/recipe/allergy-check";
const LABEL = { [IDEAS]: "/plan/ideas", [IMAGE]: "/plan/idea-image", [CHECK]: "/recipe/allergy-check" };
const CEILING = { [IDEAS]: [PLAN_IDEAS_PER_HOUR, PLAN_IDEAS_PER_HOUR_DEV], [IMAGE]: [IDEA_IMAGE_PER_HOUR, IDEA_IMAGE_PER_HOUR_DEV], [CHECK]: [ALLERGY_CHECK_PER_HOUR, ALLERGY_CHECK_PER_HOUR_DEV] };
const BODY = {
  [IDEAS]: JSON.stringify({ count: 6, request: "three quick dinners" }),
  [IMAGE]: JSON.stringify({ idea_key: "a".repeat(64) }),
  [CHECK]: JSON.stringify({ lines: ["1 tbsp soy sauce"] }),
};
const NOUN = { [IDEAS]: "idea list", [IMAGE]: "idea picture", [CHECK]: "allergy check" };

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

describe("the plan and allergy-check routes", () => {
  for (const route of [IDEAS, IMAGE, CHECK]) {
    describe(route, () => {
      it("is 401 without a bearer, with a wrong one and with an expired one, and calls nothing upstream", async () => {
        const env = baseEnv();
        expect((await worker.fetch(post(route, BODY[route]), env)).status).toBe(401);
        expect((await worker.fetch(post(route, BODY[route], { Authorization: "Bearer nope" }), env)).status).toBe(401);
        expect((await worker.fetch(post(route, BODY[route], await auth({ exp: Math.floor(Date.now() / 1000) - 60 })), env)).status).toBe(401);
        expect(upstreamCalls.length).toBe(0);
        expect(rows(env.DB)).toEqual([]);
      });

      it("a GET is not this route", async () => {
        const res = await worker.fetch(new Request("https://worker.example" + route, { method: "GET", headers: await auth() }), baseEnv());
        expect(res.status).not.toBe(200);
        expect(upstreamCalls.length).toBe(0);
      });

      it("forwards to the same path with the service bearer, the verified sub in the body (a body-supplied account_id never reaches it), and logs its own label", async () => {
        const env = baseEnv();
        const body = JSON.stringify({ account_id: "user_victim", ...JSON.parse(BODY[route]) });
        const res = await worker.fetch(post(route, body, await auth()), env);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual(JSON.parse(upstreamBody));
        expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + route);
        expect(upstreamCalls[0].init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
        expect(forwardedJson(upstreamCalls[0])).toEqual({ ...JSON.parse(BODY[route]), account_id: SUB });
        expect(rows(env.DB)).toEqual([{ path: LABEL[route], status: 200 }]);
      });

      it("passes the upstream's status and body through unchanged, including the 404 of an off flag and the cap's 429", async () => {
        for (const [status, body] of [[404, { error: "not found" }], [429, { error: "the daily limit of generated images has been reached", code: "daily_cap", limit: 12 }], [400, { error: "count must be a whole number from 1 to 8" }], [503, { error: "x", code: "disabled" }]]) {
          upstreamStatus = status; upstreamBody = JSON.stringify(body);
          const env = baseEnv();
          const res = await worker.fetch(post(route, BODY[route], await auth()), env);
          expect(res.status).toBe(status);
          expect(await res.json()).toEqual(body);
          expect(rows(env.DB)).toEqual([{ path: LABEL[route], status }]);
        }
      });

      it("an unreachable upstream is this hop's 502, logged as 502", async () => {
        const headers = await auth();
        vi.stubGlobal("fetch", vi.fn(async (input) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }));
        const env = baseEnv();
        const res = await worker.fetch(post(route, BODY[route], headers), env);
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ error: "recipe service unreachable", reason: "recipe service did not respond; try again later" });
        expect(rows(env.DB)).toEqual([{ path: LABEL[route], status: 502 }]);
      });

      it("a body that is not a JSON object is this hop's 400 and nothing is forwarded", async () => {
        const res = await worker.fetch(post(route, "[1,2]", await auth()), baseEnv());
        expect(res.status).toBe(400);
        expect(upstreamCalls.length).toBe(0);
      });

      it("the upstream timeout: 40 s for the ideas list and the picture, 15 s for the allergy check", async () => {
        const spy = vi.spyOn(AbortSignal, "timeout");
        try {
          await worker.fetch(post(route, BODY[route], await auth()), baseEnv());
          expect(spy).toHaveBeenLastCalledWith(route === CHECK ? ALLERGY_CHECK_UPSTREAM_TIMEOUT_MS : PLAN_UPSTREAM_TIMEOUT_MS);
        } finally { spy.mockRestore(); }
        expect(PLAN_UPSTREAM_TIMEOUT_MS).toBe(40000); expect(ALLERGY_CHECK_UPSTREAM_TIMEOUT_MS).toBe(15000);
      });
    });
  }

  describe("the person's token", () => {
    it("the ideas list and the allergy check carry the verified token as X-User-Token (the upstream reads their saved allergies with it); the picture route does not", async () => {
      const token = await validToken();
      for (const route of [IDEAS, CHECK, IMAGE]) {
        upstreamCalls = [];
        await worker.fetch(post(route, BODY[route], { Authorization: `Bearer ${token}` }), baseEnv());
        const h = upstreamCalls[0].init.headers;
        expect(h.get("X-User-Token")).toBe(route === IMAGE ? null : token);
        expect(h.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
        expect(JSON.stringify(upstreamCalls[0].init.body)).not.toContain(token);
      }
    });

    it("a redirect from a token-carrying route is refused as a 502 (a custom header survives a cross-origin redirect), and nothing of it reaches the caller", async () => {
      for (const route of [IDEAS, CHECK]) {
        vi.stubGlobal("fetch", vi.fn(async (input) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
          return new Response("moved", { status: 302, headers: { Location: "https://evil.example/x" } });
        }));
        const res = await worker.fetch(post(route, BODY[route], await auth()), baseEnv());
        expect(res.status).toBe(502);
        expect(res.headers.get("Location")).toBeNull();
      }
    });
  });

  describe("ceilings of their own, per account", () => {
    it("the figures: 60 / 200, 30 / 100, 120 / 400, and the ideas list sits at write's level", () => {
      expect([PLAN_IDEAS_PER_HOUR, PLAN_IDEAS_PER_HOUR_DEV]).toEqual([60, 200]);
      expect([IDEA_IMAGE_PER_HOUR, IDEA_IMAGE_PER_HOUR_DEV]).toEqual([30, 100]);
      expect([ALLERGY_CHECK_PER_HOUR, ALLERGY_CHECK_PER_HOUR_DEV]).toEqual([120, 400]);
      expect(PLAN_IDEAS_PER_HOUR).toBe(RECIPE_WRITE_PER_HOUR);
    });

    for (const route of [IDEAS, IMAGE, CHECK]) {
      const [ceiling] = CEILING[route];
      it(`${route}: a claim records the account's daily hash beside the address hash and the label`, async () => {
        const env = baseEnv();
        await worker.fetch(post(route, BODY[route], await auth()), env);
        expect(env.DB.sqlite.prepare("SELECT path, ip_hash, status, acct_hash FROM engine_log").all())
          .toEqual([{ path: LABEL[route], ip_hash: await callerIp(), status: 200, acct_hash: await acctOf(SUB) }]);
      });

      it(`${route}: 429s the account at ${ceiling} an hour with scope account, never calling upstream or adding a row`, async () => {
        const env = baseEnv();
        await seed(env.DB, LABEL[route], ceiling - 1);
        expect((await worker.fetch(post(route, BODY[route], await auth()), env)).status).toBe(200);
        upstreamCalls.length = 0;
        const res = await worker.fetch(post(route, BODY[route], await auth()), env);
        expect(res.status).toBe(429);
        expect(await res.json()).toEqual({ error: "too many requests — try again later", reason: `${NOUN[route]} limit reached for this account (${ceiling} per hour); try again later`, scope: "account" });
        expect(upstreamCalls.length).toBe(0);
        expect(rows(env.DB).length).toBe(ceiling);
      });

      it(`${route}: another account on the same address is not held back; the same account is still limited from another address`, async () => {
        const env = baseEnv();
        await seed(env.DB, LABEL[route], ceiling);
        expect((await worker.fetch(post(route, BODY[route], await auth()), env)).status).toBe(429);
        expect((await worker.fetch(post(route, BODY[route], await auth({ sub: "user_someone_else" })), env)).status).toBe(200);
        const env2 = baseEnv();
        await seed(env2.DB, LABEL[route], ceiling, { ip: await hashOf("elsewhere") });
        expect((await worker.fetch(post(route, BODY[route], await auth()), env2)).status).toBe(429);
      });

      it(`${route}: the address backstop is ${RECIPE_WRITE_IP_FACTOR} times the account figure, scope address`, async () => {
        const env = baseEnv();
        await seed(env.DB, LABEL[route], ceiling * RECIPE_WRITE_IP_FACTOR, { subs: 7 });
        const res = await worker.fetch(post(route, BODY[route], await auth()), env);
        expect(res.status).toBe(429);
        const j = await res.json();
        expect(j.scope).toBe("address");
        expect(j.reason).toBe(`${NOUN[route]} limit reached for this address (${ceiling * RECIPE_WRITE_IP_FACTOR} per hour); try again later`);
      });

      it(`${route}: a listed tester gets the raised figure (RECIPE_DEV_SUBS), nobody else does`, async () => {
        const [pub, dev] = CEILING[route];
        const env = baseEnv({ RECIPE_DEV_SUBS: SUB });
        await seed(env.DB, LABEL[route], pub);
        expect((await worker.fetch(post(route, BODY[route], await auth()), env)).status).toBe(200);
        const plain = baseEnv();
        await seed(plain.DB, LABEL[route], pub);
        expect((await worker.fetch(post(route, BODY[route], await auth()), plain)).status).toBe(429);
        expect(dev).toBeGreaterThan(pub);
      });
    }

    it("none of the three counts against the import budget, and imports never count against them (the allergy check's /recipe/ label is excluded from the import count)", async () => {
      const env = baseEnv();
      for (const route of [IDEAS, IMAGE, CHECK]) await seed(env.DB, LABEL[route], CEILING[route][1]);
      // a full set of plan rows leaves every import slot open: RECIPE_PER_HOUR - 1 imports still pass, the next is the 429
      await seed(env.DB, "/recipe/rate", RECIPE_PER_HOUR - 1);
      expect((await worker.fetch(post("/api/recipe/rate", '{"servings":1,"lines":[]}', await auth()), env)).status).toBe(200);
      const next = await worker.fetch(post("/api/recipe/extract", '{"url":"https://example.com/r"}', await auth()), env);
      expect(next.status).toBe(429);
      expect((await next.json()).reason).toBe(`recipe limit reached (${RECIPE_PER_HOUR} per hour); try again later`);
      // and a full import budget leaves the three open
      const full = baseEnv();
      for (const p of ["/recipe/extract", "/recipe/rate", "/recipe/transcribe-video"]) await seed(full.DB, p, RECIPE_PER_HOUR);
      for (const route of [IDEAS, IMAGE, CHECK]) expect((await worker.fetch(post(route, BODY[route], await auth()), full)).status).toBe(200);
    });

    it("the three do not count against each other, or against the draft writer", async () => {
      const env = baseEnv();
      await seed(env.DB, "/plan/ideas", PLAN_IDEAS_PER_HOUR);
      expect((await worker.fetch(post(IMAGE, BODY[IMAGE], await auth()), env)).status).toBe(200);
      expect((await worker.fetch(post(CHECK, BODY[CHECK], await auth()), env)).status).toBe(200);
      expect((await worker.fetch(post("/api/recipe/write", '{"request":"a fish dinner"}', await auth()), env)).status).toBe(200);
      const w = baseEnv();
      await seed(w.DB, "/recipe/write", RECIPE_WRITE_PER_HOUR);
      expect((await worker.fetch(post(IDEAS, BODY[IDEAS], await auth()), w)).status).toBe(200);
    });

    it("plan rows do not count against the diet engine's ceiling", async () => {
      const env = baseEnv();
      await seed(env.DB, "/plan/ideas", ENGINE_PER_HOUR + 5);
      await seed(env.DB, "/plan/idea-image", ENGINE_PER_HOUR + 5);
      const res = await worker.fetch(new Request("https://worker.example/api/engine/version", { method: "GET", headers: await auth() }), env);
      expect(res.status).toBe(200);
    });
  });

  describe("routing and CORS", () => {
    it("an OPTIONS preflight is answered for each route like the other recipe routes", async () => {
      for (const route of [IDEAS, IMAGE, CHECK]) {
        const res = await worker.fetch(new Request("https://worker.example" + route, { method: "OPTIONS", headers: { Origin: "https://insights.freshfoodrecs.com", "Access-Control-Request-Method": "POST" } }), baseEnv());
        expect(res.status).toBeLessThan(300);
        expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
      }
    });

    it("a neighbouring path is still not forwarded", async () => {
      for (const route of ["/api/plan/other", "/api/plan", "/api/recipe/allergy-checks", "/api/plan/ideas/x"]) {
        const res = await worker.fetch(post(route, "{}", await auth()), baseEnv());
        expect(res.status).toBe(404);
      }
      expect(upstreamCalls.length).toBe(0);
    });
  });
});
