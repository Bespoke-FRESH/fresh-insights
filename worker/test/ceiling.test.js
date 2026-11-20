// The hourly ceilings counted in ceiling_count (claimCeiling, 2026-11-20): what a check reads and
// writes, that it stays atomic, that it fails open on a D1 error, the clock-hour Retry-After, and
// the prune of old buckets. The per-route figures and scopes stay pinned in each route's own file.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  ENGINE_PER_HOUR, ENGINE_PER_HOUR_IP, RECIPE_PER_HOUR,
  CEILING_CLAIM_SQL_1, CEILING_CLAIM_SQL_2, ceilingBucket, secondsToNextBucket,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ENGINE_UPSTREAM = "https://fresh-diet-engine.fly.dev";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";

function baseEnv(overrides = {}) {
  return {
    ALLOWED_ORIGINS: "https://insights.freshfoodrecs.com",
    ENGINE_UPSTREAM, ENGINE_TOKEN: "svc-secret-token",
    ASK_UPSTREAM, ASK_TOKEN: "svc-ask-token",
    CLERK_ISSUER: ISSUER, CLERK_JWKS_URL: JWKS_URL,
    DB: makeSqliteDB(),
    ...overrides,
  };
}

let keyPair, kid, jwksDoc, upstreamCalls;
beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "ceiling-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});
beforeEach(() => {
  upstreamCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
    upstreamCalls.push(url);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function auth(sub = "user_ceiling_1") {
  const now = Math.floor(Date.now() / 1000);
  const token = await signTestJWT(keyPair.privateKey, kid, { iss: ISSUER, sub, exp: now + 3600, nbf: now - 10, iat: now - 10 });
  return { Authorization: `Bearer ${token}` };
}
const engineReq = async sub => new Request("https://worker.example/api/engine/version", { headers: await auth(sub) });
const foodReq = async () => new Request("https://worker.example/api/food/fndds/51101000/attributes", { headers: await auth() });
const transcribeReq = async () => new Request("https://worker.example/api/recipe/transcribe", {
  method: "POST", headers: { "Content-Type": "application/json", ...(await auth()) }, body: "{}",
});
const counters = db => db.sqlite.prepare("SELECT bucket, key, n FROM ceiling_count ORDER BY key").all();

describe("the claim statement", () => {
  // The two-key claim must add one to BOTH keys or to neither: a refused request spends no count.
  it("increments both keys when both are under, and neither when one is full", () => {
    const { sqlite } = makeSqliteDB();
    const b = 500000;
    const claim = (aMax, iMax) => Number(sqlite.prepare(CEILING_CLAIM_SQL_2).run(b, "a:x:g", 1, aMax, "i:y:g", iMax).changes);
    expect(claim(2, 5)).toBe(2);
    expect(claim(2, 5)).toBe(2);
    const n = () => Object.fromEntries(sqlite.prepare("SELECT key, n FROM ceiling_count").all().map(r => [r.key, r.n]));
    expect(n()).toEqual({ "a:x:g": 2, "i:y:g": 2 });
    expect(claim(2, 5)).toBe(0); // the account key is full: the address key is not touched either
    expect(n()).toEqual({ "a:x:g": 2, "i:y:g": 2 });
    expect(claim(9, 2)).toBe(0); // the address key is full: the account key is not touched either
    expect(n()).toEqual({ "a:x:g": 2, "i:y:g": 2 });
  });

  it("a one-key claim admits exactly the figure in a bucket, and a new bucket starts at zero", () => {
    const { sqlite } = makeSqliteDB();
    const claim = bucket => Number(sqlite.prepare(CEILING_CLAIM_SQL_1).run(bucket, "i:y:recipe", 1, 3).changes);
    expect([claim(7), claim(7), claim(7), claim(7)]).toEqual([1, 1, 1, 0]);
    expect(claim(8)).toBe(1);
  });

  // O(1) rows read: both statements reach ceiling_count by its primary key only, never a scan, and
  // nothing on the request path reads engine_log however many rows it holds.
  it("reads ceiling_count by primary key only (no scan), whatever the table holds", () => {
    const { sqlite } = makeSqliteDB();
    const ins = sqlite.prepare("INSERT INTO ceiling_count (bucket, key, n, first_at) VALUES (?, ?, 1, 0)");
    for (let bucket = 0; bucket < 5; bucket++) for (let i = 0; i < 2000; i++) ins.run(bucket, `i:${i}:engine`);
    const plan = (sql, ...args) => sqlite.prepare("EXPLAIN QUERY PLAN " + sql).all(...args).map(r => r.detail);
    for (const steps of [
      plan(CEILING_CLAIM_SQL_1, 4, "i:1:engine", 0, 10),
      plan(CEILING_CLAIM_SQL_2, 4, "a:1:engine", 0, 10, "i:1:engine", 20),
      plan("SELECT key, n FROM ceiling_count WHERE bucket = ?1 AND key IN (?2, ?3)", 4, "a:1:engine", "i:1:engine"),
    ]) {
      const onTable = steps.filter(d => /ceiling_count/.test(d));
      expect(onTable.length).toBeGreaterThan(0);
      for (const d of onTable) expect(d).toMatch(/^SEARCH ceiling_count USING PRIMARY KEY \(bucket=\? AND key=\?\)/);
      expect(steps.some(d => /^SCAN ceiling_count/.test(d))).toBe(false);
    }
    // The prune reads only the buckets it deletes.
    const prune = plan("DELETE FROM ceiling_count WHERE bucket < ?1", 3);
    expect(prune.join(" ")).toMatch(/SEARCH ceiling_count USING PRIMARY KEY \(bucket<\?\)/);
  });
});

describe("statements per check", () => {
  it("an admitted engine call is one claim and one audit row; nothing reads engine_log", async () => {
    const env = baseEnv();
    const ins = env.DB.sqlite.prepare("INSERT INTO engine_log (path, ip_hash, status, acct_hash) VALUES ('/version', 'someone', 200, 'else')");
    for (let i = 0; i < 500; i++) ins.run();
    env.DB.calls.length = 0;
    expect((await worker.fetch(await engineReq(), env)).status).toBe(200);
    expect(env.DB.calls.map(c => c.sql)).toEqual([CEILING_CLAIM_SQL_2, expect.stringMatching(/^INSERT INTO engine_log /)]);
  });

  it("a refused engine call is the claim and one which-limit read by key, and writes nothing", async () => {
    const env = baseEnv();
    const b = ceilingBucket();
    env.DB.sqlite.prepare("INSERT INTO ceiling_count (bucket, key, n, first_at) VALUES (?, ?, ?, 0)")
      .run(b, "i:" + "f".repeat(24) + ":engine", 1); // another address's row, untouched
    for (let i = 0; i < ENGINE_PER_HOUR; i++) await worker.fetch(await engineReq(), env);
    env.DB.calls.length = 0;
    const before = counters(env.DB);
    const res = await worker.fetch(await engineReq(), env);
    expect(res.status).toBe(429);
    expect((await res.clone().json()).scope).toBe("account");
    expect(env.DB.calls.map(c => c.sql)).toEqual([CEILING_CLAIM_SQL_2, "SELECT key, n FROM ceiling_count WHERE bucket = ?1 AND key IN (?2, ?3)"]);
    expect(counters(env.DB)).toEqual(before);
  });

  it("the recipe import claim is one key (the address) and its refusal reads nothing more", async () => {
    const env = baseEnv();
    for (let i = 0; i < RECIPE_PER_HOUR; i++) expect((await worker.fetch(await transcribeReq(), env)).status).toBe(200);
    env.DB.calls.length = 0;
    expect((await worker.fetch(await transcribeReq(), env)).status).toBe(429);
    expect(env.DB.calls.map(c => c.sql)).toEqual([CEILING_CLAIM_SQL_1]);
    expect(counters(env.DB)).toEqual([{ bucket: ceilingBucket(), key: expect.stringMatching(/^i:[0-9a-f]{24}:recipe$/), n: RECIPE_PER_HOUR }]);
  });

  it("refuses at the same counts per scope: the account at 300, a new account on that address up to 600", async () => {
    const env = baseEnv();
    let admitted = 0;
    for (let s = 0; s < 3; s++) {
      for (let i = 0; i < ENGINE_PER_HOUR; i++) {
        const res = await worker.fetch(await engineReq("user_scope_" + s), env);
        if (res.status === 200) admitted++;
        else {
          expect(s).toBe(2); // the third account meets the address backstop
          expect((await res.json()).scope).toBe("address");
        }
      }
    }
    expect(admitted).toBe(ENGINE_PER_HOUR_IP);
    const res = await worker.fetch(await engineReq("user_scope_0"), env);
    expect(res.status).toBe(429);
    expect((await res.json()).scope).toBe("account"); // both full: the account is named
  }, 30000);
});

describe("Retry-After", () => {
  it("is the time to the next clock hour, from 1 to 3600", () => {
    const hour = 3600 * 1000 * 480000;
    expect(secondsToNextBucket(hour)).toBe(3600);
    expect(secondsToNextBucket(hour + 1000)).toBe(3599);
    expect(secondsToNextBucket(hour + 3599 * 1000)).toBe(1);
    expect(secondsToNextBucket(hour + 3599 * 1000 + 999)).toBe(1);
    expect(ceilingBucket(hour + 3599 * 1000)).toBe(ceilingBucket(hour));
    expect(ceilingBucket(hour + 3600 * 1000)).toBe(ceilingBucket(hour) + 1);
  });
});

describe("fail open", () => {
  it("a D1 error in every statement lets engine, food and recipe calls through, logging one line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = baseEnv({ DB: makeSqliteDB({ failOn: /./ }) });
    expect((await worker.fetch(await engineReq(), env)).status).toBe(200);
    expect((await worker.fetch(await foodReq(), env)).status).toBe(200);
    expect((await worker.fetch(await transcribeReq(), env)).status).toBe(200);
    expect(upstreamCalls).toHaveLength(3);
    const lines = err.mock.calls.filter(c => String(c[0]).startsWith("ceiling:"));
    expect(lines).toHaveLength(1); // at most one a minute per isolate
    expect(lines[0].join(" ")).toContain("D1 check failed, request let through");
    expect(lines[0].some(a => a instanceof Error || /\n\s+at /.test(String(a)))).toBe(false); // no stack
  });

  it("a failing claim alone still forwards and writes the audit row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = baseEnv({ DB: makeSqliteDB({ failOn: /ceiling_count/ }) });
    expect((await worker.fetch(await engineReq(), env)).status).toBe(200);
    expect(env.DB.sqlite.prepare("SELECT path, status FROM engine_log").all()).toEqual([{ path: "/version", status: 200 }]);
  });

  it("the ask ceiling's count fails open too", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reply: "hi", actions: [] }), { status: 200 })));
    const env = baseEnv({ DB: makeSqliteDB({ failOn: /./ }) });
    const res = await worker.fetch(new Request("https://worker.example/api/ask", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://insights.freshfoodrecs.com" },
      body: JSON.stringify({ app: "fresh_food_branded", q: "hello" }),
    }), env);
    expect(res.status).toBe(200);
  });
});

describe("prune", () => {
  const ctxFor = () => { const waits = []; return { waits, ctx: { waitUntil: p => waits.push(p) } }; };

  it("on 1 check in 50, deletes the buckets before the previous hour after the response", async () => {
    const env = baseEnv();
    const b = ceilingBucket();
    const ins = env.DB.sqlite.prepare("INSERT INTO ceiling_count (bucket, key, n, first_at) VALUES (?, 'i:old:engine', 1, 0)");
    for (const bucket of [b - 3, b - 2, b - 1]) ins.run(bucket);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { waits, ctx } = ctxFor();
    expect((await worker.fetch(await engineReq(), env, ctx)).status).toBe(200);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    const buckets = env.DB.sqlite.prepare("SELECT DISTINCT bucket FROM ceiling_count ORDER BY bucket").all().map(r => r.bucket);
    expect(buckets).toEqual([b - 1, b]);
  });

  it("does nothing on the other 49, and nothing without a ctx", async () => {
    const env = baseEnv();
    vi.spyOn(Math, "random").mockReturnValue(0.02);
    const { waits, ctx } = ctxFor();
    await worker.fetch(await engineReq(), env, ctx);
    expect(waits).toHaveLength(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    await worker.fetch(await engineReq(), env);
    expect(env.DB.calls.some(c => /^DELETE/.test(c.sql))).toBe(false);
  });
});
