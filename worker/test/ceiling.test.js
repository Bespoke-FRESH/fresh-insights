// The hourly ceilings counted in ceiling_count (claimCeiling, 2026-11-20): what a check reads and
// writes, that it stays atomic, that a D1 error is not caught, the clock-hour Retry-After, and
// the prune of old buckets. The per-route figures and scopes stay pinned in each route's own file.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  ENGINE_PER_HOUR, ENGINE_PER_HOUR_IP, ENGINE_PER_HOUR_DEV, ENGINE_PER_HOUR_IP_DEV, RECIPE_PER_HOUR, RECIPE_STEPS_PER_HOUR, RECIPE_WRITE_IP_FACTOR,
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

const status500 = async (req, env) => { vi.spyOn(console, "error").mockImplementation(() => {}); return (await worker.fetch(req, env)).status; };
describe("D1 errors are not caught (behaviour unchanged from the engine_log count)", () => {
  // The old count had no try/catch either: a D1 error in the check reached the Worker catch-all, a 500.
  it("a failing claim answers 500 (the Worker catch-all) and the upstream is not called", async () => {
    const env = baseEnv({ DB: makeSqliteDB({ failOn: /ceiling_count/ }) });
    expect(await status500(await engineReq(), env)).toBe(500);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("a failing claim on the food and recipe routes answers 500 too", async () => {
    const env = baseEnv({ DB: makeSqliteDB({ failOn: /ceiling_count/ }) });
    expect(await status500(await foodReq(), env)).toBe(500);
    expect(await status500(await transcribeReq(), env)).toBe(500);
    expect(upstreamCalls).toHaveLength(0);
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

// ── Allow at N-1, deny at N, for each kind of ceiling ───────────────────────────────────────────
// The counters are primed through ceiling_count itself (the first call shows the keys, then the
// row is set to one under the figure), so each case checks the boundary, not the loop to it.
describe("the boundary of each ceiling: allowed at N-1, denied at N", () => {
  const setN = (env, like, n) => env.DB.sqlite.prepare("UPDATE ceiling_count SET n = ? WHERE key LIKE ?").run(n, like);
  const stepsReq = async () => new Request("https://worker.example/api/recipe/steps", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await auth()) }, body: "{}",
  });
  const swapsReq = async () => new Request("https://worker.example/api/recipe/suggest-swaps", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await auth()) }, body: "{}",
  });
  const status = async (mk, env) => (await worker.fetch(await mk(), env)).status;

  it("engine, per account: the 300th is admitted and the 301st is refused with scope account", async () => {
    const env = baseEnv();
    expect(await status(engineReq, env)).toBe(200); // creates both counter rows
    setN(env, "a:%:engine", ENGINE_PER_HOUR - 1);
    expect(await status(engineReq, env)).toBe(200);
    const res = await worker.fetch(await engineReq(), env);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.scope).toBe("account");
    expect(body.reason).toContain(`(${ENGINE_PER_HOUR} per hour)`);
  });

  it("engine, per address: a different account on a full address is refused with scope address", async () => {
    const env = baseEnv();
    expect(await status(() => engineReq("user_a"), env)).toBe(200);
    setN(env, "i:%:engine", ENGINE_PER_HOUR_IP - 1);
    expect(await status(() => engineReq("user_b"), env)).toBe(200);
    const res = await worker.fetch(await engineReq("user_c"), env);
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.scope).toBe("address");
    expect(body.reason).toContain(`(${ENGINE_PER_HOUR_IP} per hour)`);
  });

  it("engine, a listed tester: 3000 per account and 6000 per address; an unlisted account stays at 300", async () => {
    const env = baseEnv({ ENGINE_DEV_SUBS: "user_tester" });
    expect(await status(() => engineReq("user_tester"), env)).toBe(200);
    setN(env, "a:%:engine", ENGINE_PER_HOUR_DEV - 1);
    setN(env, "i:%:engine", ENGINE_PER_HOUR_IP_DEV - 1);
    expect(await status(() => engineReq("user_tester"), env)).toBe(200);
    const res = await worker.fetch(await engineReq("user_tester"), env);
    expect(res.status).toBe(429);
    expect((await res.json()).reason).toContain(`(${ENGINE_PER_HOUR_DEV} per hour)`);
    // 299 on the public figure is one admission from the wall; the tester raise did not move it.
    const env2 = baseEnv({ ENGINE_DEV_SUBS: "user_tester" });
    expect(await status(() => engineReq("user_plain"), env2)).toBe(200);
    setN(env2, "a:%:engine", ENGINE_PER_HOUR - 1);
    expect(await status(() => engineReq("user_plain"), env2)).toBe(200);
    expect(await status(() => engineReq("user_plain"), env2)).toBe(429);
  });

  it("a by-account recipe route (steps): admitted at 59, refused at 60 with scope account, and the address backstop is 5x", async () => {
    const env = baseEnv();
    expect(await status(stepsReq, env)).toBe(200);
    setN(env, "a:%:/recipe/steps", RECIPE_STEPS_PER_HOUR - 1);
    expect(await status(stepsReq, env)).toBe(200);
    const res = await worker.fetch(await stepsReq(), env);
    expect(res.status).toBe(429);
    expect((await res.json()).scope).toBe("account");
    const env2 = baseEnv();
    expect(await status(stepsReq, env2)).toBe(200);
    setN(env2, "i:%:/recipe/steps", RECIPE_STEPS_PER_HOUR * RECIPE_WRITE_IP_FACTOR - 1);
    expect(await status(stepsReq, env2)).toBe(200);
    const res2 = await worker.fetch(await stepsReq(), env2);
    expect(res2.status).toBe(429);
    expect((await res2.json()).scope).toBe("address");
  });

  it("the recipe import count (address only): admitted at 29, refused at 30, and the 429 carries no scope", async () => {
    const env = baseEnv();
    expect(await status(transcribeReq, env)).toBe(200);
    setN(env, "i:%:recipe", RECIPE_PER_HOUR - 1);
    expect(await status(transcribeReq, env)).toBe(200);
    const res = await worker.fetch(await transcribeReq(), env);
    expect(res.status).toBe(429);
    expect((await res.json()).scope).toBeUndefined();
  });

  it("exclusions: an own-label route does not count toward the import count, and a full import count does not block it", async () => {
    const env = baseEnv();
    expect(await status(transcribeReq, env)).toBe(200);
    setN(env, "i:%:recipe", RECIPE_PER_HOUR); // the import count is now full
    expect(await status(transcribeReq, env)).toBe(429);
    expect(await status(swapsReq, env)).not.toBe(429); // its own label, its own key
    const keys = counters(env.DB).map(r => r.key.replace(/^(a|i):[0-9a-f]{24}:/, "$1:"));
    expect(keys).toContain("i:/recipe/suggest-swaps");
    const importRow = counters(env.DB).find(r => /:recipe$/.test(r.key));
    expect(importRow.n).toBe(RECIPE_PER_HOUR); // the swaps call and the refused import added nothing
    // and the engine count is not touched by recipe calls at all
    expect(counters(env.DB).some(r => /:engine$/.test(r.key))).toBe(false);
  });

  it("old buckets are not counted: a full previous hour leaves the current hour at zero", async () => {
    const env = baseEnv();
    expect(await status(engineReq, env)).toBe(200);
    const rows = counters(env.DB);
    const b = ceilingBucket();
    env.DB.sqlite.prepare("DELETE FROM ceiling_count").run();
    const ins = env.DB.sqlite.prepare("INSERT INTO ceiling_count (bucket, key, n, first_at) VALUES (?, ?, ?, 0)");
    for (const r of rows) ins.run(b - 1, r.key, r.key.startsWith("a:") ? ENGINE_PER_HOUR : ENGINE_PER_HOUR_IP);
    expect(await status(engineReq, env)).toBe(200);
    const now = env.DB.sqlite.prepare("SELECT bucket, n FROM ceiling_count WHERE bucket = ?").all(b);
    expect(now.map(r => r.n)).toEqual([1, 1]);
  });
});

// ── A claim the old count would not have consumed is given back ─────────────────────────────────
// The old engine count read engine_log, and the engine route wrote a row only after the upstream
// answered: a 413 or an unreachable upstream used no quota. Food, record, rating-tuple, rate-progress,
// common, scan and the recipe routes logged a row on every path after their claim, so they keep it.
describe("engine claim is released where the old count consumed nothing", () => {
  const postReq = async (headers = {}) => new Request("https://worker.example/api/engine/intake", {
    method: "POST", headers: { "Content-Type": "application/json", ...(await auth()), ...headers }, body: "{}",
  });
  const engineCount = env => counters(env.DB).filter(r => /:engine$/.test(r.key)).map(r => r.n);

  it("after 300 connection failures a healthy call is still admitted", async () => {
    const env = baseEnv();
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
      throw new TypeError("fetch failed");
    }));
    for (let i = 0; i < ENGINE_PER_HOUR; i++) expect((await worker.fetch(await engineReq(), env)).status).toBe(502);
    expect(engineCount(env)).toEqual([0, 0]); // released, floored at 0
    expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM engine_log").get().n).toBe(0); // as on main: no row
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
      return new Response("{}", { status: 200 });
    }));
    expect((await worker.fetch(await engineReq(), env)).status).toBe(200);
    expect(engineCount(env)).toEqual([1, 1]);
  });

  it("a 413 gives the claim back and does not touch the upstream", async () => {
    const env = baseEnv();
    for (let i = 0; i < ENGINE_PER_HOUR; i++) {
      expect((await worker.fetch(await postReq({ "Content-Length": String(11 * 1024 * 1024) }), env)).status).toBe(413);
    }
    expect(upstreamCalls).toHaveLength(0);
    expect(engineCount(env)).toEqual([0, 0]);
    expect((await worker.fetch(await engineReq(), env)).status).toBe(200);
  });

  it("an upstream 5xx that answered still counts, as its engine_log row did on main", async () => {
    const env = baseEnv();
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
      return new Response("{}", { status: 503 });
    }));
    expect((await worker.fetch(await engineReq(), env)).status).toBe(503);
    expect(engineCount(env)).toEqual([1, 1]);
  });

  it("a refused call (429) gives nothing back: the release only follows an admitted claim", async () => {
    const env = baseEnv();
    expect((await worker.fetch(await engineReq(), env)).status).toBe(200);
    env.DB.sqlite.prepare("UPDATE ceiling_count SET n = ? WHERE key LIKE 'a:%:engine'").run(ENGINE_PER_HOUR);
    expect((await worker.fetch(await engineReq(), env)).status).toBe(429);
    expect(counters(env.DB).find(r => r.key.startsWith("a:")).n).toBe(ENGINE_PER_HOUR);
  });
});
