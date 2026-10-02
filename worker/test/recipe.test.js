import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, { RECIPE_PER_HOUR, RECIPE_PER_HOUR_DEV, withAccountId } from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB } from "./helpers.js";

const ISSUER = "https://crisp-scorpion-5272.clerk.accounts.dev";
const JWKS_URL = ISSUER + "/.well-known/jwks.json";
const ASK_UPSTREAM = "https://fresh-assistant-api.fly.dev";
const ASK_TOKEN = "svc-ask-token";

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

// One key for the whole file, for the same reason as engine.test.js: the module-level JWKS cache
// throttles refetching on an unknown kid.
let keyPair, kid, jwksDoc, upstreamCalls, upstreamStatus, upstreamBody;

beforeAll(async () => {
  keyPair = await generateTestKeyPair();
  kid = "recipe-test-kid";
  jwksDoc = await exportJwks(keyPair.publicKey, kid);
});

beforeEach(() => {
  upstreamCalls = [];
  upstreamStatus = 200;
  upstreamBody = JSON.stringify({ candidates: [{ title: "Soda bread" }], source: "url" });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init = {}) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.startsWith(JWKS_URL)) {
        return new Response(JSON.stringify(jwksDoc), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.startsWith(ASK_UPSTREAM)) {
        upstreamCalls.push({ url, init });
        return new Response(upstreamBody, {
          status: upstreamStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("unexpected fetch in test: " + url);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function validToken(claimOverrides = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  return signTestJWT(keyPair.privateKey, kid, {
    iss: ISSUER,
    sub: "user_test_recipe",
    exp: nowSec + 3600,
    nbf: nowSec - 10,
    iat: nowSec - 10,
    ...claimOverrides,
  });
}

function post(route, body, headers = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return new Request("https://worker.example" + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(bytes.byteLength),
      ...headers,
    },
    body: bytes,
  });
}

// The body a fetch stub was handed, as bytes. The Worker forwards a Uint8Array; a stream is
// drained, so a test reads the same thing either way.
function forwardedBytes(call) {
  const b = call.init.body;
  if (b instanceof Uint8Array) return b;
  if (typeof b === "string") return new TextEncoder().encode(b);
  throw new Error("unexpected upstream body type: " + Object.prototype.toString.call(b));
}
const forwardedJson = call => JSON.parse(new TextDecoder().decode(forwardedBytes(call)));

const ROUTES = ["/api/recipe/extract", "/api/recipe/transcribe", "/api/recipe/rate"];

describe("/api/recipe/* proxy", () => {
  describe("authentication", () => {
    for (const route of ROUTES) {
      it(`401s on ${route} with no Authorization header, never calling upstream`, async () => {
        const res = await worker.fetch(post(route, '{"url":"https://example.com/r"}'), baseEnv());
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
        expect(upstreamCalls.length).toBe(0);
      });
    }

    // Mirrors /api/ask: a bearer this server cannot check is our outage, a 503, never the 401 the
    // app shows a signed-in person as a sign-in problem.
    it("503s a bearer when Clerk is not configured, never calling upstream or claiming a slot", async () => {
      const token = await validToken();
      for (const missing of [{ CLERK_ISSUER: undefined }, { CLERK_JWKS_URL: undefined }]) {
        const env = baseEnv(missing);
        const res = await worker.fetch(
          post("/api/recipe/rate", '{"servings":1,"lines":[]}', { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "sign-in verification not configured",
          reason: "sign-in cannot be checked on this server right now; try again later",
        });
        expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM engine_log").get().n).toBe(0);
      }
      expect(upstreamCalls.length).toBe(0);
    });

    it("still 401s with no bearer when Clerk is not configured, so config state is not disclosed", async () => {
      const res = await worker.fetch(post("/api/recipe/rate", "{}"), baseEnv({ CLERK_ISSUER: undefined }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
    });

    for (const [label, jwksFetch] of [
      ["unreachable", async () => { throw new TypeError("network down"); }],
      ["answering 500", async () => new Response("nope", { status: 500 })],
    ]) {
      it(`503s, not 401s, when Clerk's JWKS is ${label}`, async () => {
        // A fresh module instance, so its JWKS cache is cold and must fetch (as in ask.test.js).
        vi.resetModules();
        const coldWorker = (await import("../src/index.js")).default;
        vi.stubGlobal("fetch", vi.fn(async (input) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.startsWith(JWKS_URL)) return jwksFetch();
          upstreamCalls.push({ url });
          return new Response("{}", { status: 200 });
        }));
        const token = await validToken();
        const env = baseEnv();
        const res = await coldWorker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
          error: "sign-in verification unavailable",
          reason: "sign-in cannot be checked right now; try again later",
        });
        expect(upstreamCalls.length).toBe(0);
        expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM engine_log").get().n).toBe(0);
      });
    }

    it("401s, not 503s, on a token signed by a key the JWKS does not hold", async () => {
      const other = await generateTestKeyPair();
      const nowSec = Math.floor(Date.now() / 1000);
      const forged = await signTestJWT(other.privateKey, kid, {
        iss: ISSUER, sub: "user_test_recipe", exp: nowSec + 3600, nbf: nowSec - 10, iat: nowSec - 10,
      });
      const res = await worker.fetch(
        post("/api/recipe/rate", "{}", { Authorization: `Bearer ${forged}` }), baseEnv());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls.length).toBe(0);
    });

    it("401s on an expired JWT", async () => {
      const token = await validToken({ exp: Math.floor(Date.now() / 1000) - 60 });
      const res = await worker.fetch(
        post("/api/recipe/extract", "{}", { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls.length).toBe(0);
    });

    it("401s on a garbage bearer (e.g. the service token itself)", async () => {
      const res = await worker.fetch(
        post("/api/recipe/rate", "{}", { Authorization: `Bearer ${ASK_TOKEN}` }), baseEnv());
      expect(res.status).toBe(401);
      expect(upstreamCalls.length).toBe(0);
    });
  });

  describe("configuration", () => {
    it("401s an anonymous caller when ASK_UPSTREAM is unset, so config state is not disclosed", async () => {
      const res = await worker.fetch(post("/api/recipe/extract", "{}"), baseEnv({ ASK_UPSTREAM: undefined }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
    });

    it("503s an authenticated caller when ASK_UPSTREAM is unset", async () => {
      const token = await validToken();
      const res = await worker.fetch(
        post("/api/recipe/extract", "{}", { Authorization: `Bearer ${token}` }),
        baseEnv({ ASK_UPSTREAM: undefined }));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        error: "recipe service not configured",
        reason: "recipe service is not configured on this server",
      });
      expect(upstreamCalls.length).toBe(0);
    });

    it("503s when ASK_TOKEN is unset", async () => {
      const token = await validToken();
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }),
        baseEnv({ ASK_TOKEN: undefined }));
      expect(res.status).toBe(503);
      expect(upstreamCalls.length).toBe(0);
    });
  });

  describe("forwarding", () => {
    for (const route of ROUTES) {
      it(`${route}: upstream gets the service bearer, never the caller's JWT, and the body with only account_id added`, async () => {
        const token = await validToken();
        const payload = JSON.stringify({ url: "https://example.com/soda-bread", note: "café — ½ cup" });
        const res = await worker.fetch(
          post(route, payload, { Authorization: `Bearer ${token}` }), baseEnv());

        expect(res.status).toBe(200);
        expect(upstreamCalls.length).toBe(1);
        const call = upstreamCalls[0];
        expect(call.url).toBe(ASK_UPSTREAM + route);
        expect(call.init.method).toBe("POST");
        expect(call.init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
        expect(call.init.headers.get("Authorization")).not.toContain(token);
        expect(call.init.headers.get("Content-Type")).toBe("application/json");
        // Every byte after the opening brace is the caller's, unchanged: the body is not
        // re-serialised when it carries no account_id of its own.
        const forwarded = forwardedBytes(call);
        const prefix = new TextEncoder().encode('{"account_id":"user_test_recipe",');
        expect(Array.from(forwarded)).toEqual(
          [...prefix, ...new TextEncoder().encode(payload).subarray(1)]);
        expect(JSON.parse(new TextDecoder().decode(forwarded))).toEqual(
          { account_id: "user_test_recipe", ...JSON.parse(payload) });
      });
    }

    it("transcribe: a base64 image payload arrives byte-for-byte behind the account_id", async () => {
      const token = await validToken();
      // Every byte value, so the base64 alphabet (+, /, =) is fully exercised.
      const raw = new Uint8Array(3000).map((_, i) => (i * 7919) % 256);
      let bin = "";
      for (const b of raw) bin += String.fromCharCode(b);
      const payload = JSON.stringify({ images: [{ data: btoa(bin), media_type: "image/jpeg" }] });
      const bytes = new TextEncoder().encode(payload);

      const res = await worker.fetch(
        post("/api/recipe/transcribe", bytes, { Authorization: `Bearer ${token}` }), baseEnv());

      expect(res.status).toBe(200);
      const forwarded = forwardedBytes(upstreamCalls[0]);
      const prefix = new TextEncoder().encode('{"account_id":"user_test_recipe",');
      expect(forwarded.byteLength).toBe(prefix.byteLength + bytes.byteLength - 1);
      expect(Array.from(forwarded.subarray(prefix.byteLength))).toEqual(Array.from(bytes.subarray(1)));
      expect(JSON.parse(new TextDecoder().decode(forwarded)).images[0].data).toBe(btoa(bin));
    });

    it("never forwards an inbound X-Fresh-User or Cookie header", async () => {
      const token = await validToken();
      await worker.fetch(post("/api/recipe/extract", "{}", {
        Authorization: `Bearer ${token}`, "X-Fresh-User": "user_forged", Cookie: "a=b",
      }), baseEnv());
      const h = upstreamCalls[0].init.headers;
      expect(h.get("X-Fresh-User")).toBeNull();
      expect(h.get("Cookie")).toBeNull();
    });
  });

  // ── account_id comes only from the verified sub, as on /api/ask ──────────────────────────────
  describe("account_id", () => {
    const sentText = call => new TextDecoder().decode(forwardedBytes(call));

    for (const route of ROUTES) {
      it(`${route}: forwards the verified sub as account_id when the body has none`, async () => {
        const token = await validToken();
        await worker.fetch(post(route, '{"servings":2,"lines":[{"qty":"1","unit":"cup","text":"flour"}]}',
          { Authorization: `Bearer ${token}` }), baseEnv());
        const sent = forwardedJson(upstreamCalls[0]);
        expect(sent.account_id).toBe("user_test_recipe");
        expect(sent.lines).toEqual([{ qty: "1", unit: "cup", text: "flour" }]);
      });

      it(`${route}: overwrites a different account_id the body asserts`, async () => {
        const token = await validToken();
        await worker.fetch(post(route, '{"account_id":"user_2victim","servings":2,"lines":[]}',
          { Authorization: `Bearer ${token}` }), baseEnv());
        expect(forwardedJson(upstreamCalls[0])).toEqual({ account_id: "user_test_recipe", servings: 2, lines: [] });
        expect(sentText(upstreamCalls[0])).not.toContain("user_2victim");
      });
    }

    it("overwrites an account_id key spelled with a JSON escape, which the upstream would decode", async () => {
      const token = await validToken();
      // Built at runtime so no editor or tool can fold the escape back into a plain key.
      const key = "account" + "\\u005f" + "id";
      const body = `{"${key}":"user_2victim","servings":1,"lines":[]}`;
      expect(body).toContain("\\u005f");
      await worker.fetch(post("/api/recipe/rate", body, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(forwardedJson(upstreamCalls[0]).account_id).toBe("user_test_recipe");
      expect(sentText(upstreamCalls[0])).not.toContain("user_2victim");
    });

    it("overwrites every copy of a duplicated account_id key, not just the one JSON.parse kept", async () => {
      const token = await validToken();
      await worker.fetch(post("/api/recipe/rate",
        '{"account_id":"user_2a","servings":1,"account_id":"user_2b","lines":[]}',
        { Authorization: `Bearer ${token}` }), baseEnv());
      expect(forwardedJson(upstreamCalls[0])).toEqual({ account_id: "user_test_recipe", servings: 1, lines: [] });
      expect(sentText(upstreamCalls[0])).not.toMatch(/user_2a|user_2b/);
    });

    it("overwrites a non-string account_id (an object, null, a number) too", async () => {
      const token = await validToken();
      for (const v of ['{"id":"user_2victim"}', "null", "12"]) {
        upstreamCalls = [];
        await worker.fetch(post("/api/recipe/rate", `{"account_id":${v},"servings":1,"lines":[]}`,
          { Authorization: `Bearer ${token}` }), baseEnv());
        expect(forwardedJson(upstreamCalls[0]).account_id).toBe("user_test_recipe");
      }
    });

    it("removes a body account_id, and adds none, when the verified sub is not a forwardable shape", async () => {
      const token = await validToken({ sub: "user with spaces" });
      const res = await worker.fetch(post("/api/recipe/rate", '{"account_id":"user_2victim","servings":1,"lines":[]}',
        { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(200);
      expect(forwardedJson(upstreamCalls[0])).toEqual({ servings: 1, lines: [] });
    });

    it("forwards the body unchanged when the sub is not forwardable and the body has no account_id", async () => {
      const token = await validToken({ sub: "user with spaces" });
      const payload = '{"servings":1,"lines":[]}';
      await worker.fetch(post("/api/recipe/rate", payload, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(sentText(upstreamCalls[0])).toBe(payload);
    });

    it("leaves a nested account_id alone: the upstream reads the top level only", async () => {
      const token = await validToken();
      await worker.fetch(post("/api/recipe/rate", '{"servings":1,"lines":[{"text":"x","account_id":"n"}]}',
        { Authorization: `Bearer ${token}` }), baseEnv());
      const sent = forwardedJson(upstreamCalls[0]);
      expect(sent.account_id).toBe("user_test_recipe");
      expect(sent.lines[0].account_id).toBe("n");
    });

    it("keeps a __proto__ key as an ordinary key when the body is rebuilt", async () => {
      const token = await validToken();
      await worker.fetch(post("/api/recipe/rate", '{"account_id":"x","__proto__":{"polluted":1},"servings":1}',
        { Authorization: `Bearer ${token}` }), baseEnv());
      expect(sentText(upstreamCalls[0]))
        .toBe('{"account_id":"user_test_recipe","__proto__":{"polluted":1},"servings":1}');
      expect({}.polluted).toBeUndefined();
    });

    it("tolerates leading whitespace and a UTF-8 BOM before the brace", async () => {
      const token = await validToken();
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(' \n {"servings":1}')]);
      const res = await worker.fetch(post("/api/recipe/rate", bytes, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(200);
      expect(sentText(upstreamCalls[0])).toBe('{"account_id":"user_test_recipe","servings":1}');
    });

    it("drops a leading BOM even when the body is otherwise forwarded unchanged", () => {
      const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"lines":["x"]}')]);
      expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(withAccountId(bytes, null))).toBe('{"lines":["x"]}');
    });

    it("an empty object gains the account_id and stays valid JSON", async () => {
      const token = await validToken();
      await worker.fetch(post("/api/recipe/extract", " { } ", { Authorization: `Bearer ${token}` }), baseEnv());
      expect(sentText(upstreamCalls[0])).toBe('{"account_id":"user_test_recipe"}');
    });

    it("never writes the account_id or the sub into engine_log", async () => {
      const token = await validToken();
      const env = baseEnv();
      await worker.fetch(post("/api/recipe/rate", '{"account_id":"user_2victim","servings":1,"lines":[]}',
        { Authorization: `Bearer ${token}` }), env);
      const everything = JSON.stringify(env.DB.calls) +
        JSON.stringify(env.DB.sqlite.prepare("SELECT * FROM engine_log").all());
      expect(everything).not.toContain("user_test_recipe");
      expect(everything).not.toContain("user_2victim");
    });
  });

  // ── A body that is not a JSON object is refused here, never passed through unmodified ──────
  describe("request body", () => {
    const BAD = [
      ["not JSON", "url=https://example.com"],
      ["truncated JSON", '{"servings":1,'],
      ["empty", ""],
      ["a JSON array", '[{"servings":1}]'],
      ["JSON null", "null"],
      ["a JSON string", '"{}"'],
      ["a JSON number", "42"],
    ];
    for (const [label, body] of BAD) {
      it(`400s a body that is ${label}, never calling upstream, and counts the attempt as 400`, async () => {
        const token = await validToken();
        const env = baseEnv();
        const res = await worker.fetch(post("/api/recipe/rate", body, { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid request body", reason: "request body must be a JSON object" });
        expect(upstreamCalls.length).toBe(0);
        expect(env.DB.sqlite.prepare("SELECT path, status FROM engine_log").all())
          .toEqual([{ path: "/recipe/rate", status: 400 }]);
      });
    }

    it("400s a body that is not valid UTF-8, rather than forwarding replacement characters", async () => {
      const token = await validToken();
      const enc = new TextEncoder();
      const bytes = new Uint8Array([...enc.encode('{"title":"caf'), 0xe9, ...enc.encode('"}')]);
      const res = await worker.fetch(post("/api/recipe/rate", bytes, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(400);
      expect(upstreamCalls.length).toBe(0);
    });

    it("a caller at the ceiling gets the 429, not a 400, and its body is never read", async () => {
      const token = await validToken();
      const env = baseEnv();
      const day = new Date().toISOString().slice(0, 10);
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("0.0.0.0|" + day));
      const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
      const ins = env.DB.sqlite.prepare("INSERT INTO engine_log (path, ip_hash, status) VALUES (?, ?, 200)");
      for (let i = 0; i < RECIPE_PER_HOUR; i++) ins.run("/recipe/rate", hash);
      const req = post("/api/recipe/rate", "not json", { Authorization: `Bearer ${token}` });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(429);
      expect(req.bodyUsed).toBe(false);
    });
  });

  // withAccountId is a hand-written JSON scanner, so it is checked against JSON.parse directly: it
  // must accept exactly what JSON.parse accepts (as a top-level object), and its output must parse
  // to the caller's body with the top-level account_id replaced.
  describe("withAccountId agrees with JSON.parse", () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    function expected(text, sub) {
      let v;
      try { v = JSON.parse(text.replace(/^\uFEFF/, "")); } catch { return null; }
      if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
      const { account_id: _x, ...rest } = v;
      return sub ? { account_id: sub, ...rest } : rest;
    }
    function check(text, sub = "user_x") {
      const out = withAccountId(enc.encode(text), sub);
      const want = expected(text, sub);
      if (want === null) {
        expect(out, text).toBeNull();
      } else {
        expect(out, text).not.toBeNull();
        const got = JSON.parse(dec.decode(out));
        expect(got, text).toEqual(want);
        expect(Object.keys(got), text).toEqual(Object.keys(want));
      }
    }
    const B = "\\";
    const CASES = [
      "{}", " {} ", "{ }", "\uFEFF{}", "{}x", "{}{}", "{", "}", "", " ", "[]", "null", "1", '"s"',
      '{"a":1}', '{"a":1,}', '{,"a":1}', '{"a":1 "b":2}', '{"a" 1}', "{a:1}", "{'a':1}", '{"a":}',
      '{"a":-0}', '{"a":-}', '{"a":01}', '{"a":1.}', '{"a":.5}', '{"a":1e}', '{"a":1e+}', '{"a":1E-7}',
      '{"a":12.50e3}', '{"a":+1}', '{"a":0x1}', '{"a":Infinity}', '{"a":NaN}',
      '{"a":true,"b":false,"c":null}', '{"a":tru}', '{"a":nul}', '{"a":True}',
      '{"a":[]}', '{"a":[1,]}', '{"a":[,1]}', '{"a":[1 2]}', '{"a":[[[]]]}', '{"a":[[[]]}', '{"a":[{}]}',
      '{"a":{"b":{"c":{}}}}', '{"a":{"b":}}', '{"a":{"b":1,}}', '{"a":{]}', '{"a":[}]}',
      `{"a":"${B}u0041${B}n${B}t${B}"${B}${B}${B}/${B}b${B}f${B}r"}`, `{"a":"${B}x41"}`,
      `{"a":"${B}u00G1"}`, `{"a":"${B}u12"}`, `{"a":"${B}uD800"}`,
      '{"a":"tab\there"}', '{"a":"nl\nhere"}', '{"a":"caf\u00e9 \u00bd \u{1F35E}"}',
      '{"a":"unterminated}', `{"a${B}"b":1}`,
      '{"account_id":"v"}', '{"account_id":"v","a":1}', '{"a":1,"account_id":"v"}',
      '{"account_id":1,"account_id":2}', `{"account${B}u005fid":"v","a":2}`, `{"${B}u0061ccount_id":"v"}`,
      '{"account_id ":"v"}', '{"Account_id":"v"}', '{"a":{"account_id":"nested"}}',
      '{"__proto__":{"p":1},"account_id":"v"}', ' \r\n\t{ "a" : [ 1 , { "b" : null } ] } \n',
    ];
    for (const sub of ["user_x", null]) {
      it(`fixed corpus (${sub ? "with" : "without"} a sub)`, () => { for (const t of CASES) check(t, sub); });
    }

    it("random single-character mutations of every valid case", () => {
      let seed = 12345;
      const rand = k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
      const ALPH = '{}[]",:01-.eE \\u/aAtrnfl\u00e9';
      let n = 0;
      for (const base of CASES.filter(t => expected(t, "s") !== null)) {
        for (let r = 0; r < 200; r++) {
          const arr = [...base];
          const op = rand(3), at = rand(arr.length + 1), ch = ALPH[rand(ALPH.length)];
          if (op === 0) arr.splice(at, 0, ch);
          else if (op === 1) arr.splice(at, 1);
          else arr[at] = ch;
          check(arr.join(""));
          n++;
        }
      }
      expect(n).toBeGreaterThan(5000);
    }, 60000);

    it("rejects malformed UTF-8 inside a string (overlong, surrogate, truncated, stray byte)", () => {
      const wrap = bad => new Uint8Array([...enc.encode('{"a":"'), ...bad, ...enc.encode('"}')]);
      for (const bad of [[0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80],
                         [0xe2, 0x82], [0x80], [0xff], [0xf8, 0x88, 0x80, 0x80, 0x80]]) {
        expect(withAccountId(wrap(bad), "user_x")).toBeNull();
      }
      for (const ok of [[0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x8d, 0x9e], [0xef, 0xbf, 0xbf]]) {
        expect(withAccountId(wrap(ok), "user_x")).not.toBeNull();
      }
    });
  });

  // Shapes whose JSON.parse cost is far out of proportion to their byte count (from code review):
  // the scanner holds no per-element state, and the route answers them as the upstream would.
  describe("withAccountId on pathological shapes", () => {
    it("~3.4M empty objects in 10 MB: forwarded with only the account_id added", () => {
      const body = '{"a":[' + "{},".repeat(3_400_000) + "{}]}";
      const out = withAccountId(new TextEncoder().encode(body), "user_x");
      expect(out.byteLength).toBe(body.length + '"account_id":"user_x",'.length);
    });

    it("2M-deep nesting alongside an account_id: rewritten, not a stack overflow", () => {
      const body = '{"account_id":1,"a":' + "[".repeat(2_000_000) + "]".repeat(2_000_000) + "}";
      const out = withAccountId(new TextEncoder().encode(body), "user_x");
      expect(new TextDecoder().decode(out.subarray(0, 30))).toBe('{"account_id":"user_x","a":[[[');
      expect(out.byteLength).toBe(body.length + '"user_x"'.length - 1);
    });

    it("the route forwards a 2M-deep body carrying account_id rather than answering 502", async () => {
      const token = await validToken();
      const body = '{"account_id":1,"a":' + "[".repeat(2_000_000) + "]".repeat(2_000_000) + "}";
      const res = await worker.fetch(post("/api/recipe/rate", body, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(200);
      expect(upstreamCalls.length).toBe(1);
    });
  });

  describe("withAccountId at the 10 MiB cap", () => {
    function capBody(extra = "") {
      const head = '{"images":[{"media_type":"image/jpeg","data":"';
      const tail = '"}]' + extra + "}";
      return new TextEncoder().encode(head + "A".repeat(10 * 1024 * 1024 - head.length - tail.length) + tail);
    }
    it("adds the sub, copying the photo bytes unchanged", () => {
      const bytes = capBody();
      const out = withAccountId(bytes, "user_x");
      expect(out.byteLength).toBe(bytes.byteLength + '"account_id":"user_x",'.length);
      expect(Array.from(out.subarray(out.byteLength - 1000))).toEqual(Array.from(bytes.subarray(bytes.byteLength - 1000)));
    });
    it("drops a client account_id from a body of that size", () => {
      const parsed = JSON.parse(new TextDecoder().decode(withAccountId(capBody(',"account_id":"forged"'), "user_x")));
      expect(parsed.account_id).toBe("user_x");
      expect(parsed.images[0].data.length).toBeGreaterThan(10_000_000);
    });
  });

  describe("size cap", () => {
    it("413s one byte over the engine route's cap, never calling upstream", async () => {
      const token = await validToken();
      const req = new Request("https://worker.example/api/recipe/transcribe", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": String(10 * 1024 * 1024 + 1),
        },
        body: new Uint8Array(1),
      });
      const res = await worker.fetch(req, baseEnv());
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "request body too large", reason: "photos too large; send fewer or smaller photos" });
      expect(upstreamCalls.length).toBe(0);
    });

    // A body with no Content-Length is counted as it streams. The upstream stub drains what it
    // is sent, as a real upstream would, so the cut-off surfaces as a failed fetch.
    // The streamed body is a JSON object padded with base64-alphabet filler to `totalBytes`, so
    // one under the cap is valid and forwarded.
    function chunkedReq(token, totalBytes, chunkBytes = 1024 * 1024) {
      const enc = new TextEncoder();
      const head = enc.encode('{"images":[{"media_type":"image/jpeg","data":"');
      const tail = enc.encode('"}]}');
      const fill = totalBytes - head.byteLength - tail.byteLength;
      const parts = [head];
      for (let left = fill; left > 0; left -= chunkBytes) parts.push(new Uint8Array(Math.min(chunkBytes, left)).fill(0x41));
      parts.push(tail);
      const body = new ReadableStream({
        pull(controller) {
          if (!parts.length) return controller.close();
          controller.enqueue(parts.shift());
        },
      });
      return new Request("https://worker.example/api/recipe/transcribe", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body,
        duplex: "half",
      });
    }
    function drainingUpstream() {
      vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        upstreamCalls.push({ url, init, received: init.body ? forwardedBytes({ init }).byteLength : 0 });
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }));
    }

    it("413s a chunked body that streams past the cap, never calling upstream, recording the attempt as 413", async () => {
      drainingUpstream();
      const token = await validToken();
      const env = baseEnv();
      const req = chunkedReq(token, 10 * 1024 * 1024 + 1);
      expect(req.headers.get("Content-Length")).toBeNull();
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "request body too large", reason: "photos too large; send fewer or smaller photos" });
      expect(upstreamCalls.length).toBe(0);
      expect(env.DB.sqlite.prepare("SELECT path, status FROM engine_log").all())
        .toEqual([{ path: "/recipe/transcribe", status: 413 }]);
    });

    it("forwards a chunked body under the cap, with only the account_id added", async () => {
      drainingUpstream();
      const token = await validToken();
      const res = await worker.fetch(chunkedReq(token, 3 * 1024 * 1024 + 7), baseEnv());
      expect(res.status).toBe(200);
      expect(upstreamCalls[0].received)
        .toBe(3 * 1024 * 1024 + 7 + '"account_id":"user_test_recipe",'.length);
    });

    it("forwards a chunked body of exactly the cap", async () => {
      drainingUpstream();
      const token = await validToken();
      const res = await worker.fetch(chunkedReq(token, 10 * 1024 * 1024), baseEnv());
      expect(res.status).toBe(200);
      expect(upstreamCalls.length).toBe(1);
    });
  });

  describe("upstream passthrough", () => {
    for (const status of [400, 500, 503]) {
      it(`passes an upstream ${status} through with its body unchanged`, async () => {
        upstreamStatus = status;
        upstreamBody = JSON.stringify({ error: `upstream said ${status}`, reason: "model pass disabled" });
        const token = await validToken();
        const res = await worker.fetch(
          post("/api/recipe/extract", '{"url":"x"}', { Authorization: `Bearer ${token}` }), baseEnv());
        expect(res.status).toBe(status);
        expect(await res.text()).toBe(upstreamBody);
      });
    }

    it("passes back only Content-Type and Retry-After from the upstream's headers", async () => {
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        const headers = new Headers({
          "Content-Type": "application/json",
          "Retry-After": "120",
          "X-Upstream-Banner": "fresh-assistant-api/1.2.3",
          "Content-Encoding": "identity",
        });
        headers.append("Set-Cookie", "session=upstream-secret");
        return new Response('{"error":"busy"}', { status: 503, headers });
      }));
      const token = await validToken();
      const res = await worker.fetch(post("/api/recipe/extract", '{"url":"x"}', {
        Authorization: `Bearer ${token}`, Origin: "http://localhost:8081",
      }), baseEnv());
      expect(res.status).toBe(503);
      expect(res.headers.get("Content-Type")).toBe("application/json");
      expect(res.headers.get("Retry-After")).toBe("120");
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(res.headers.get("X-Upstream-Banner")).toBeNull();
      expect(res.headers.get("Content-Encoding")).toBeNull();
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    });

    it("502s when the upstream is unreachable", async () => {
      const token = await validToken();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new TypeError("network down");
      }));
      const res = await worker.fetch(
        post("/api/recipe/rate", "{}", { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: "recipe service unreachable",
        reason: "recipe service did not respond; try again later",
      });
    });
  });

  describe("logging and the ceiling", () => {
    // The hash the Worker computes for a request with no CF-Connecting-IP, so a test can seed
    // rows that count against the same caller.
    async function callerHash() {
      const day = new Date().toISOString().slice(0, 10);
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("0.0.0.0|" + day));
      return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
    }
    async function seed(db, path, n) {
      const hash = await callerHash();
      const ins = db.sqlite.prepare("INSERT INTO engine_log (path, ip_hash, status) VALUES (?, ?, 200)");
      for (let i = 0; i < n; i++) ins.run(path, hash);
    }
    const rows = db => db.sqlite.prepare("SELECT path, ip_hash, status FROM engine_log ORDER BY id").all();

    it("writes only the route label and status to engine_log — no URL, body, or sub", async () => {
      upstreamStatus = 422;
      const token = await validToken();
      const env = baseEnv();
      const secretUrl = "https://private.example/my-grandmothers-recipe";
      await worker.fetch(post("/api/recipe/extract", JSON.stringify({ url: secretUrl }),
        { Authorization: `Bearer ${token}` }), env);

      const logged = rows(env.DB);
      expect(logged.length).toBe(1);
      expect(logged[0].path).toBe("/recipe/extract");
      expect(logged[0].status).toBe(422);
      expect(logged[0].ip_hash).toMatch(/^[0-9a-f]{24}$/);
      const everything = JSON.stringify(env.DB.calls) + JSON.stringify(logged);
      expect(everything).not.toContain(secretUrl);
      expect(everything).not.toContain("user_test_recipe");
    });

    it("429s at the ceiling, never calling upstream or adding a row", async () => {
      const token = await validToken();
      const env = baseEnv();
      await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(res.status).toBe(429);
      // recipeService.ts shows `reason` in its withheld state; `error` stays for parity.
      expect(await res.json()).toEqual({
        error: "too many requests — try again later",
        reason: `recipe limit reached (${RECIPE_PER_HOUR} per hour); try again later`,
      });
      expect(upstreamCalls.length).toBe(0);
      expect(rows(env.DB).length).toBe(RECIPE_PER_HOUR);
    });

    describe("development ceiling (RECIPE_DEV_SUBS)", () => {
      // Josh, 2026-09-30: "Keep per-address". A listed, verified sub gets a higher ceiling on the
      // same IP-hash key; nothing else about the route changes.
      it("a listed sub gets RECIPE_PER_HOUR_DEV on the same IP-hash key", async () => {
        const token = await validToken();
        const env = baseEnv({ RECIPE_DEV_SUBS: "user_other, user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(200);
        const logged = rows(env.DB);
        expect(logged.length).toBe(RECIPE_PER_HOUR + 1);
        expect(logged.at(-1).ip_hash).toBe(await callerHash());
        expect(JSON.stringify(env.DB.calls) + JSON.stringify(logged)).not.toContain("user_test_recipe");
      });

      it("a listed sub still stops at RECIPE_PER_HOUR_DEV, with the raised figure in `reason`", async () => {
        const token = await validToken();
        const env = baseEnv({ RECIPE_DEV_SUBS: "user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR_DEV);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(429);
        expect((await res.json()).reason)
          .toBe(`recipe limit reached (${RECIPE_PER_HOUR_DEV} per hour); try again later`);
        expect(upstreamCalls.length).toBe(0);
      });

      it("RECIPE_DEV_SUBS unset: falls back to ASK_DEV_SUBS, one tester list for both ceilings", async () => {
        const token = await validToken();
        const env = baseEnv({ ASK_DEV_SUBS: "user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(200);
      });

      it("RECIPE_DEV_SUBS unset and ASK_DEV_SUBS not listing the caller: the fallback grants nothing", async () => {
        const token = await validToken();
        const env = baseEnv({ ASK_DEV_SUBS: "user_other" });
        await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
        const res = await worker.fetch(
          post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(429);
      });

      for (const [label, subs] of [["set to another list", "user_other"], ["set to empty", ""], ["set to the sentinel", "none"]]) {
        it(`RECIPE_DEV_SUBS ${label}: it overrides ASK_DEV_SUBS for this route`, async () => {
          const token = await validToken();
          const env = baseEnv({ ASK_DEV_SUBS: "user_test_recipe", RECIPE_DEV_SUBS: subs });
          await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
          const res = await worker.fetch(
            post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
          expect(res.status).toBe(429);
        });
      }

      for (const [label, subs] of [["unset", undefined], ["empty", " , "], ["not listing the caller", "user_other"]]) {
        it(`RECIPE_DEV_SUBS ${label}: the public ceiling applies, same 429 body`, async () => {
          const token = await validToken();
          const env = baseEnv({ RECIPE_DEV_SUBS: subs });
          await seed(env.DB, "/recipe/transcribe", RECIPE_PER_HOUR);
          const res = await worker.fetch(
            post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
          expect(res.status).toBe(429);
          expect(await res.json()).toEqual({
            error: "too many requests — try again later",
            reason: `recipe limit reached (${RECIPE_PER_HOUR} per hour); try again later`,
          });
        });
      }
    });

    it("concurrent requests cannot overshoot the ceiling while earlier calls are in flight", async () => {
      // 28 used, 2 left. Ten requests arrive together and the upstream holds every call open until
      // all ten have been dispatched — the window in which a count-then-log-later check lets all
      // ten through.
      const token = await validToken();
      const env = baseEnv();
      await seed(env.DB, "/recipe/rate", 28);
      let release;
      const gate = new Promise(r => { release = r; });
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        upstreamCalls.push({ url });
        await gate;
        return new Response("{}", { status: 200 });
      }));
      const pending = Array.from({ length: 10 }, () => worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env));
      await new Promise(r => setTimeout(r, 50));
      release();
      const statuses = (await Promise.all(pending)).map(r => r.status).sort();
      expect(statuses.filter(s => s === 200).length).toBe(2);
      expect(statuses.filter(s => s === 429).length).toBe(8);
      expect(upstreamCalls.length).toBe(2);
      expect(rows(env.DB).length).toBe(30);
    });

    it("the ceiling check and the claim are ONE statement, issued before the upstream call", async () => {
      // node:sqlite runs synchronously, so the concurrency test above passes for a check-then-
      // insert pair too; atomicity in D1 rests on the claim being a single statement. Pin that.
      const token = await validToken();
      const env = baseEnv();
      let callsAtUpstream = null;
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        callsAtUpstream = env.DB.calls.map(c => c.sql);
        return new Response("{}", { status: 200 });
      }));
      await worker.fetch(post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(callsAtUpstream).toHaveLength(1);
      expect(callsAtUpstream[0]).toMatch(/^INSERT INTO engine_log .* SELECT .* WHERE \(SELECT COUNT\(\*\) FROM engine_log/s);
    });

    it("an attempt that ends in 502 still counts, with status 502", async () => {
      const token = await validToken();
      const env = baseEnv();
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      }));
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(res.status).toBe(502);
      expect(rows(env.DB)).toEqual([{ path: "/recipe/transcribe", ip_hash: await callerHash(), status: 502 }]);
    });

    it("a failed status write never discards the upstream's response", async () => {
      const token = await validToken();
      const env = baseEnv({ DB: makeSqliteDB({ failOn: /^UPDATE/ }) });
      const res = await worker.fetch(
        post("/api/recipe/transcribe", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(upstreamBody);
      // The claim stands, so the attempt still counts; only its status is missing.
      expect(rows(env.DB)).toEqual([{ path: "/recipe/transcribe", ip_hash: await callerHash(), status: null }]);
    });

    it("the two ceilings are independent: engine rows never count against recipe, nor recipe against engine", async () => {
      const token = await validToken();
      const env = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env.DB, "/version", 60);            // engine ceiling spent
      const recipe = await worker.fetch(
        post("/api/recipe/rate", "{}", { Authorization: `Bearer ${token}` }), env);
      expect(recipe.status).toBe(200);

      const env2 = baseEnv({ ENGINE_UPSTREAM: "https://engine.example", ENGINE_TOKEN: "e" });
      await seed(env2.DB, "/recipe/rate", 30);       // recipe ceiling spent
      vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
        return new Response("{}", { status: 200 });
      }));
      const engine = await worker.fetch(new Request("https://worker.example/api/engine/version", {
        headers: { Authorization: `Bearer ${token}` },
      }), env2);
      expect(engine.status).toBe(200);
    });
  });

  describe("routing and CORS", () => {
    it("404s an unknown recipe route and a GET, never calling upstream", async () => {
      const token = await validToken();
      const r1 = await worker.fetch(post("/api/recipe/delete", "{}", { Authorization: `Bearer ${token}` }), baseEnv());
      const r2 = await worker.fetch(new Request("https://worker.example/api/recipe/extract", {
        headers: { Authorization: `Bearer ${token}` },
      }), baseEnv());
      expect(r1.status).toBe(404);
      expect(r2.status).toBe(404);
      expect(upstreamCalls.length).toBe(0);
    });

    it("a preflight from the app's web build is allowed to send Authorization", async () => {
      const res = await worker.fetch(new Request("https://worker.example/api/recipe/extract", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:8081",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      }), baseEnv());
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
      expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    });

    it("adds the Worker's CORS headers on top of the upstream response", async () => {
      const token = await validToken();
      const res = await worker.fetch(post("/api/recipe/extract", "{}", {
        Authorization: `Bearer ${token}`, Origin: "http://localhost:8081",
      }), baseEnv());
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:8081");
    });
  });
});
