// Test-only helpers: a locally generated RS256 key pair, a fake JWKS server, and a minimal
// JWT signer — so the auth tests never touch the real Clerk service.

import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

function base64UrlEncode(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(new TextEncoder().encode(str));
}

export async function generateTestKeyPair() {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
}

export async function exportJwks(publicKey, kid) {
  const jwk = await crypto.subtle.exportKey("jwk", publicKey);
  return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
}

export async function signTestJWT(privateKey, kid, claims) {
  const header = { alg: "RS256", typ: "JWT", kid };
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(claims));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, signingInput);
  const sigB64 = base64UrlEncode(new Uint8Array(signature));
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

// A fake `fetch` that serves a fixed JWKS response and counts calls, so tests can assert on
// how many times the JWKS was actually fetched (cache hits vs. refetch-on-unknown-kid).
export function makeFakeJwksFetch(jwksDoc, { fail = false } = {}) {
  const fetchImpl = async () => {
    fetchImpl.calls++;
    if (fail) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify(jwksDoc), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  fetchImpl.calls = 0;
  return fetchImpl;
}

// Drains a ReadableStream (e.g. the `body` a fetch stub captured) into one Uint8Array, so a
// test can assert on the exact bytes forwarded rather than a decoded string.
export async function readAllBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// A D1-shaped binding over a real in-memory SQLite database loaded with ../schema.sql, for tests
// whose claim depends on what the SQL actually does (a LIKE filter, a conditional INSERT), which
// makeMockDB below cannot show: it returns one scripted count for every query. Records calls like
// makeMockDB. `failOn` is a regex over the SQL; a matching run() throws, as a D1 write error would.
//
// `sqlite` is the raw database for seeding and reading, with one shim: a row a test inserts into
// engine_log through it also counts in ceiling_count, in the hour bucket of its created_at, as if the
// Worker had admitted that request then. The Worker no longer reads engine_log for its ceilings
// (claimCeiling, 2026-11-20), so a seeded "N requests in the last hour" must land in the counters
// to mean anything; the label-to-group map below is the grouping the Worker's ceilings count by,
// written out once here (a test that seeds one group's label and expects another group's route
// unaffected checks the Worker against it). Rows the Worker writes itself go through `prepare`
// below, never this shim, so they are not counted twice.
const RECIPE_IMPORT_LABELS = new Set(["/recipe/extract", "/recipe/transcribe", "/recipe/transcribe-video", "/recipe/rate", "/recipe/image"]);
export function ceilingGroupOf(label) {
  if (label.startsWith("/food/")) return "food";
  if (label.startsWith("/record/")) return "record";
  if (label.startsWith("/rating-tuple")) return "rating-tuple";
  if (label.startsWith("/rate-progress")) return "rate-progress";
  if (label === "/common/item" || label === "/common/feed") return label.slice(1);
  if (label.startsWith("/scan")) return "scan";
  if (RECIPE_IMPORT_LABELS.has(label)) return "recipe";
  if (label.startsWith("/recipe/") || label.startsWith("/plan/")) return label;
  return "engine";
}
function seedingSqlite(db) {
  const count = db.prepare(
    "INSERT INTO ceiling_count (bucket, key, n, first_at) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT(bucket, key) DO UPDATE SET n = n + 1");
  return new Proxy(db, {
    get(target, prop) {
      if (prop !== "prepare") {
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      }
      return sql => {
        const stmt = target.prepare(sql);
        if (!/^\s*INSERT INTO engine_log\b/i.test(sql)) return stmt;
        return new Proxy(stmt, {
          get(st, p) {
            if (p !== "run") {
              const v = Reflect.get(st, p);
              return typeof v === "function" ? v.bind(st) : v;
            }
            return (...args) => {
              const r = st.run(...args);
              const row = target.prepare(
                "SELECT path, ip_hash, acct_hash, CAST(strftime('%s', created_at) AS INTEGER) AS t FROM engine_log WHERE id = ?"
              ).get(r.lastInsertRowid);
              const bucket = Math.floor(row.t / 3600);
              const group = ceilingGroupOf(row.path);
              if (row.ip_hash != null) count.run(bucket, `i:${row.ip_hash}:${group}`, row.t);
              if (row.acct_hash != null) count.run(bucket, `a:${row.acct_hash}:${group}`, row.t);
              return r;
            };
          },
        });
      };
    },
  });
}

export function makeSqliteDB({ failOn = null } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const calls = [];
  return {
    calls,
    sqlite: seedingSqlite(db),
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              calls.push({ sql, args });
              if (failOn && failOn.test(sql)) throw new Error("D1_ERROR: simulated read failure");
              return { results: db.prepare(sql).all(...args) };
            },
            async run() {
              calls.push({ sql, args });
              if (failOn && failOn.test(sql)) throw new Error("D1_ERROR: simulated write failure");
              const r = db.prepare(sql).run(...args);
              return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
            },
          };
        },
      };
    },
  };
}

// A mock D1 binding: prepare().bind().all()/run(), recording every call for assertions and
// letting tests script the count returned for rate-limit checks.
export function makeMockDB({ countAll = 0 } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async all() {
              calls.push({ sql, args });
              return { results: [{ n: countAll }] };
            },
            async run() {
              calls.push({ sql, args });
              // changes: 1, so a ceiling claim (claimCeiling) reads as admitted, as on D1.
              return { success: true, meta: { changes: 1, last_row_id: calls.length } };
            },
          };
        },
      };
    },
  };
}
