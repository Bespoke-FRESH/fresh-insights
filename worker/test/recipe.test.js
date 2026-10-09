import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import worker, { RECIPE_PER_HOUR, RECIPE_PER_HOUR_DEV, withAccountId, insertAccountId } from "../src/index.js";
import { generateTestKeyPair, exportJwks, signTestJWT, makeSqliteDB, readAllBytes } from "./helpers.js";

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
        // Drain a streamed body as a real upstream would; a stream the Worker errors (over the
        // cap, not an object) makes this throw, as a failed upload makes fetch throw.
        const bytes = init.body instanceof ReadableStream ? await readAllBytes(init.body) : undefined;
        upstreamCalls.push({ url, init, bytes });
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
  if (call.bytes) return call.bytes;
  const b = call.init.body;
  if (b instanceof Uint8Array) return b;
  if (typeof b === "string") return new TextEncoder().encode(b);
  throw new Error("unexpected upstream body type: " + Object.prototype.toString.call(b));
}
const forwardedJson = call => JSON.parse(new TextDecoder().decode(forwardedBytes(call)));

const ROUTES = ["/api/recipe/extract", "/api/recipe/transcribe", "/api/recipe/transcribe-video", "/api/recipe/rate"];
// The routes that carry media and so take the insertion path (insertAccountId), not the full scan.
const MEDIA_ROUTES = ["/api/recipe/transcribe", "/api/recipe/transcribe-video"];

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
        // The caller's bytes, unchanged, with only the account_id member added: first on
        // extract/rate (withAccountId), last on the media routes (insertAccountId).
        const forwarded = forwardedBytes(call);
        const enc = new TextEncoder();
        const want = MEDIA_ROUTES.includes(route)
          ? [...enc.encode(payload).subarray(0, -1), ...enc.encode(',"account_id":"user_test_recipe"}')]
          : [...enc.encode('{"account_id":"user_test_recipe",'), ...enc.encode(payload).subarray(1)];
        expect(Array.from(forwarded)).toEqual(want);
        expect(JSON.parse(new TextDecoder().decode(forwarded))).toEqual(
          { account_id: "user_test_recipe", ...JSON.parse(payload) });
      });
    }

    it("transcribe: a base64 image payload arrives byte-for-byte ahead of the account_id", async () => {
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
      const suffix = new TextEncoder().encode(',"account_id":"user_test_recipe"}');
      expect(forwarded.byteLength).toBe(bytes.byteLength - 1 + suffix.byteLength);
      expect(Array.from(forwarded.subarray(0, bytes.byteLength - 1))).toEqual(Array.from(bytes.subarray(0, -1)));
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
        // extract/rate remove it from the bytes; the media routes leave it, shadowed by the later key.
        if (!MEDIA_ROUTES.includes(route)) expect(sentText(upstreamCalls[0])).not.toContain("user_2victim");
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

    it("transcribe forwards a 2M-deep body carrying account_id, with the sub as the value read", async () => {
      const token = await validToken();
      const body = '{"account_id":1,"a":' + "[".repeat(2_000_000) + "]".repeat(2_000_000) + "}";
      const res = await worker.fetch(post("/api/recipe/transcribe", body, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(200);
      expect(new TextDecoder().decode(forwardedBytes(upstreamCalls[0]).subarray(-35))).toMatch(/\],"account_id":"user_test_recipe"\}$/);
    });
  });

  // ── transcribe: the sub inserted as the last top-level member ───────────────────────────────
  describe("insertAccountId (transcribe)", () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder("utf-8", { ignoreBOM: true });
    // { out: string } or { error: "bad" }. `cuts` is accepted for the call sites below; the
    // function sees the whole body, as the route reads it whole first.
    async function run(bytes, cuts = [], sub = "user_x") {
      const out = insertAccountId(bytes, sub);
      return out ? { out: dec.decode(out) } : { error: "bad" };
    }

    it("refuses bodies that do not start with { or end with } (a 400 at the route)", async () => {
      for (const t of ["", "   ", "[]", '[{"a":1}]', "null", '"{}"', "42", '{"a":1', '{"a":1}x', 'x{"a":1}', "}{"]) {
        expect((await run(enc.encode(t))).error, JSON.stringify(t)).toBe("bad");
      }
    });

    it("an empty object takes the member with no comma, whitespace and all", async () => {
      expect((await run(enc.encode("{}"))).out).toBe('{"account_id":"user_x"}');
      expect((await run(enc.encode(" { \n } "), [2, 4])).out).toBe(' { \n "account_id":"user_x"} ');
    });

    it("gives the expected bytes (whitespace, nesting and a client account_id kept as sent)", async () => {
      const body = enc.encode(' {"images":[{"data":"QUJD","media_type":"image/jpeg"}],"account_id":"v"}  \n ');
      const want = ' {"images":[{"data":"QUJD","media_type":"image/jpeg"}],"account_id":"v","account_id":"user_x"}  \n ';
      for (let a = 0; a <= body.length; a++) {
        for (const b of [a, a + 1, a + 7, body.length - 2]) {
          if (b < a || b > body.length) continue;
          expect((await run(body, [a, b])).out, `cuts ${a},${b}`).toBe(want);
        }
      }
    });

    it("trailing whitespace stays after the closing brace", async () => {
      const body = enc.encode('{"a":1}' + " ".repeat(10) + "\n".repeat(10));
      expect((await run(body, [7, 9, 12, 20, 25])).out).toBe('{"a":1,"account_id":"user_x"}' + " ".repeat(10) + "\n".repeat(10));
    });

    it("drops a leading BOM", async () => {
      expect((await run(new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode('{"a":1}')]))).out).toBe('{"a":1,"account_id":"user_x"}');
    });

    it("a null sub inserts account_id: null, so no caller value is read", async () => {
      const out = (await run(enc.encode('{"account_id":"user_2victim"}'), [], null)).out;
      expect(JSON.parse(out).account_id).toBeNull();
    });

    it("a body padded with 10 MB of whitespace costs one scan of the padding, not more", async () => {
      const body = enc.encode("{" + " ".repeat(5_000_000) + '"a":1' + " ".repeat(5_000_000) + "}");
      expect((await run(body)).out.endsWith('"a":1' + " ".repeat(5_000_000) + ',"account_id":"user_x"}')).toBe(true);
    });

    // The security property, checked exhaustively over the JSON.parse agreement corpus and its
    // mutations: whatever the caller sends, the output either fails JSON.parse (the upstream's
    // 400) or parses to an object whose account_id is the sub. No body becomes parseable with a
    // value of the caller's choosing.
    it("the upstream can only ever read the sub as account_id", async () => {
      const B = "\\";
      const seeds = [
        '{"account_id":"v"}', '{"a":1,"account_id":"v"}', '{"account_id":"v","a":{"account_id":"w"}}',
        `{"account${B}u005fid":"v","b":[1,2,{"c":null}]}`, '{"a":"x\\"y","account_id":"v"}',
        '{"a":"', '{"a":"\\', '{"a":"\\u12', '{"account_id":"v","a":{', '{"account_id":"v","a":[}',
        '{"account_id":"v",}', '{"account_id":"v","k"}', '{"account_id":"v","k":}', '{"account_id"}',
      ];
      let seed = 777, checked = 0;
      const rand = k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
      const ALPH = '{}[]",:01 \\u/a_';
      const bodies = [];
      for (const base of seeds) {
        bodies.push(base);
        for (let r = 0; r < 400; r++) {
          const arr = [...base];
          for (let m = 0, ms = 1 + rand(3); m < ms; m++) {
            const op = rand(3), at = rand(arr.length + 1), ch = ALPH[rand(ALPH.length)];
            if (op === 0) arr.splice(at, 0, ch); else if (op === 1) arr.splice(at, 1); else arr[at] = ch;
          }
          bodies.push(arr.join(""));
        }
      }
      for (const t of bodies) {
        const r = await run(enc.encode(t));
        if (r.error) continue;
        let v;
        try { v = JSON.parse(r.out); } catch { continue; }
        checked++;
        expect(v !== null && typeof v === "object" && !Array.isArray(v), t).toBe(true);
        expect(v.account_id, t).toBe("user_x");
      }
      expect(checked).toBeGreaterThan(300);
    }, 60000);
  });

  describe("route size caps", () => {
    for (const route of ["/api/recipe/extract", "/api/recipe/rate"]) {
      it(`${route}: 413s a declared body over the upstream's 200 KB, before claiming a slot`, async () => {
        const token = await validToken();
        const env = baseEnv();
        const body = '{"a":"' + "x".repeat(200_000) + '"}';
        const res = await worker.fetch(post(route, body, { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: "request body too large", reason: "request too large" });
        expect(upstreamCalls.length).toBe(0);
        expect(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM engine_log").get().n).toBe(0);
      });
    }

    it("rate: 413s a chunked body that runs past 200 KB as it is read, logged as 413", async () => {
      const token = await validToken();
      const env = baseEnv();
      const bytes = new TextEncoder().encode('{"a":"' + "x".repeat(200_000) + '"}');
      let sent = false;
      const req = new Request("https://worker.example/api/recipe/rate", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: new ReadableStream({ pull(c) { if (sent) return c.close(); sent = true; c.enqueue(bytes); } }),
        duplex: "half",
      });
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(413);
      expect(upstreamCalls.length).toBe(0);
      expect(env.DB.sqlite.prepare("SELECT path, status FROM engine_log").all()).toEqual([{ path: "/recipe/rate", status: 413 }]);
    });

    it("rate: a body just under 200 KB is forwarded", async () => {
      const token = await validToken();
      const body = '{"a":"' + "x".repeat(199_000) + '"}';
      const res = await worker.fetch(post("/api/recipe/rate", body, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(200);
      expect(upstreamCalls.length).toBe(1);
    });

    it("transcribe: a 1 MB body passes the 200 KB limit the other routes have", async () => {
      const token = await validToken();
      const body = '{"images":[{"media_type":"image/jpeg","data":"' + "A".repeat(1_000_000) + '"}]}';
      const res = await worker.fetch(post("/api/recipe/transcribe", body, { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(200);
    });

    it("transcribe: a valid object followed by a stray byte sends nothing upstream (no parseable prefix)", async () => {
      const token = await validToken();
      const res = await worker.fetch(post("/api/recipe/transcribe", '{"account_id":"user_2victim"}X',
        { Authorization: `Bearer ${token}` }), baseEnv());
      expect(res.status).toBe(400);
      expect(upstreamCalls.length).toBe(0);
    });

    it("transcribe: the upstream body carries an exact Content-Length-able payload (a Uint8Array, not a stream)", async () => {
      const token = await validToken();
      await worker.fetch(post("/api/recipe/transcribe", '{"images":[]}', { Authorization: `Bearer ${token}` }), baseEnv());
      expect(upstreamCalls[0].init.body).toBeInstanceOf(Uint8Array);
      expect(upstreamCalls[0].init.duplex).toBeUndefined();
    });

    for (const [label, body] of [["not an object", "[1]"], ["unterminated", '{"images":['], ["empty", ""]]) {
      it(`transcribe: 400s a body that is ${label}, with the route's error shape, logged as 400`, async () => {
        const token = await validToken();
        const env = baseEnv();
        const res = await worker.fetch(post("/api/recipe/transcribe", body, { Authorization: `Bearer ${token}` }), env);
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "invalid request body", reason: "request body must be a JSON object" });
        expect(env.DB.sqlite.prepare("SELECT path, status FROM engine_log").all())
          .toEqual([{ path: "/recipe/transcribe", status: 400 }]);
      });
    }
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
        const bytes = init.body instanceof ReadableStream ? await readAllBytes(init.body) : forwardedBytes({ init });
        upstreamCalls.push({ url, init, received: bytes.byteLength });
        return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
      }));
    }

    it("413s a chunked body that runs past the cap, sending nothing upstream, recording the attempt as 413", async () => {
      drainingUpstream();
      const token = await validToken();
      const env = baseEnv();
      const req = chunkedReq(token, 10 * 1024 * 1024 + 1);
      expect(req.headers.get("Content-Length")).toBeNull();
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "request body too large", reason: "photos too large; send fewer or smaller photos" });
      // Read whole before sending, so nothing at all reached the upstream: no prefix of the body.
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

  // ── transcribe-video: fresh-assistant-api PR #56, body cap 60,000,000 bytes ──────────────────
  describe("/api/recipe/transcribe-video", () => {
    const VIDEO = "/api/recipe/transcribe-video";
    const auth = async () => ({ Authorization: `Bearer ${await validToken()}` });
    // A JSON object of exactly `totalBytes` bytes: `media.data` is base64-alphabet filler.
    function videoBody(totalBytes) {
      const enc = new TextEncoder();
      const head = enc.encode('{"media":{"media_type":"video/mp4","data":"');
      const tail = enc.encode('"}}');
      const out = new Uint8Array(totalBytes).fill(0x41);
      out.set(head, 0);
      out.set(tail, totalBytes - tail.byteLength);
      return out;
    }
    const SUFFIX = ',"account_id":"user_test_recipe"';

    it("is not the 404 it was: an unauthenticated POST gets the same 401 as the other recipe routes", async () => {
      const res = await worker.fetch(post(VIDEO, "{}"), baseEnv());
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized", reason: "could not verify sign-in; sign in again" });
      expect(upstreamCalls.length).toBe(0);
    });

    it("forwards each documented body shape (url, post, media, frames) with only the verified sub added", async () => {
      const headers = await auth();
      const shapes = [
        { url: "https://www.tiktok.com/@someone/video/1" },
        { post: { text: "Spoken recipe in the video" } },
        { media: { data: "QUJD", media_type: "video/mp4" } },
        { frames: [{ data: "QUJD", media_type: "image/jpeg" }] },
      ];
      for (const shape of shapes) {
        upstreamCalls.length = 0;
        const res = await worker.fetch(post(VIDEO, JSON.stringify(shape), headers), baseEnv());
        expect(res.status).toBe(200);
        expect(upstreamCalls[0].url).toBe(ASK_UPSTREAM + VIDEO);
        expect(forwardedJson(upstreamCalls[0])).toEqual({ ...shape, account_id: "user_test_recipe" });
      }
    });

    it("accepts a body above the photo route's 10 MB, copying the media bytes unchanged", async () => {
      const headers = await auth();
      const bytes = videoBody(25 * 1024 * 1024);
      const res = await worker.fetch(post(VIDEO, bytes, headers), baseEnv());
      expect(res.status).toBe(200);
      const forwarded = forwardedBytes(upstreamCalls[0]);
      expect(forwarded.byteLength).toBe(bytes.byteLength + SUFFIX.length);
      expect(Buffer.compare(forwarded.subarray(0, bytes.byteLength - 1), bytes.subarray(0, -1))).toBe(0);
      expect(new TextDecoder().decode(forwarded.subarray(-SUFFIX.length - 1))).toBe(SUFFIX + "}");
    });

    it("accepts a body of exactly 60,000,000 bytes and refuses one byte more, before claiming a slot", async () => {
      const headers = await auth();
      const env = baseEnv();
      const ok = await worker.fetch(post(VIDEO, videoBody(60_000_000), headers), env);
      expect(ok.status).toBe(200);
      expect(forwardedBytes(upstreamCalls[0]).byteLength).toBe(60_000_000 + SUFFIX.length);

      upstreamCalls.length = 0;
      const env2 = baseEnv();
      const over = await worker.fetch(post(VIDEO, videoBody(60_000_001), headers), env2);
      expect(over.status).toBe(413);
      expect(await over.json()).toEqual({
        error: "request body too large", reason: "video too large; send a shorter or smaller clip" });
      expect(upstreamCalls.length).toBe(0);
      expect(env2.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM engine_log").get().n).toBe(0);
    }, 30000);

    it("413s a chunked body that runs past 60 MB as it is read, sending nothing upstream, logged as 413", async () => {
      const headers = await auth();
      const env = baseEnv();
      const bytes = videoBody(60_000_001);
      let at = 0;
      const req = new Request("https://worker.example" + VIDEO, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: new ReadableStream({ pull(c) {
          if (at >= bytes.byteLength) return c.close();
          c.enqueue(bytes.slice(at, at + 1024 * 1024)); at += 1024 * 1024;
        } }),
        duplex: "half",
      });
      expect(req.headers.get("Content-Length")).toBeNull();
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(413);
      expect(upstreamCalls.length).toBe(0);
      expect(env.DB.sqlite.prepare("SELECT path, status FROM engine_log").all())
        .toEqual([{ path: "/recipe/transcribe-video", status: 413 }]);
    }, 30000);

    it("the photo route keeps its 10 MB cap: a 25 MB body there is still refused", async () => {
      const headers = await auth();
      const res = await worker.fetch(post("/api/recipe/transcribe", videoBody(25 * 1024 * 1024), headers), baseEnv());
      expect(res.status).toBe(413);
      expect((await res.json()).reason).toBe("photos too large; send fewer or smaller photos");
    });

    describe("in-place insertion", () => {
      // The upstream parses with JSON.parse (last duplicate wins), so what matters is the object it
      // reads. Bodies with a BOM, trailing whitespace, a forged account_id, or an empty object
      // each move a different part of the tail.
      const cases = [
        ["a BOM", "﻿" + '{"media":{"data":"QUJD"}}'],
        ["trailing whitespace", '{"media":{"data":"QUJD"}} \r\n\t '],
        ["leading and trailing whitespace", '  \n{"url":"https://x.test/v"}\n'],
        ["a forged account_id", '{"account_id":"user_2victim","media":{"data":"QUJD"}}'],
        ["an empty object", "{}"],
        ["an empty object with whitespace inside", "{ \n }"],
      ];
      for (const [label, body] of cases) {
        it(`reads the verified sub as account_id with ${label}`, async () => {
          const headers = await auth();
          const res = await worker.fetch(post(VIDEO, body, headers), baseEnv());
          expect(res.status).toBe(200);
          const sent = forwardedJson(upstreamCalls[0]);
          const want = JSON.parse(body.replace(/^﻿/, ""));
          expect(sent).toEqual({ ...want, account_id: "user_test_recipe" });
        });
      }

      it("a sub that is not a forwardable shape is sent as account_id null", async () => {
        const headers = { Authorization: `Bearer ${await validToken({ sub: "bad sub!" })}` };
        await worker.fetch(post(VIDEO, '{"url":"https://x.test/v"}', headers), baseEnv());
        expect(forwardedJson(upstreamCalls[0])).toEqual({ url: "https://x.test/v", account_id: null });
      });

      it("a body longer than its declared Content-Length is still forwarded whole and correct", async () => {
        const headers = await auth();
        const body = '{"media":{"data":"' + "A".repeat(5000) + '"}}';
        const req = post(VIDEO, body, headers);
        req.headers.set("Content-Length", "10");
        const res = await worker.fetch(req, baseEnv());
        expect(res.status).toBe(200);
        expect(forwardedJson(upstreamCalls[0])).toEqual({ media: { data: "A".repeat(5000) }, account_id: "user_test_recipe" });
      });

      it("a body shorter than its declared Content-Length is forwarded without the unused room", async () => {
        const headers = await auth();
        const req = post(VIDEO, '{"url":"https://x.test/v"}', headers);
        req.headers.set("Content-Length", "5000");
        const res = await worker.fetch(req, baseEnv());
        expect(res.status).toBe(200);
        expect(forwardedBytes(upstreamCalls[0]).byteLength).toBe('{"url":"https://x.test/v"}'.length + SUFFIX.length);
      });

      it("never writes past a view it did not allocate: insertAccountId(…, true) on a caller's array copies", () => {
        const backing = new Uint8Array(64).fill(0x7a); // 'z' everywhere
        const view = backing.subarray(8, 8 + 2);
        view.set(new TextEncoder().encode("{}"));
        const out = insertAccountId(view, "user_x", true);
        expect(new TextDecoder().decode(out)).toBe('{"account_id":"user_x"}');
        expect(backing.subarray(10).every(b => b === 0x7a)).toBe(true); // neighbours untouched
        expect(backing.subarray(0, 8).every(b => b === 0x7a)).toBe(true);
      });

      it("a malformed tail is the route's 400 and nothing is forwarded", async () => {
        const headers = await auth();
        const res = await worker.fetch(post(VIDEO, '{"url":"x"}X', headers), baseEnv());
        expect(res.status).toBe(400);
        expect(upstreamCalls.length).toBe(0);
      });
    });

    describe("upstream call", () => {
      it("sends the service bearer and a complete Uint8Array body, with the 60 s abort signal attached", async () => {
        const token = await validToken();
        await worker.fetch(post(VIDEO, '{"url":"https://x.test/v"}', { Authorization: `Bearer ${token}` }), baseEnv());
        const init = upstreamCalls[0].init;
        expect(init.headers.get("Authorization")).toBe(`Bearer ${ASK_TOKEN}`);
        expect(init.headers.get("Authorization")).not.toContain(token);
        expect(init.body).toBeInstanceOf(Uint8Array);
        expect(init.signal).toBeInstanceOf(AbortSignal);
      });

      it("passes an upstream status and body through unchanged", async () => {
        upstreamStatus = 422;
        upstreamBody = JSON.stringify({ error: "no recipe in this video" });
        const res = await worker.fetch(post(VIDEO, "{}", await auth()), baseEnv());
        expect(res.status).toBe(422);
        expect(await res.text()).toBe(upstreamBody);
      });
    });

    describe("rate limit: a paid call, counted as transcribe is", () => {
      const rows = db => db.sqlite.prepare("SELECT path, status FROM engine_log ORDER BY id").all();
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

      it("logs a fixed label and the upstream status", async () => {
        upstreamStatus = 422;
        const env = baseEnv();
        await worker.fetch(post(VIDEO, '{"url":"https://private.example/v"}', await auth()), env);
        expect(rows(env.DB)).toEqual([{ path: "/recipe/transcribe-video", status: 422 }]);
        expect(JSON.stringify(env.DB.calls)).not.toContain("private.example");
      });

      it("shares the recipe ceiling with transcribe, extract and rate: 30 of any mix, then 429", async () => {
        const env = baseEnv();
        await seed(env.DB, "/recipe/transcribe", 10);
        await seed(env.DB, "/recipe/extract", 10);
        await seed(env.DB, "/recipe/rate", RECIPE_PER_HOUR - 20);
        const res = await worker.fetch(post(VIDEO, "{}", await auth()), env);
        expect(res.status).toBe(429);
        expect((await res.json()).reason).toBe(`recipe limit reached (${RECIPE_PER_HOUR} per hour); try again later`);
        expect(upstreamCalls.length).toBe(0);
      });

      it("video calls fill the ceiling that transcribe then hits", async () => {
        const env = baseEnv();
        await seed(env.DB, "/recipe/transcribe-video", RECIPE_PER_HOUR);
        const res = await worker.fetch(post("/api/recipe/transcribe", "{}", await auth()), env);
        expect(res.status).toBe(429);
      });

      it("the engine ceiling is not touched, as for the other recipe routes", async () => {
        const env = baseEnv();
        await seed(env.DB, "/version", 60);
        const res = await worker.fetch(post(VIDEO, "{}", await auth()), env);
        expect(res.status).toBe(200);
      });

      it("a listed dev sub gets RECIPE_PER_HOUR_DEV, and stops there", async () => {
        const env = baseEnv({ RECIPE_DEV_SUBS: "user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe-video", RECIPE_PER_HOUR);
        const ok = await worker.fetch(post(VIDEO, "{}", await auth()), env);
        expect(ok.status).toBe(200);

        const env2 = baseEnv({ RECIPE_DEV_SUBS: "user_test_recipe" });
        await seed(env2.DB, "/recipe/transcribe-video", RECIPE_PER_HOUR_DEV);
        const stopped = await worker.fetch(post(VIDEO, "{}", await auth()), env2);
        expect(stopped.status).toBe(429);
        expect((await stopped.json()).reason)
          .toBe(`recipe limit reached (${RECIPE_PER_HOUR_DEV} per hour); try again later`);
      });

      it("RECIPE_DEV_SUBS unset falls back to ASK_DEV_SUBS, and an unlisted sub gets the public ceiling", async () => {
        const env = baseEnv({ ASK_DEV_SUBS: "user_test_recipe" });
        await seed(env.DB, "/recipe/transcribe-video", RECIPE_PER_HOUR);
        expect((await worker.fetch(post(VIDEO, "{}", await auth()), env)).status).toBe(200);

        const env2 = baseEnv({ ASK_DEV_SUBS: "user_other" });
        await seed(env2.DB, "/recipe/transcribe-video", RECIPE_PER_HOUR);
        expect((await worker.fetch(post(VIDEO, "{}", await auth()), env2)).status).toBe(429);
      });

      it("an attempt that ends in a 502 still counts, with status 502", async () => {
        const env = baseEnv();
        vi.stubGlobal("fetch", vi.fn(async (input) => {
          const url = typeof input === "string" ? input : input.url;
          if (url.startsWith(JWKS_URL)) return new Response(JSON.stringify(jwksDoc), { status: 200 });
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }));
        const res = await worker.fetch(post(VIDEO, "{}", await auth()), env);
        expect(res.status).toBe(502);
        expect(rows(env.DB)).toEqual([{ path: "/recipe/transcribe-video", status: 502 }]);
      });
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
