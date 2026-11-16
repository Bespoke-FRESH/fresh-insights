// GET /api/scan/{code} (fresh-assistant-api docs/api/scan_lookup_contract.md; fresh_app #444, the scan screen). Same harness as common.test.js: a local RS256 key pair
// stands in for Clerk, a stubbed fetch for the JWKS and the upstream, and a real in-memory SQLite behind the D1 binding.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, {
  SCAN_PER_HOUR, SCAN_PER_HOUR_DEV, SCAN_IP_FACTOR, SCAN_UPSTREAM_TIMEOUT_MS, ENGINE_PER_HOUR, RECORD_PER_HOUR,
} from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

const LABEL = "/scan";
const SUB = "user_test_scan";
const CODE = "008274000078";
const ROUTE = "/api/scan/" + CODE;
const BODY = { scan: { gtin14: "00008274000078", scan_key: "00008274000078" }, product: { name: "GINGER BEER", brand: "REED'S" }, rating: { status: "no_rating_yet" } };

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

let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody, upstreamHeaders, upstreamThrows;

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "scan-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify(BODY);
  upstreamThrows = false;
  upstreamHeaders = {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-cache", "ETag": "\"abc123\"",
    "Set-Cookie": "upstream=secret", "X-Upstream-Banner": "fly",
  };
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(JWKS_URL)) {
      return new Response(JSON.stringify(jwksDoc), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (url.startsWith(ASK_UPSTREAM)) {
      upstreamCalls.push({ url, init });
      if (upstreamThrows) throw new Error("connect failed");
      const nullBody = upstreamStatus === 304;
      return new Response(nullBody ? null : upstreamBody, { status: upstreamStatus, headers: upstreamHeaders });
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

describe("GET /api/scan/{code}", () => {
  it("forwards a signed-in GET to the same path and passes the status and body through, no-store, with one label-only row", async () => {
    const env = baseEnv();
    const res = await worker.fetch(req(ROUTE, await auth()), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(BODY);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + ROUTE);
    expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 200 }]);
  });

  it("sends only the service bearer: no account, no user token, no cookie, no query; no body, no redirects, a timeout", async () => {
    const token = await validToken();
    await worker.fetch(req(ROUTE + "?account_id=user_2victim&x=1", { Authorization: `Bearer ${token}`, "X-Account-Id": "user_2victim", "X-User-Token": "forged.client.value", Cookie: "a=b" }), baseEnv());
    const { url, init } = upstreamCalls[0];
    const headers = new Headers(init.headers);
    expect(url).toBe(ASK_UPSTREAM + ROUTE);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(SCAN_UPSTREAM_TIMEOUT_MS).toBe(15000);
    expect([...headers.keys()]).toEqual(["authorization"]);
    expect(headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
    expect(JSON.stringify(upstreamCalls)).not.toContain("user_2victim");
    expect(JSON.stringify(upstreamCalls)).not.toContain("forged.client.value");
    expect(JSON.stringify(upstreamCalls)).not.toContain(token);
  });

  it("is refused without a usable sign-in, no-store, with nothing forwarded and nothing counted", async () => {
    const env = baseEnv();
    for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: "Basic abc" }, await auth({ exp: Math.floor(Date.now() / 1000) - 60 })]) {
      const res = await worker.fetch(req(ROUTE, headers), env);
      expect(res.status).toBe(401);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    }
    expect(upstreamCalls).toHaveLength(0);
    expect(rows(env.DB)).toEqual([]);
  });

  it("is judged after the caller: a bad code from an anonymous caller is a 401, not a 400", async () => {
    expect((await worker.fetch(req("/api/scan/abc"), baseEnv())).status).toBe(401);
    expect((await worker.fetch(req("/api/scan"), baseEnv())).status).toBe(401);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("is a 503 (not a 401) when Clerk is not configured here, and an unconfigured upstream is a 503 only after the sign-in is verified", async () => {
    expect((await worker.fetch(req(ROUTE, await auth()), baseEnv({ CLERK_ISSUER: undefined }))).status).toBe(503);
    expect((await worker.fetch(req(ROUTE), baseEnv({ ASK_UPSTREAM: undefined }))).status).toBe(401);
    expect((await worker.fetch(req(ROUTE, await auth()), baseEnv({ ASK_UPSTREAM: undefined }))).status).toBe(503);
    expect(upstreamCalls).toHaveLength(0);
  });

  describe("the code allow-list (8, 12, 13 or 14 digits)", () => {
    for (const ok of ["12345678", "008274000078", "5901234123457", "00008274000078"]) {
      it(`${ok} is forwarded as is`, async () => {
        const res = await worker.fetch(req("/api/scan/" + ok, await auth()), baseEnv());
        expect(res.status).toBe(200);
        expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + "/api/scan/" + ok);
      });
    }

    const bad = [
      ["", "empty"], ["12345", "5 digits"], ["123456", "6 digits"], ["1234567", "7 digits"], ["123456789", "9 digits"], ["1234567890", "10 digits"], ["12345678901", "11 digits"], ["123456789012345", "15 digits"], ["abcdefgh", "letters"], ["12345a78", "a letter inside"],
      ["0-08274-00007-8", "hyphens"], ["008274%2000078", "an encoded space"], ["008274 000078", "a space"],
      ["..%2f..%2fadmin%2fsubscribers", "encoded traversal"], ["..%2F..%2Fadmin", "encoded traversal, upper case"], ["%2e%2e%2f%2e%2e%2fadmin", "encoded dots and slashes"],
      ["12345678%2f", "a trailing encoded slash"], ["12345678/", "a trailing slash"],
      ["12345678/extra", "an extra segment"], ["12345678%2fextra", "an encoded extra segment"], ["%31%32%33%34%35%36%37%38", "encoded digits"],
      ["12345678%00", "an encoded null"], ["12345678%0a", "an encoded newline"], ["-12345678", "a sign"], ["1.2345678", "a dot"], ["١٢٣٤٥٦٧٨", "non-ASCII digits"],
    ];
    for (const [code, what] of bad) {
      it(`${what} (${JSON.stringify(code)}) is this hop's 400 bad_code, nothing forwarded and nothing counted`, async () => {
        const env = baseEnv();
        const res = await worker.fetch(req("/api/scan/" + code, await auth()), env);
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.code).toBe("bad_code");
        expect(["not_digits", "wrong_length"]).toContain(body.reason);
        expect(res.headers.get("Cache-Control")).toBe("private, no-store");
        expect(upstreamCalls).toHaveLength(0);
        expect(rows(env.DB)).toEqual([]);
      });
    }

    it("dot segments are normalized away by the URL parser before routing (/api/scan/.. is /api/), so they are not this route and nothing is forwarded", async () => {
      const env = baseEnv();
      for (const code of ["..", "%2e%2e", ".", "%2e"]) {
        const res = await worker.fetch(req("/api/scan/" + code, await auth()), env);
        expect([400, 404]).toContain(res.status);
      }
      expect(upstreamCalls).toHaveLength(0);
      expect(rows(env.DB)).toEqual([]);
    });

    it("names the reason: wrong_length for digits of the wrong length, not_digits otherwise", async () => {
      expect((await (await worker.fetch(req("/api/scan/12345", await auth()), baseEnv())).json()).reason).toBe("wrong_length");
      expect((await (await worker.fetch(req("/api/scan/123abc456", await auth()), baseEnv())).json()).reason).toBe("not_digits");
    });

    it("a sibling path is not this route", async () => {
      for (const p of ["/api/scans/123456", "/api/scanx", "/api/scan-lookup/123456"]) {
        expect((await worker.fetch(req(p, await auth()), baseEnv())).status).toBe(404);
      }
      expect(upstreamCalls).toHaveLength(0);
    });
  });

  describe("ETag and 304", () => {
    it("forwards a sane If-None-Match and passes the ETag back with the 200", async () => {
      const res = await worker.fetch(req(ROUTE, { ...(await auth()), "If-None-Match": "\"abc123\"" }), baseEnv());
      expect(new Headers(upstreamCalls[0].init.headers).get("If-None-Match")).toBe("\"abc123\"");
      expect(res.headers.get("ETag")).toBe("\"abc123\"");
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
    });

    it("passes the upstream's 304 through with no body, the ETag, no-store, and one row logged as 304", async () => {
      upstreamStatus = 304;
      const env = baseEnv();
      const res = await worker.fetch(req(ROUTE, { ...(await auth()), "If-None-Match": "\"abc123\"" }), env);
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
      expect(res.headers.get("ETag")).toBe("\"abc123\"");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 304 }]);
    });

    it("drops an If-None-Match that is not printable ASCII or is too long (the upstream answers in full)", async () => {
      for (const inm of ["\"café\"", "x".repeat(600)]) {
        upstreamCalls.length = 0;
        await worker.fetch(req(ROUTE, { ...(await auth()), "If-None-Match": inm }), baseEnv());
        expect(new Headers(upstreamCalls[0].init.headers).has("If-None-Match")).toBe(false);
      }
    });

    it("sends no If-None-Match when the caller sent none", async () => {
      await worker.fetch(req(ROUTE, await auth()), baseEnv());
      expect(new Headers(upstreamCalls[0].init.headers).has("If-None-Match")).toBe(false);
    });
  });

  describe("the upstream's answers", () => {
    it("passes a 404 (SCAN_LOOKUP off, or an unknown code) through with its body", async () => {
      upstreamStatus = 404;
      upstreamBody = JSON.stringify({ error: "no product with that code", code: "not_found" });
      const env = baseEnv();
      const res = await worker.fetch(req(ROUTE, await auth()), env);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(JSON.parse(upstreamBody));
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 404 }]);
    });

    it("passes a 503 not_ready through with its body", async () => {
      upstreamStatus = 503;
      upstreamBody = JSON.stringify({ error: "scan data not ready", code: "not_ready", missing: ["branded_labels"], reason: "not_installed" });
      const res = await worker.fetch(req(ROUTE, await auth()), baseEnv());
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual(JSON.parse(upstreamBody));
    });

    it("passes a 503 busy through with its body and its Retry-After, and exposes Retry-After to a browser caller", async () => {
      upstreamStatus = 503;
      upstreamBody = JSON.stringify({ error: "scan data busy, try again", code: "not_ready", reason: "busy", retry_after_s: 2 });
      upstreamHeaders = { ...upstreamHeaders, "Retry-After": "2" };
      const env = baseEnv();
      const res = await worker.fetch(req(ROUTE, await auth()), env);
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("2");
      expect(await res.json()).toEqual(JSON.parse(upstreamBody));
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
      expect(rows(env.DB).map(r => r.status)).toEqual([503]);
    });

    it("passes the upstream's own 400 and 401 through", async () => {
      for (const status of [400, 401]) {
        upstreamStatus = status;
        upstreamBody = JSON.stringify({ error: "x" });
        const res = await worker.fetch(req(ROUTE, await auth()), baseEnv());
        expect(res.status).toBe(status);
        expect(await res.json()).toEqual({ error: "x" });
      }
    });

    it("of the upstream's headers only Content-Type, ETag and Retry-After cross; Cache-Control is always private, no-store", async () => {
      upstreamHeaders = { ...upstreamHeaders, "Retry-After": "7" };
      const res = await worker.fetch(req(ROUTE, await auth()), baseEnv());
      expect(res.headers.get("Retry-After")).toBe("7");
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Upstream-Banner")).toBeNull();
    });

    it("an upstream redirect is refused as a 502 and nothing of it crosses", async () => {
      upstreamStatus = 302;
      upstreamBody = "";
      upstreamHeaders = { Location: "https://evil.example/" };
      const env = baseEnv();
      const res = await worker.fetch(req(ROUTE, await auth()), env);
      expect(res.status).toBe(502);
      expect(res.headers.get("Location")).toBeNull();
      expect(rows(env.DB).map(r => r.status)).toEqual([502]);
    });

    it("an unreachable upstream is this hop's 502, no-store, logged as 502", async () => {
      upstreamThrows = true;
      const env = baseEnv();
      const res = await worker.fetch(req(ROUTE, await auth()), env);
      expect(res.status).toBe(502);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(rows(env.DB)).toEqual([{ path: LABEL, ip_hash: await callerHash(), status: 502 }]);
    });
  });

  it("answers GET only: POST, PUT and DELETE are not this route and call nothing upstream", async () => {
    for (const method of ["POST", "PUT", "DELETE"]) {
      expect((await worker.fetch(req(ROUTE, await auth(), method), baseEnv())).status).toBe(404);
    }
    expect(upstreamCalls).toHaveLength(0);
  });

  it("logs the label only: never the code, the account, the If-None-Match or any product text", async () => {
    const env = baseEnv();
    await worker.fetch(req(ROUTE, { ...(await auth()), "If-None-Match": "\"abc123\"" }), env);
    const all = env.DB.sqlite.prepare("SELECT * FROM engine_log").all();
    expect(all).toHaveLength(1);
    expect(all[0].path).toBe(LABEL);
    const text = JSON.stringify(all);
    for (const secret of [SUB, CODE, CODE.replace(/^0+/, ""), "8274", "abc123", "GINGER", "REED"]) expect(text).not.toContain(secret);
    expect(all[0].acct_hash).toBe(await acctKey(SUB));
  });

  it("writes nothing to the console either: no code in any log line", async () => {
    const spies = ["log", "info", "warn", "error", "debug"].map(k => vi.spyOn(console, k).mockImplementation(() => {}));
    await worker.fetch(req(ROUTE, await auth()), baseEnv());
    await worker.fetch(req("/api/scan/..%2fadmin", await auth()), baseEnv());
    const seen = JSON.stringify(spies.flatMap(s => s.mock.calls));
    expect(seen).not.toContain(CODE);
    spies.forEach(s => s.mockRestore());
  });

  describe("the ceiling", () => {
    it("is 360 an hour per account, 1080 for a listed tester, the address backstop twice the account figure", () => {
      expect(SCAN_PER_HOUR).toBe(360);
      expect(SCAN_PER_HOUR_DEV).toBe(1080);
      expect(SCAN_IP_FACTOR).toBe(2);
    });

    it("admits exactly the ceiling and then answers 429 with Retry-After, the account's scope, no-store, nothing forwarded", async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, SCAN_PER_HOUR - 1);
      expect((await worker.fetch(req(ROUTE, await auth()), env)).status).toBe(200);
      const res = await worker.fetch(req(ROUTE, await auth()), env);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("account");
      expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
      expect(res.headers.get("Cache-Control")).toBe("private, no-store");
      expect(upstreamCalls).toHaveLength(1);
    });

    it("a listed tester (ASK_DEV_SUBS or RECIPE_DEV_SUBS) gets the raised figure", async () => {
      const env = baseEnv({ ASK_DEV_SUBS: SUB });
      await seed(env.DB, LABEL, SCAN_PER_HOUR);
      expect((await worker.fetch(req(ROUTE, await auth()), env)).status).toBe(200);
      const env2 = baseEnv({ ASK_DEV_SUBS: "someone_else", RECIPE_DEV_SUBS: SUB });
      await seed(env2.DB, LABEL, SCAN_PER_HOUR);
      expect((await worker.fetch(req(ROUTE, await auth()), env2)).status).toBe(200);
      const env3 = baseEnv({ ASK_DEV_SUBS: SUB, RECIPE_DEV_SUBS: "none" });
      await seed(env3.DB, LABEL, SCAN_PER_HOUR);
      expect((await worker.fetch(req(ROUTE, await auth()), env3)).status).toBe(429);
      const env4 = baseEnv({ ASK_DEV_SUBS: SUB });
      await seed(env4.DB, LABEL, SCAN_PER_HOUR_DEV);
      expect((await worker.fetch(req(ROUTE, await auth()), env4)).status).toBe(429);
    });

    it("another account at the same address is not held by this account's count, until the address backstop", async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, SCAN_PER_HOUR);
      expect((await worker.fetch(req(ROUTE, await auth({ sub: "user_other_one" })), env)).status).toBe(200);
      const env2 = baseEnv();
      await seed(env2.DB, LABEL, SCAN_PER_HOUR * SCAN_IP_FACTOR, { subs: 20 });
      const res = await worker.fetch(req(ROUTE, await auth({ sub: "user_fresh_account" })), env2);
      expect(res.status).toBe(429);
      expect((await res.json()).scope).toBe("address");
    });

    it("is its own: other labels do not spend it, and it does not spend theirs", async () => {
      const env = baseEnv();
      await seed(env.DB, "/record/:item_id", RECORD_PER_HOUR);
      await seed(env.DB, "/common/item", 600);
      await seed(env.DB, "/common/feed", 300);
      expect((await worker.fetch(req(ROUTE, await auth()), env)).status).toBe(200);
    });

    it("the diet engine's ceiling does not count these rows (a full hour of scans leaves /api/engine open)", async () => {
      const env = baseEnv();
      await seed(env.DB, LABEL, ENGINE_PER_HOUR);
      const res = await worker.fetch(req("/api/engine/version", await auth()), env);
      expect(res.status).not.toBe(429);
    });
  });
});
