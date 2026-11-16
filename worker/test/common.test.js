// GET /api/recipes/common and GET /api/recipes/common/{id} (fresh-assistant-api docs/api/recipe_common_contract.md 3 and 3.2; fresh_app #1056, the
// Discover "People" chip and community shelves). Same harness as rate-progress.test.js: a local RS256 key pair stands in for Clerk, a stubbed fetch for the
// JWKS and the upstream, and a real in-memory SQLite behind the D1 binding.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  COMMON_FEED_PER_HOUR, COMMON_FEED_PER_HOUR_DEV, COMMON_ITEM_PER_HOUR, COMMON_ITEM_PER_HOUR_DEV, COMMON_IP_FACTOR, COMMON_UPSTREAM_TIMEOUT_MS,
  ENGINE_PER_HOUR, RECIPE_PER_HOUR,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

const FEED = "/api/recipes/common";
const FEED_LABEL = "/common/feed";
const ITEM_LABEL = "/common/item";
const SUB = "user_test_common";
const ID = "ab".repeat(32);
const ITEM = FEED + "/" + ID;
const PAGE = { items: [{ id: ID, title: "Soup", shared_by: { first_name: "Osta", connect_handle: "h_opaque" } }], next_cursor: null, shelf: "community" };

function baseEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com,http://localhost:8081",
    ASK_UPSTREAM,
    ASK_TOKEN,
    CLERK_ISSUER: ISSUER,
    CLERK_JWKS_URL: JWKS_URL,
    DB: makeSqliteDB(),
    ...overrides,
  };
}

let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody, upstreamThrows;

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "common-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify(PAGE);
  upstreamThrows = false;
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      if (upstreamThrows) throw new Error("connect failed");
      return new Response(upstreamBody, { status: upstreamStatus, headers: {
        "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600", "Retry-After": "7",
        "ETag": "\"x\"", "Set-Cookie": "upstream=secret", "X-Upstream-Banner": "fly" } });
    }
    throw new Error("unexpected fetch in test: " + url);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function validToken(claimOverrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signTestJWT(keyPair.privateKey, kid, {
    iss: ISSUER, sub: SUB, exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
    ...claimOverrides,
  });
}
const auth = async (claims) => ({ Authorization: `Bearer ${await validToken(claims)}` });

function req(route, headers = {}, method = "GET") {
  return new Request("https://worker.example" + route, { method, headers });
}

const hashOf = async s => {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
};
const day = () => new Date().toISOString().slice(0, 10);
const callerHash = () => hashOf("0.0.0.0|" + day());
const acctKey = sub => hashOf("acct:" + sub + "|" + day());
async function seed(db, path, n, { sub = SUB, ip = null, subs = 0 } = {}) {
  const hash = ip ?? await callerHash();
  const ins = db.sqlite.prepare(
    "INSERT INTO engine_log (path, ip_hash, status, acct_hash, created_at) VALUES (?, ?, 200, ?, datetime('now'))");
  const keys = subs ? await Promise.all(Array.from({ length: subs }, (_, i) => acctKey("user_other_" + i))) : [await acctKey(sub)];
  for (let i = 0; i < n; i++) ins.run(path, hash, keys[i % keys.length]);
}
const rows = db => db.sqlite.prepare("SELECT path, ip_hash, status FROM engine_log ORDER BY id").all();

describe("GET /api/recipes/common (the feed)", () => {
  it("forwards a signed-in GET to the same path and passes the status and body through, no-store, with one label-only row", async () => {
    const env = baseEnv();
    const res = await worker.fetch(req(FEED, await auth()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PAGE);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + FEED);
    expect(rows(env.DB)).toEqual([{ path: FEED_LABEL, ip_hash: await callerHash(), status: 200 }]);
  });

  it("sends only the service bearer, the verified account and the verified token, with no body, no redirects and a timeout", async () => {
    const token = await validToken();
    await worker.fetch(req(FEED, { Authorization: `Bearer ${token}`, "X-Account-Id": "user_2victim", "X-User-Token": "forged.client.value", Cookie: "a=b" }), baseEnv());
    const { init } = upstreamCalls[0];
    const headers = new Headers(init.headers);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(COMMON_UPSTREAM_TIMEOUT_MS).toBe(15000);
    expect([...headers.keys()].sort()).toEqual(["authorization", "x-account-id", "x-user-token"]);
    expect(headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(headers.get("X-Account-Id")).toBe(SUB);
    expect(headers.get("X-User-Token")).toBe(token);
    expect(JSON.stringify(upstreamCalls)).not.toContain("user_2victim");
    expect(JSON.stringify(upstreamCalls)).not.toContain("forged.client.value");
  });

  it("sends no token to an upstream that is not https (a bearer credential is never sent in the clear)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
      upstreamCalls.push({ url, init });
      return new Response(upstreamBody, { status: 200 });
    }));
    await worker.fetch(req(FEED, await auth()), baseEnv({ ASK_UPSTREAM: "http://api.example" }));
    expect(new Headers(upstreamCalls[0].init.headers).has("X-User-Token")).toBe(false);
  });

  it("forwards the allow-listed query and drops everything else (an account in the query never reaches the upstream)", async () => {
    const cursor = "1763300000000." + "c".repeat(64);
    await worker.fetch(req(`${FEED}?limit=48&shelf=connections&meal=dinner&cuisine=italian&method=slow%20cooked&cursor=${cursor}&account_id=user_2victim&x=1`, await auth()), baseEnv());
    const url = new URL(upstreamCalls[0].url);
    expect(url.pathname).toBe(FEED);
    expect([...url.searchParams.keys()].sort()).toEqual(["cuisine", "cursor", "limit", "meal", "method", "shelf"]);
    expect(url.searchParams.get("limit")).toBe("48");
    expect(url.searchParams.get("shelf")).toBe("connections");
    expect(url.searchParams.get("method")).toBe("slow cooked");
    expect(url.searchParams.get("cursor")).toBe(cursor);
    expect(upstreamCalls[0].url).not.toContain("user_2victim");
  });

  it("an offset cursor (the connections shelf) is accepted", async () => {
    await worker.fetch(req(`${FEED}?cursor=48&shelf=connections`, await auth()), baseEnv());
    expect(new URL(upstreamCalls[0].url).searchParams.get("cursor")).toBe("48");
  });

  for (const q of ["limit=0", "limit=49", "limit=abc", "limit=-1", "limit=1.5", "shelf=everyone", "meal=Dinner", "meal=a".padEnd(32, "a"), "cuisine=a%2Fb",
                   "method=", "cursor=nope", "cursor=" + "1".repeat(17), "cursor=12.zz"]) {
    it(`a known parameter outside its shape (${q.length > 40 ? q.slice(0, 40) + "..." : q}) is this hop's 400, nothing forwarded and nothing counted`, async () => {
      const env = baseEnv();
      const res = await worker.fetch(req(`${FEED}?${q}`, await auth()), env);
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("bad_request");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(upstreamCalls).toHaveLength(0);
      expect(rows(env.DB)).toEqual([]);
    });
  }

  for (const status of [400, 401, 404, 503]) {
    it(`passes the upstream's ${status} through with its body, logged as ${status}`, async () => {
      upstreamStatus = status;
      upstreamBody = JSON.stringify({ error: "x", code: status === 503 ? "not_ready" : "signed_in_only" });
      const env = baseEnv();
      const res = await worker.fetch(req(FEED, await auth()), env);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(JSON.parse(upstreamBody));
      expect(rows(env.DB)).toEqual([{ path: FEED_LABEL, ip_hash: await callerHash(), status }]);
    });
  }

  it("of the upstream's headers only Content-Type and Retry-After cross; Cache-Control is always private, no-store", async () => {
    const res = await worker.fetch(req(FEED, await auth()), baseEnv());
    expect(res.headers.get("Retry-After")).toBe("7");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("ETag")).toBeNull();
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(res.headers.get("X-Upstream-Banner")).toBeNull();
  });

  it("an upstream redirect is refused as a 502 and nothing of it crosses", async () => {
    upstreamStatus = 302;
    upstreamBody = "";
    const env = baseEnv();
    const res = await worker.fetch(req(FEED, await auth()), env);
    expect(res.status).toBe(502);
    expect(rows(env.DB).map(r => r.status)).toEqual([502]);
  });

  it("an unreachable upstream is this hop's 502, no-store, logged as 502", async () => {
    upstreamThrows = true;
    const env = baseEnv();
    const res = await worker.fetch(req(FEED, await auth()), env);
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(rows(env.DB)).toEqual([{ path: FEED_LABEL, ip_hash: await callerHash(), status: 502 }]);
  });

  it("is refused without a usable sign-in, no-store, with nothing forwarded and nothing counted", async () => {
    const env = baseEnv();
    for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: "Basic abc" }, await auth({ exp: Math.floor(Date.now() / 1000) - 60 })]) {
      const res = await worker.fetch(req(FEED, headers), env);
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(upstreamCalls).toHaveLength(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("is a 503 (not a 401) when Clerk is not configured here, and an unconfigured upstream is a 503 only after the sign-in is verified", async () => {
    const noClerk = await worker.fetch(req(FEED, await auth()), baseEnv({ CLERK_ISSUER: undefined }));
    expect(noClerk.status).toBe(503);
    const anon = await worker.fetch(req(FEED), baseEnv({ ASK_UPSTREAM: undefined }));
    expect(anon.status).toBe(401);
    const noUp = await worker.fetch(req(FEED, await auth()), baseEnv({ ASK_UPSTREAM: undefined }));
    expect(noUp.status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("answers GET only: POST, PUT and DELETE are not this route and call nothing upstream", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await worker.fetch(req(FEED, await auth(), method), baseEnv());
      expect(res.status).toBe(404);
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("a sibling path is not this route", async () => {
    for (const p of ["/api/recipes", "/api/recipes/commonx", "/api/recipes/commons/" + ID]) {
      expect((await worker.fetch(req(p, await auth()), baseEnv())).status).toBe(404);
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("logs nothing of the request: only the label, the status, the address and account hashes", async () => {
    const env = baseEnv();
    await worker.fetch(req(`${FEED}?shelf=connections&meal=dinner&cursor=48`, await auth()), env);
    const row = env.DB.sqlite.prepare("SELECT * FROM engine_log").get();
    expect(row.path).toBe(FEED_LABEL);
    const text = JSON.stringify(row);
    for (const secret of [SUB, "connections", "dinner", "cursor", ID]) expect(text).not.toContain(secret);
    expect(row.acct_hash).toBe(await acctKey(SUB));
    expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM engine_log").get().n).toBe(1);
  });

  describe("the ceiling", () => {
    it("is 300 an hour per account, 900 for a listed tester", () => {
      expect(COMMON_FEED_PER_HOUR).toBe(300);
      expect(COMMON_FEED_PER_HOUR_DEV).toBe(900);
    });

    it("admits exactly the ceiling and then answers 429 with Retry-After, the account's scope, no-store, nothing forwarded", async () => {
      const env = baseEnv();
      await seed(env.DB, FEED_LABEL, COMMON_FEED_PER_HOUR - 1);
      expect((await worker.fetch(req(FEED, await auth()), env)).status).toBe(200);
      const res = await worker.fetch(req(FEED, await auth()), env);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("account");
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(upstreamCalls).toHaveLength(1);
    });

    it("a listed tester (ASK_DEV_SUBS or RECIPE_DEV_SUBS) gets the raised figure", async () => {
      const env = baseEnv({ ASK_DEV_SUBS: SUB });
      await seed(env.DB, FEED_LABEL, COMMON_FEED_PER_HOUR);
      expect((await worker.fetch(req(FEED, await auth()), env)).status).toBe(200);
      const env2 = baseEnv({ ASK_DEV_SUBS: "someone_else", RECIPE_DEV_SUBS: SUB });
      await seed(env2.DB, FEED_LABEL, COMMON_FEED_PER_HOUR);
      expect((await worker.fetch(req(FEED, await auth()), env2)).status).toBe(200);
      const env3 = baseEnv({ ASK_DEV_SUBS: SUB, RECIPE_DEV_SUBS: "none" });
      await seed(env3.DB, FEED_LABEL, COMMON_FEED_PER_HOUR);
      expect((await worker.fetch(req(FEED, await auth()), env3)).status).toBe(429);
    });

    it("another account at the same address is not held by this account's count, until the address backstop", async () => {
      const env = baseEnv();
      await seed(env.DB, FEED_LABEL, COMMON_FEED_PER_HOUR);
      expect((await worker.fetch(req(FEED, await auth({ sub: "user_other_one" })), env)).status).toBe(200);
      const env2 = baseEnv();
      await seed(env2.DB, FEED_LABEL, COMMON_FEED_PER_HOUR * COMMON_IP_FACTOR, { subs: 20 });
      const res = await worker.fetch(req(FEED, await auth({ sub: "user_fresh_account" })), env2);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("address");
    });

    it("is its own: it neither spends nor is spent by the item route, the recipe, the engine or any other label", async () => {
      const env = baseEnv();
      await seed(env.DB, ITEM_LABEL, COMMON_ITEM_PER_HOUR);
      await seed(env.DB, "/recipe/rate", RECIPE_PER_HOUR);
      await seed(env.DB, "/rate-progress", 50);
      expect((await worker.fetch(req(FEED, await auth()), env)).status).toBe(200);
      const env2 = baseEnv();
      await seed(env2.DB, FEED_LABEL, COMMON_FEED_PER_HOUR);
      expect((await worker.fetch(req(ITEM, await auth()), env2)).status).toBe(200);
    });

    it("the diet engine's ceiling does not count these rows (a full hour of community reads leaves /api/engine open)", async () => {
      const env = baseEnv();
      await seed(env.DB, FEED_LABEL, ENGINE_PER_HOUR);
      await seed(env.DB, ITEM_LABEL, ENGINE_PER_HOUR);
      const res = await worker.fetch(req("/api/engine/version", await auth()), env);
      expect(res.status).not.toBe(429);
    });
  });
});

describe("GET /api/recipes/common/{id} (one entry)", () => {
  const ENTRY = { item: { ...PAGE.items[0], servings: 4, lines: [{ text: "1 cup rice", qty: 1, unit: "cup" }], steps: ["Boil."] } };
  beforeEach(() => { upstreamBody = JSON.stringify(ENTRY); });

  it("forwards a signed-in GET to the same path with the verified account and token, and passes the body through", async () => {
    const env = baseEnv();
    const token = await validToken();
    const res = await worker.fetch(req(ITEM, { Authorization: `Bearer ${token}` }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(ENTRY);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    const { url, init } = upstreamCalls[0];
    expect(url).toBe(ASK_UPSTREAM + ITEM);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("manual");
    const headers = new Headers(init.headers);
    expect([...headers.keys()].sort()).toEqual(["authorization", "x-account-id", "x-user-token"]);
    expect(headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(headers.get("X-Account-Id")).toBe(SUB);
    expect(headers.get("X-User-Token")).toBe(token);
    expect(rows(env.DB)).toEqual([{ path: ITEM_LABEL, ip_hash: await callerHash(), status: 200 }]);
  });

  it("drops the query string and the client's identity headers", async () => {
    await worker.fetch(req(ITEM + "?account_id=user_2victim", { ...(await auth()), "X-Account-Id": "user_2victim", "X-User-Token": "forged.client.value" }), baseEnv());
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + ITEM);
    expect(JSON.stringify(upstreamCalls)).not.toContain("user_2victim");
    expect(JSON.stringify(upstreamCalls)).not.toContain("forged.client.value");
  });

  for (const bad of ["invalid", ID.toUpperCase(), ID.slice(1), ID + "0", ID + "/x", "..%2f..%2fadmin"]) {
    it(`an id that is not a 64-character hash (${bad.length > 20 ? bad.slice(0, 20) + "..." : bad}) is the upstream's own 404 not_found, answered here with no call and no row`, async () => {
      const env = baseEnv();
      const res = await worker.fetch(req(FEED + "/" + bad, await auth()), env);
      expect(res.status).toBe(404);
      expect((await res.json()).code).toBe("not_found");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(upstreamCalls).toHaveLength(0);
      expect(rows(env.DB)).toEqual([]);
    });
  }

  it("is judged after the caller: a malformed id from an anonymous caller is a 401, not a 404", async () => {
    expect((await worker.fetch(req(FEED + "/invalid"), baseEnv())).status).toBe(401);
    expect((await worker.fetch(req(ITEM), baseEnv())).status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  for (const status of [401, 404, 503]) {
    it(`passes the upstream's ${status} through, logged as ${status}`, async () => {
      upstreamStatus = status;
      upstreamBody = JSON.stringify({ code: status === 404 ? "not_found" : "not_ready" });
      const env = baseEnv();
      const res = await worker.fetch(req(ITEM, await auth()), env);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual(JSON.parse(upstreamBody));
      expect(rows(env.DB)).toEqual([{ path: ITEM_LABEL, ip_hash: await callerHash(), status }]);
    });
  }

  it("answers GET only", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await worker.fetch(req(ITEM, await auth(), method), baseEnv())).status).toBe(404);
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("logs the label only, never the entry id", async () => {
    const env = baseEnv();
    await worker.fetch(req(ITEM, await auth()), env);
    const text = JSON.stringify(env.DB.sqlite.prepare("SELECT * FROM engine_log").all());
    expect(text).toContain(ITEM_LABEL);
    expect(text).not.toContain(ID);
    expect(text).not.toContain(SUB);
  });

  describe("the ceiling", () => {
    it("is 600 an hour per account, 1500 for a listed tester", () => {
      expect(COMMON_ITEM_PER_HOUR).toBe(600);
      expect(COMMON_ITEM_PER_HOUR_DEV).toBe(1500);
    });

    it("admits exactly the ceiling and then answers 429, nothing forwarded", async () => {
      const env = baseEnv();
      await seed(env.DB, ITEM_LABEL, COMMON_ITEM_PER_HOUR - 1);
      expect((await worker.fetch(req(ITEM, await auth()), env)).status).toBe(200);
      const res = await worker.fetch(req(ITEM, await auth()), env);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("account");
      expect(upstreamCalls).toHaveLength(1);
    });

    it("a listed tester gets the raised figure", async () => {
      const env = baseEnv({ ASK_DEV_SUBS: SUB });
      await seed(env.DB, ITEM_LABEL, COMMON_ITEM_PER_HOUR);
      expect((await worker.fetch(req(ITEM, await auth()), env)).status).toBe(200);
    });

  });
});
