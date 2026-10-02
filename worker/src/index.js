// fresh-insights-engage — comments / subscribe / feedback API.
// All data lives in our own D1 database; no third party sees a reader's email.

import { createJwksCache, verifyClerkJWT } from "./clerkAuth.js";

const MAX_BODY = 4000;
const MAX_NAME = 80;
const POSTS_PER_HOUR = 5; // per ip_hash per page
const RETRIEVE_PER_HOUR = 40;         // passage lookup: deterministic upstream, costs nothing
const RETRIEVE_ANSWERS_PER_HOUR = 10; // answer pass: one model call each, so a tighter ceiling
const ASK_PER_HOUR = 10;              // surface chat: EVERY turn is one model call upstream
// Development ceiling, applied only to a VERIFIED Clerk identity named in ASK_DEV_SUBS — see the
// block in /api/ask for why it is keyed on a verified sub rather than on the account_id the app
// already sends. Raised, never removed: a lost phone or a leaked session should cost a bounded
// number of paid model calls, not an unbounded one.
const ASK_PER_HOUR_DEV = 200;
const ASK_MAX_Q = 2000;               // matches the assistant service's MAX_Q_LEN
// A client-executed tool's results, carried back into the same turn (fresh_app's
// get_food_assessment). Both bounds sit UNDER the assistant service's own — lib/tool_results.js
// there caps at MAX_TOOL_RESULTS = 4 and MAX_TOOL_RESULTS_BYTES = 48 * 1024 = 49152 — so a payload
// this Worker accepts is one that service will also accept on size alone, and a rejection there is
// always about content rather than about this hop.
const ASK_MAX_TOOL_RESULTS = 4;
const ASK_MAX_TOOL_RESULTS_BYTES = 48000;
// Engine calls are compute (a diet-engine scoring pass on Fly), not a paid model call like
// /api/ask, and every caller is already Clerk-authenticated — so this is a per-IP abuse
// ceiling, not a cost ceiling, and is set looser than ASK_PER_HOUR deliberately.
const ENGINE_PER_HOUR = 60;
const ENGINE_UPSTREAM_TIMEOUT_MS = 25000;
// Size cap for a forwarded /api/engine/* body. This route is about to accept file uploads
// (Cronometer CSV intakes); the largest known Phase 0 fixture is a 74 KB CSV, so 10 MB is
// generous headroom for a real diet-log upload while still bounding a single request.
// Enforced against the inbound Content-Length before any byte is forwarded (see below) — a
// client that omits Content-Length and streams past this size is not caught here and falls
// back to Cloudflare's own platform-level request body ceiling.
const ENGINE_MAX_BODY_BYTES = 10 * 1024 * 1024;
// Recipe import/rating (/api/recipe/*) proxied to fresh-assistant-api. Every caller is
// Clerk-authenticated, like /api/engine/*, but /api/recipe/transcribe is a paid model call with
// images, so this is its own ceiling rather than a share of ENGINE_PER_HOUR — a user importing
// recipes should not spend the Diet flow's budget, nor the reverse.
export const RECIPE_PER_HOUR = 30;
// Development ceiling for /api/recipe/*, applied only when the caller's VERIFIED Clerk `sub` is
// named in the recipe tester list: RECIPE_DEV_SUBS if that secret exists, ASK_DEV_SUBS if it
// does not (see the /api/recipe/* block). The same shape as ASK_PER_HOUR_DEV, and for the same reason: fresh_app
// is hand-tested against the live Worker, where 30 transcribes an hour locks a tester out. The
// ceiling stays keyed on the rotating IP hash (Josh, 2026-09-30: "Keep per-address"); only its
// height changes for a listed tester. Raised, never removed: a lost phone still costs a bounded
// number of paid vision calls.
export const RECIPE_PER_HOUR_DEV = 200;
// Transcription is a vision model pass over up to several photos; allow a slow turn. It is the
// outermost bound only: fresh_app aborts every recipe call at 30 s (recipeService.ts
// REQUEST_TIMEOUT_MS) and fresh-assistant-api answers /api/recipe/rate itself at 27 s (its
// RATE_TIMEOUT_MS, PR #51), so on rate the upstream's own 503 arrives well inside this.
const RECIPE_UPSTREAM_TIMEOUT_MS = 60000;
// The only recipe routes this Worker forwards. Each value is also the label written to
// engine_log: a fixed string per route, never the request URL or anything in the body (a recipe
// URL or a photo is the user's own content).
const RECIPE_ROUTES = {
  "/api/recipe/extract": "/recipe/extract",
  "/api/recipe/transcribe": "/recipe/transcribe",
  "/api/recipe/rate": "/recipe/rate",
};
// The only upstream response headers /api/recipe/* passes back to the caller. recipeService.ts
// reads the status and the JSON body; Retry-After is kept for a 429/503 the upstream sends itself.
// Anything else the upstream emits (Set-Cookie, a stale Content-Length or Content-Encoding, a
// server banner) stays on this hop.
const RECIPE_RESPONSE_HEADERS = ["content-type", "retry-after"];

// Reads `body` into one Uint8Array, or returns null once more than `max` bytes have arrived (the
// read stops there; nothing past the cap is held).
async function readCapped(body, max) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.byteLength; }
  return out;
}

// The verified sub, or null when it is not a shape fit to forward. Same charset as /api/ask.
const forwardableSub = sub => (/^[A-Za-z0-9_.@+-]{1,200}$/.test(sub) ? sub : null);

// A recipe request body with `account_id` set to `accountId` (or removed when that is null),
// whatever the caller put there. Returns null when `bytes` is not UTF-8 JSON whose top level is an
// object; the caller answers 400 and nothing is forwarded.
//
// The body is never handed to JSON.parse. A parse's memory follows the body's SHAPE, not its byte
// count: a 10 MB body of ~3.4M empty objects grows the heap by ~230 MB, past a Worker isolate's
// 128 MB, and an isolate serves other people's requests concurrently. Instead one pass over the
// bytes checks the full JSON grammar (and UTF-8 inside strings), finds the top-level members, and
// copies every member except a top-level `account_id` into one output buffer, byte for byte. So the
// memory is the input plus an output no larger than it, whatever the shape, and a base64 photo is
// copied once and never decoded. The output is `{"account_id":"<sub>"` followed by the caller's
// other top-level members in order; only the whitespace between top-level members is dropped.
// A key counts as `account_id` under any spelling JSON.parse would decode to it (`_`
// escapes), and every duplicate is removed. Nested `account_id` keys are left alone: the
// upstream reads the top level only.
export function withAccountId(bytes, accountId) {
  const n = bytes.length;
  let i = 0;
  const ws = () => { while (i < n) { const c = bytes[i]; if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++; else break; } };

  // A string starting at bytes[i] (the opening quote). Advances past the closing quote; returns
  // whether a backslash escape occurred, or -1 when it is not a valid JSON string.
  const string = () => {
    if (bytes[i] !== 0x22) return -1;
    i++;
    let escaped = 0;
    for (;;) {
      // The hot loop (a base64 photo is one long run of these): a local index, since `i` lives in
      // the closure's context and every access to it there is slower.
      let j = i;
      while (j < n) {
        const c = bytes[j];
        if (c < 0x20 || c === 0x22 || c === 0x5c || c >= 0x80) break;
        j++;
      }
      i = j;
      if (i >= n) return -1;
      const c = bytes[i];
      if (c === 0x22) { i++; return escaped; }
      if (c < 0x20) return -1;
      if (c === 0x5c) {
        escaped = 1;
        const e = bytes[i + 1];
        if (e === 0x75) {
          for (let k = 2; k < 6; k++) {
            const h = bytes[i + k];
            if (!((h >= 0x30 && h <= 0x39) || (h >= 0x41 && h <= 0x46) || (h >= 0x61 && h <= 0x66))) return -1;
          }
          i += 6;
        } else if (e === 0x22 || e === 0x5c || e === 0x2f || e === 0x62 || e === 0x66 ||
                   e === 0x6e || e === 0x72 || e === 0x74) {
          i += 2;
        } else return -1;
      } else {
        // One well-formed UTF-8 sequence (no overlongs, no surrogates, nothing past U+10FFFF).
        let len, lo = 0x80, hi = 0xbf;
        if (c >= 0xc2 && c <= 0xdf) len = 2;
        else if (c >= 0xe0 && c <= 0xef) { len = 3; if (c === 0xe0) lo = 0xa0; if (c === 0xed) hi = 0x9f; }
        else if (c >= 0xf0 && c <= 0xf4) { len = 4; if (c === 0xf0) lo = 0x90; if (c === 0xf4) hi = 0x8f; }
        else return -1;
        for (let k = 1; k < len; k++) {
          const t = bytes[i + k];
          if (k === 1 ? (t === undefined || t < lo || t > hi) : (t === undefined || t < 0x80 || t > 0xbf)) return -1;
        }
        i += len;
      }
    }
  };
  const digits = () => { const s = i; while (i < n && bytes[i] >= 0x30 && bytes[i] <= 0x39) i++; return i > s; };
  const literal = word => {
    for (let k = 0; k < word.length; k++) if (bytes[i + k] !== word.charCodeAt(k)) return false;
    i += word.length;
    return true;
  };
  // Any JSON value starting at bytes[i]. Iterative, with a growable stack of open containers
  // (1 = object, 2 = array), so nesting depth cannot exhaust the call stack.
  let stack = new Uint8Array(64);
  const value = () => {
    let depth = 0;
    const push = t => {
      if (depth === stack.length) { const s = new Uint8Array(stack.length * 2); s.set(stack); stack = s; }
      stack[depth++] = t;
    };
    const memberKey = () => { ws(); if (string() < 0) return false; ws(); if (bytes[i] !== 0x3a) return false; i++; return true; };
    for (;;) {
      ws();
      const c = bytes[i];
      if (c === 0x7b) {
        i++; ws();
        if (bytes[i] === 0x7d) i++;
        else { push(1); if (!memberKey()) return false; continue; }
      } else if (c === 0x5b) {
        i++; ws();
        if (bytes[i] === 0x5d) i++;
        else { push(2); continue; }
      } else if (c === 0x22) {
        if (string() < 0) return false;
      } else if (c === 0x2d || (c >= 0x30 && c <= 0x39)) {
        if (c === 0x2d) i++;
        if (bytes[i] === 0x30) i++;
        else if (!digits()) return false;
        if (bytes[i] === 0x2e) { i++; if (!digits()) return false; }
        if (bytes[i] === 0x65 || bytes[i] === 0x45) {
          i++;
          if (bytes[i] === 0x2b || bytes[i] === 0x2d) i++;
          if (!digits()) return false;
        }
      } else if (!(literal("true") || literal("false") || literal("null"))) {
        return false;
      }
      // After a complete value: close containers, or move to the next element / member.
      for (;;) {
        if (depth === 0) return true;
        ws();
        const d = bytes[i];
        const top = stack[depth - 1];
        if (d === 0x2c) {
          i++;
          if (top === 1 && !memberKey()) return false;
          break;
        }
        if ((top === 1 && d === 0x7d) || (top === 2 && d === 0x5d)) { i++; depth--; continue; }
        return false;
      }
    }
  };

  // Top level: optional BOM, whitespace, then an object.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  ws();
  if (bytes[i] !== 0x7b) return null;
  i++;

  const head = new TextEncoder().encode(accountId ? `{"account_id":${JSON.stringify(accountId)}` : "{");
  const out = new Uint8Array(head.byteLength + n + 1);
  out.set(head, 0);
  let o = head.byteLength;
  let kept = accountId ? 1 : 0;
  let removed = 0;
  const ACCOUNT_ID = new TextEncoder().encode('"account_id"');

  ws();
  if (bytes[i] === 0x7d) {
    i++;
  } else {
    for (;;) {
      ws();
      const start = i;
      const escaped = string();
      if (escaped < 0) return null;
      const keyEnd = i;
      // Is this key "account_id"? Unescaped: compare bytes. Escaped: decode it, but only when it
      // is short enough to be ten characters (each at most a six-byte \uXXXX).
      let isAccountId = false;
      if (!escaped) {
        isAccountId = keyEnd - start === ACCOUNT_ID.length &&
          ACCOUNT_ID.every((b, k) => bytes[start + k] === b);
      } else if (keyEnd - start <= 62) {
        isAccountId = JSON.parse(new TextDecoder().decode(bytes.subarray(start, keyEnd))) === "account_id";
      }
      ws();
      if (bytes[i] !== 0x3a) return null;
      i++;
      if (!value()) return null;
      if (isAccountId) removed++;
      else {
        if (kept++) out[o++] = 0x2c;
        out.set(bytes.subarray(start, i), o);
        o += i - start;
      }
      ws();
      if (bytes[i] === 0x2c) { i++; continue; }
      if (bytes[i] === 0x7d) { i++; break; }
      return null;
    }
  }
  ws();
  if (i !== n) return null;
  // Unchanged body: forward it as sent, minus a BOM, which the upstream's JSON.parse rejects.
  if (!accountId && !removed) return bytes[0] === 0xef ? bytes.subarray(3) : bytes;
  out[o++] = 0x7d;
  return out.subarray(0, o);
}

// Module-level so the JWKS cache survives across requests within the same warm isolate.
const clerkJwksCache = createJwksCache();

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "*",
    // PUT is for /api/engine/ffq and /api/engine/framework/pin (fresh_diet step 2a), which the
    // web build calls with PUT; without it the browser's preflight fails. CORS is not a method
    // gate: /api/comments, /api/subscribe, /api/feedback, /api/retrieve, /api/ask, /api/recipe/*
    // and /admin/hide check their own method, but /admin/comments, /admin/subscribers,
    // /admin/feedback and /health answer any method. A new handler must check its own method.
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    // Authorization is listed because the Clerk-authenticated routes (/api/engine/*,
    // /api/recipe/*) are called from fresh_app's web build too, and a browser preflight for a
    // bearer-carrying request fails without it. Listing it grants nothing: the JWT check is
    // the boundary on those routes, and every other route ignores the header.
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

async function ipHash(req) {
  const ip = req.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const day = new Date().toISOString().slice(0, 10); // daily rotation: hashes are unlinkable across days
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "|" + day));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

const cleanPage = p =>
  typeof p === "string" && /^\/[a-z0-9\-\/._]{0,120}$/i.test(p) ? p : null;

// Reduce an /api/engine/* suffix to a loggable route label before it reaches engine_log, so the
// row records which ROUTE was hit ("/intake/:id/score") and never the caller's instance of it
// ("/intake/f83a1c9b/score"). engine_log's schema comment promises this table is never for who
// called it.
//
// This used to be a segment-SHAPE heuristic (digits/UUID/hex-like segments treated as opaque
// ids, everything else logged as-is). A reviewer found the hole: a purely alphabetic identifier
// — a word slug, a base26 token, any alphabetic-only opaque key — has no shape that distinguishes
// it from a route word, so it survived unredacted and was written to D1 verbatim. No shape rule
// can close that hole; only knowing the actual route shapes can.
//
// So this is now a table of known engine route templates (kept in sync with fresh_diet's
// `docs/api/CONTRACT.md`, the HTTP API contract for the engine this Worker proxies) plus a
// constant fallback for everything else:
//   - a suffix matching a template's segment shape logs the TEMPLATE STRING, with each `:id`
//     slot matched by position only — never by content, so an alphabetic id in that slot is
//     just as redacted as a numeric or UUID one;
//   - a suffix matching no template logs the single constant ROUTE_UNKNOWN below — never the
//     raw path, never a partially-redacted path, never any segment of it.
// The constant is what makes this strictly safer than both the old heuristic and a plain
// allowlist: an allowlist alone leaves an unlisted route to fall through and log raw (the
// original bug, arriving again quietly for whichever route nobody added). Routing an unlisted
// route to a fixed constant instead means the worst case for a route this table doesn't know
// about is a loss of operational visibility (it reads ROUTE_UNKNOWN in engine_log), never a
// leaked identifier. The remedy when that happens is adding one line to ENGINE_ROUTE_TEMPLATES;
// do not "improve" the fallback to salvage partial information from an unmatched path — that
// reintroduces the exact hole this replaces.
const ROUTE_UNKNOWN = "/unknown";

const ENGINE_ROUTE_TEMPLATES = [
  "/version",
  "/healthz",
  "/intake/cronometer",
  "/intake/:id/score",
  "/intake/:id/signature",
  "/intake/:id/framework",
  "/intake/:id/projection",
  "/intake/:id/recommendations",
  "/intake/:id/recipes",
  "/intake/:id/match",
  "/day/:id",
  "/days",
  "/ffq",
  "/frameworks",
  "/framework/pin",
];

function routeLabelFor(suffix) {
  const segs = suffix.split("/").filter(Boolean);
  for (const template of ENGINE_ROUTE_TEMPLATES) {
    const tSegs = template.split("/").filter(Boolean);
    if (tSegs.length !== segs.length) continue;
    if (tSegs.every((t, i) => t === ":id" ? segs[i].length > 0 : t === segs[i])) return template;
  }
  return ROUTE_UNKNOWN;
}

// Which deployed Worker answered this request. Cloudflare's version_metadata binding supplies it
// with no deploy-time plumbing — no build step, no `--var`, nothing to remember on a manual
// `wrangler deploy` — so unlike a hand-set constant it cannot silently go stale.
//
// This exists because "is #38 live?" was unanswerable for three days. This repo has no CI path
// that deploys the Worker, so MERGED and SHIPPED are independent facts and only the first was
// readable; /health returns {ok:true} and says nothing about which code produced it. The
// timestamp is the load-bearing half: comparing it against a PR's merge time settles the question
// in one curl, by anyone, without Cloudflare credentials.
function versionHeaders(env) {
  const v = env.CF_VERSION_METADATA;
  if (!v || !v.id) return null; // binding absent (local dev, tests) — stamp nothing rather than guess
  return {
    "X-Worker-Version": v.id,
    ...(v.timestamp ? { "X-Worker-Deployed": v.timestamp } : {}),
    // Custom response headers are invisible to browser JS unless named here. A native caller
    // (fresh_app) reads them either way; the site's own chat needs this line.
    "Access-Control-Expose-Headers": "X-Worker-Version, X-Worker-Deployed",
  };
}

async function handleRequest(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/comments" && req.method === "GET") {
        const page = cleanPage(url.searchParams.get("page"));
        if (!page) return json({ error: "bad page" }, 400, cors);
        const { results } = await env.DB.prepare(
          "SELECT id, name, body, created_at FROM comments WHERE page = ?1 AND hidden = 0 ORDER BY created_at ASC LIMIT 500"
        ).bind(page).all();
        return json({ comments: results }, 200, cors);
      }

      if (path === "/api/comments" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (b.website) return json({ ok: true }, 200, cors); // honeypot: pretend success
        const page = cleanPage(b.page);
        const name = (b.name || "").trim().slice(0, MAX_NAME);
        const body = (b.body || "").trim();
        if (!page || name.length < 1 || body.length < 2 || body.length > MAX_BODY)
          return json({ error: "name and comment are required" }, 400, cors);
        const hash = await ipHash(req);
        const { results } = await env.DB.prepare(
          "SELECT COUNT(*) n FROM comments WHERE ip_hash = ?1 AND page = ?2 AND created_at > datetime('now','-1 hour')"
        ).bind(hash, page).all();
        if (results[0].n >= POSTS_PER_HOUR)
          return json({ error: "too many comments — try again later" }, 429, cors);
        await env.DB.prepare(
          "INSERT INTO comments (page, name, body, ip_hash) VALUES (?1, ?2, ?3, ?4)"
        ).bind(page, name, body, hash).run();
        return json({ ok: true }, 201, cors);
      }

      if (path === "/api/subscribe" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (b.website) return json({ ok: true }, 200, cors);
        const email = (b.email || "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254)
          return json({ error: "that email doesn't look right" }, 400, cors);
        await env.DB.prepare(
          "INSERT INTO subscribers (email, source) VALUES (?1, ?2) ON CONFLICT(email) DO NOTHING"
        ).bind(email, cleanPage(b.source) || null).run();
        return json({ ok: true }, 201, cors);
      }

      if (path === "/api/feedback" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        if (b.website) return json({ ok: true }, 200, cors);
        const body = (b.body || "").trim();
        if (body.length < 2 || body.length > MAX_BODY)
          return json({ error: "feedback text is required" }, 400, cors);
        await env.DB.prepare(
          "INSERT INTO feedback (page, email, body) VALUES (?1, ?2, ?3)"
        ).bind(cleanPage(b.page) || null, (b.email || "").slice(0, 254) || null, body).run();
        return json({ ok: true }, 201, cors);
      }

      // ── Retrieval over the FRESH papers corpus (fresh-assistant-api /retrieve).
      // The essays cite science; this lets a page pull the passages behind a claim instead of
      // asking a reader to take a footnote on trust.
      //
      // Why proxy rather than let the page call the API directly: this Worker already holds the
      // origin allowlist and per-IP limiting the Fly service does not, and it can carry the
      // bearer token that unlocks the model-backed answer pass — a browser cannot keep a secret.
      // The upstream stays reachable only through here for the paid half.
      if (path === "/api/retrieve" && req.method === "POST") {
        if (!env.RETRIEVE_UPSTREAM) return json({ error: "retrieval not configured" }, 503, cors);

        const b = await req.json().catch(() => ({}));
        const q = String(b.q || "").trim().slice(0, 500);
        if (q.length < 3) return json({ error: "question is required" }, 400, cors);
        const k = Math.min(8, Math.max(1, Number(b.k) || 5));
        // The calling essay's series, used upstream to scope which papers are searched.
        // Bounded and character-restricted like every other reader-supplied field here.
        const series = String(b.series || "").trim().slice(0, 40).replace(/[^a-z0-9-]/gi, "");
        // The answer pass costs money per call, so it is rate-limited harder than passage
        // lookup and can be disabled outright without redeploying the page.
        const wantAnswer = b.answer === true && env.RETRIEVE_ANSWERS !== "off";

        const hash = await ipHash(req);
        const limit = wantAnswer ? RETRIEVE_ANSWERS_PER_HOUR : RETRIEVE_PER_HOUR;
        const { results: recent } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM retrieval_log " +
          "WHERE ip_hash = ?1 AND answered = ?2 AND created_at > datetime('now', '-1 hour')"
        ).bind(hash, wantAnswer ? 1 : 0).all();
        if ((recent?.[0]?.n || 0) >= limit) {
          return json({ error: "too many lookups — try again later" }, 429, cors);
        }

        const headers = { "Content-Type": "application/json" };
        if (env.RETRIEVE_TOKEN) headers.Authorization = `Bearer ${env.RETRIEVE_TOKEN}`;
        let upstream;
        try {
          upstream = await fetch(env.RETRIEVE_UPSTREAM.replace(/\/$/, "") + "/retrieve", {
            method: "POST", headers,
            body: JSON.stringify({ q, k, answer: wantAnswer, series }),
            signal: AbortSignal.timeout(25000),
          });
        } catch {
          return json({ error: "retrieval service unreachable" }, 502, cors);
        }
        if (!upstream.ok) {
          return json({ error: `retrieval failed (${upstream.status})` }, 502, cors);
        }
        const data = await upstream.json().catch(() => null);
        if (!data) return json({ error: "bad response from retrieval service" }, 502, cors);

        // Tell the page whether the summary option is actually available, so it can hide the
        // control instead of offering a checkbox that silently does nothing.
        data.answers_enabled = env.RETRIEVE_ANSWERS !== "off";

        // Logged like every other reader action here: what was asked, from which page, never
        // who asked it (ip_hash rotates daily and is not reversible).
        await env.DB.prepare(
          "INSERT INTO retrieval_log (page, ip_hash, q, answered, n_hits) VALUES (?1, ?2, ?3, ?4, ?5)"
        ).bind(cleanPage(b.page) || null, hash, q, wantAnswer ? 1 : 0,
               Array.isArray(data.hits) ? data.hits.length : 0).run();

        return json(data, 200, cors);
      }

      // ── Surface chat on public pages (fresh-assistant-api /ask) — the branded viewer at
      // /artifacts/fresh-food-surface.html and, later, other deployed surfaces.
      //
      // Same shape as /api/retrieve and for the same reason: this Worker holds the origin
      // allowlist, the per-IP ceiling, and the ASK_TOKEN bearer that unlocks the upstream
      // model pass — a browser cannot keep a secret, so the Fly service refuses any /ask
      // that does not arrive through here. Every call is one model call upstream, which is
      // why the ceiling is the answers ceiling, not the passages one.
      if (path === "/api/ask" && req.method === "POST") {
        // Fail closed twice over: no upstream configured OR no token to unlock it => 503.
        // The page's chat degrades to its deterministic built-in commands, never an error
        // in the reader's face.
        if (!env.ASK_UPSTREAM || !env.ASK_TOKEN)
          return json({ error: "assistant not configured" }, 503, cors);

        const b = await req.json().catch(() => ({}));
        const q = String(b.q || "").trim().slice(0, ASK_MAX_Q);
        if (q.length < 2) return json({ error: "question is required" }, 400, cors);
        // Which surface family is asking — bounded and character-restricted like every
        // other reader-supplied field here.
        const app = String(b.app || "").trim().slice(0, 40).replace(/[^a-z0-9_]/gi, "");
        // The page's own state and recent turns ride along so follow-ups resolve, but a
        // hostile page must not be able to pump arbitrary bytes upstream: both are bounded
        // by re-serialized size and dropped (not rejected) when oversized — the question
        // still answers, just without the projection.
        let context = (b.context && typeof b.context === "object" && !Array.isArray(b.context)) ? b.context : {};
        let history = Array.isArray(b.history) ? b.history.slice(-8) : [];
        try { if (JSON.stringify(context).length > 30000) context = {}; } catch { context = {}; }
        try { if (JSON.stringify(history).length > 16000) history = []; } catch { history = []; }

        // A client-executed tool's RESULT, carried back into the SAME turn — fresh_app's
        // `get_food_assessment` reads its own store and sends the values here so the assistant can
        // answer from them rather than withholding a number it never saw (fresh_app#141). Bounded
        // like `context`/`history` above and forwarded otherwise untouched. Three properties, each
        // stated because each is a way a later edit breaks the loop without failing anything:
        //
        //   1. ALL-OR-NOTHING, never a filtered subset. The assistant service derives its one-round
        //      cap STATELESSLY, from whether `tool_results` arrived on the request: a turn that
        //      arrives WITH results is by definition the second half of a round, so a further read
        //      is refused there. A transport that carried some entries and dropped others would
        //      leave that cap reading a turn it cannot classify. Carry the field whole or drop it
        //      whole — which is why the cap below empties the array rather than trimming it.
        //   2. NO VALIDATION HERE. `parseToolResults` on the assistant service owns the closed field
        //      allowlist, the per-entry size cap and the personal-field fence, and emits a NAMED
        //      reason for every entry it refuses, which reaches the caller as a correction row.
        //      Pre-filtering here would make a result that was dropped indistinguishable from one
        //      that was never sent.
        //   3. NO NORMALISATION. These are scores, percentiles and edition strings the app read out
        //      of its own drop. The parse/stringify round trip preserves every number exactly; what
        //      the values must never acquire is a rounding or re-rendering of this Worker's own.
        //
        // Dropped rather than rejected when oversized, like context/history: the question still
        // answers, just without the values. Never written to ask_log below, like the ids.
        let toolResults = Array.isArray(b.tool_results) ? b.tool_results.slice(0, ASK_MAX_TOOL_RESULTS) : [];
        try { if (JSON.stringify(toolResults).length > ASK_MAX_TOOL_RESULTS_BYTES) toolResults = []; } catch { toolResults = []; }

        // Pass-through for fresh-assistant-api's designated-test-account tracing
        // (fresh_app#97). This Worker makes NO gating decision on these fields — it neither
        // knows nor checks TRACE_ACCOUNTS, that allowlist lives only on the assistant service.
        // `account_id` is NOT taken from the body: it is the verified Clerk `sub` (see the identity
        // block below), so a trace can only ever be filed under the account that actually signed
        // in. conversation_id travels through if the caller sent one, and a request_id is always
        // contributed so the chain has one even from a caller that sends none or sends garbage.
        // None of this is written to ask_log below: that table stays content-free (fresh_app#75
        // commitment 5) — the id pass-through and the rate-limit table are deliberately two
        // different things sharing this one route.
        const conversationId = /^[A-Za-z0-9_.-]{1,200}$/.test(String(b.conversation_id || "")) ? String(b.conversation_id) : null;
        const requestId = /^[A-Za-z0-9_.-]{1,200}$/.test(String(b.request_id || "")) ? String(b.request_id) : crypto.randomUUID();

        // Identity. A bearer, when present, is the caller's Clerk session JWT, verified against
        // Clerk's JWKS exactly as /api/engine/* does. Two things hang on it:
        //
        //   a. account_id. With all-users tracing on fresh-assistant-api, whatever id this route
        //      forwards decides whose trace a turn lands in. A body field is a claim anyone can
        //      make, so the body's account_id is ignored entirely and the forwarded id is the
        //      verified `sub`, or nothing. No bearer means no account_id upstream, as for any
        //      anonymous caller today.
        //   b. The development ceiling. The PUBLIC ceiling does not move: every turn is a paid
        //      model call. A verified sub listed in ASK_DEV_SUBS gets ASK_PER_HOUR_DEV instead —
        //      raised, never removed, so a lost device still costs a bounded number of calls.
        //
        // A bearer that is present but does not verify is a 401, never an untraced answer: an
        // invalid token is not a sign-in, and the app reads a fresh token on every call, so a 401
        // is the right signal to it. A bearer with Clerk unconfigured cannot be checked at all,
        // so that is a 503, not a 401 that would send a signed-in user round a sign-in loop.
        // No bearer is unchanged: public ceiling, no account_id, and no JWKS fetch, so the
        // public path costs nothing and gains no new way to fail.
        let askCeiling = ASK_PER_HOUR;
        let accountId = null;
        const askBearer = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (askBearer) {
          if (!env.CLERK_ISSUER || !env.CLERK_JWKS_URL)
            return json({ error: "sign-in verification not configured" }, 503, cors);
          const who = await verifyClerkJWT(askBearer[1], {
            issuer: env.CLERK_ISSUER,
            jwksUrl: env.CLERK_JWKS_URL,
            jwksCache: clerkJwksCache,
          });
          // Clerk's JWKS being unreachable is our outage, not a bad token: a 503, so a signed-in
          // user is not told their sign-in failed. Every other failure is the generic 401 —
          // never leak which check failed.
          if (!who.ok && who.reason === "jwks_unavailable")
            return json({ error: "sign-in verification unavailable" }, 503, cors);
          if (!who.ok) return json({ error: "unauthorized" }, 401, cors);
          if (/^[A-Za-z0-9_.@+-]{1,200}$/.test(who.sub)) accountId = who.sub;
          const devSubs = String(env.ASK_DEV_SUBS || "").split(",").map(s => s.trim()).filter(Boolean);
          if (devSubs.includes(who.sub)) askCeiling = ASK_PER_HOUR_DEV;
        }

        const hash = await ipHash(req);
        const { results: recent } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM ask_log WHERE ip_hash = ?1 AND created_at > datetime('now', '-1 hour')"
        ).bind(hash).all();
        if ((recent?.[0]?.n || 0) >= askCeiling)
          return json({ error: "too many questions — try again later" }, 429, cors);

        let upstream;
        try {
          upstream = await fetch(env.ASK_UPSTREAM.replace(/\/$/, "") + "/ask", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ASK_TOKEN}` },
            body: JSON.stringify({
              app, q, context, history, request_id: requestId,
              ...(accountId ? { account_id: accountId } : {}),
              ...(conversationId ? { conversation_id: conversationId } : {}),
              ...(toolResults.length ? { tool_results: toolResults } : {}),
            }),
            signal: AbortSignal.timeout(45000), // a model pass, not a lookup — allow a slow turn
          });
        } catch {
          return json({ error: "assistant unreachable" }, 502, cors);
        }
        if (!upstream.ok) return json({ error: `assistant failed (${upstream.status})` }, 502, cors);
        const data = await upstream.json().catch(() => null);
        if (!data) return json({ error: "bad response from assistant" }, 502, cors);

        // fresh_app#75, commitment 5: "no query text/food name/health content in any log (app
        // logs, Worker D1, crash reports)". A question asked here can carry self-reported health
        // information, so none of it reaches D1: not `q`, not a prefix or truncation of it (a
        // truncation is still content), and not `context`, `history` or `tool_results`, which
        // only ever travel in the upstream body above. What stays is non-content metadata: page,
        // surface, the rotating IP hash the ceiling counts, and how many actions came back. The
        // rate ceiling reads this table by row count only, so it needs no content to work.
        //
        // The '' is a fixed literal, not derived from `q`. It exists because the live table still
        // has the legacy `q TEXT NOT NULL` column, which SQLite cannot relax without a rebuild
        // (see schema.sql). Content-level troubleshooting for designated test accounts lives on
        // fresh-assistant-api (TRACE_ACCOUNTS), not here.
        await env.DB.prepare(
          "INSERT INTO ask_log (page, ip_hash, app, q, n_actions) VALUES (?1, ?2, ?3, '', ?4)"
        ).bind(cleanPage(b.page) || null, hash, app || null,
               Array.isArray(data.actions) ? data.actions.length : 0).run();

        return json(data, 200, cors);
      }

      // ── Engine proxy (fresh_diet plumber on Fly) — /api/engine/*, e.g. /api/engine/version.
      //
      // The engine verifies nothing itself (its Supabase auth_verify() is a different, Shiny-app
      // path — see fresh-insights#33), so it must be reachable only through this Worker: we
      // verify the caller's Clerk session JWT against Clerk's JWKS, then forward the verified
      // `sub` plus our own service token upstream. A native Expo app sends no browser Origin, so
      // ALLOWED_ORIGINS does not actually gate this route the way it gates /api/ask — the CORS
      // headers below are for parity with the other routes and any future browser caller, not a
      // security boundary here; the JWT check is. Inbound Authorization and any inbound
      // X-Fresh-User are never forwarded — the headers sent upstream are built from scratch.
      if (path.startsWith("/api/engine/")) {
        if (!env.ENGINE_UPSTREAM || !env.ENGINE_TOKEN)
          return json({ error: "engine not configured" }, 503, cors);

        const m = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (!m) return json({ error: "unauthorized" }, 401, cors);

        const verified = await verifyClerkJWT(m[1], {
          issuer: env.CLERK_ISSUER,
          jwksUrl: env.CLERK_JWKS_URL,
          jwksCache: clerkJwksCache,
        });
        // Generic 401 either way — never leak which check failed.
        if (!verified.ok) return json({ error: "unauthorized" }, 401, cors);

        // Recipe rows share engine_log (see /api/recipe/* below) but not this ceiling.
        const hash = await ipHash(req);
        const { results: recent } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM engine_log WHERE ip_hash = ?1 AND path NOT LIKE '/recipe/%' " +
          "AND created_at > datetime('now', '-1 hour')"
        ).bind(hash).all();
        if ((recent?.[0]?.n || 0) >= ENGINE_PER_HOUR)
          return json({ error: "too many requests — try again later" }, 429, cors);

        const suffix = path.slice("/api/engine".length); // e.g. "/version"
        const upstreamUrl = new URL(env.ENGINE_UPSTREAM.replace(/\/$/, "") + suffix);
        for (const [k, v] of url.searchParams) upstreamUrl.searchParams.append(k, v);

        const upstreamHeaders = new Headers({
          "Authorization": `Bearer ${env.ENGINE_TOKEN}`,
          "X-Fresh-User": verified.sub,
        });
        // Stream the body straight through to the upstream instead of buffering it as text.
        // `req.text()` decodes the body as UTF-8 and `body: raw` re-encodes that string —
        // any non-UTF-8 byte (a CP1252 Cronometer CSV, say) comes out altered, and a multipart
        // upload's boundaries are corrupted the same way. The engine's upload idempotency
        // hashes the raw bytes, so an altered body silently mints a second intake for the
        // same file. Passing `req.body` (a ReadableStream) preserves the bytes exactly and
        // never buffers the whole upload into Worker memory.
        let upstreamBody;
        let duplex;
        if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
          const contentLength = req.headers.get("Content-Length");
          if (contentLength && Number(contentLength) > ENGINE_MAX_BODY_BYTES) {
            return json({ error: "request body too large" }, 413, cors);
          }
          upstreamHeaders.set("Content-Type", req.headers.get("Content-Type") || "application/json");
          if (contentLength) upstreamHeaders.set("Content-Length", contentLength);
          upstreamBody = req.body;
          // Node's fetch (undici) requires `duplex: "half"` whenever the body is a stream, or
          // it throws synchronously. Cloudflare Workers' runtime (workerd) does not require it
          // for a streamed body but accepts it harmlessly, so setting it is safe on both.
          duplex = "half";
        }

        let upstream;
        try {
          upstream = await fetch(upstreamUrl.toString(), {
            method: req.method,
            headers: upstreamHeaders,
            body: upstreamBody,
            ...(duplex ? { duplex } : {}),
            signal: AbortSignal.timeout(ENGINE_UPSTREAM_TIMEOUT_MS),
          });
        } catch {
          return json({ error: "engine unreachable" }, 502, cors);
        }

        // Log the route label, never the instance — see routeLabelFor above. The rate-limit
        // SELECT above and this table's only other reader (a human running an ad hoc query
        // against D1 to spot a misbehaving client) both key on ip_hash/created_at and eyeball
        // `path`/`status`; neither needs the concrete id, only which route was hit.
        await env.DB.prepare(
          "INSERT INTO engine_log (path, ip_hash, status) VALUES (?1, ?2, ?3)"
        ).bind(routeLabelFor(suffix), hash, upstream.status).run();

        // Pass the engine's response through unchanged (status + body); only the CORS headers
        // are ours to add on top.
        const respHeaders = new Headers(upstream.headers);
        for (const [k, v] of Object.entries(cors)) respHeaders.set(k, v);
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      }

      // ── Recipe import and rating (fresh-assistant-api /api/recipe/*) for fresh_app.
      //
      // extract {url} is a deterministic fetch+parse, transcribe {images:[{data, media_type}]} is
      // a paid vision model call, rate {title?, servings, lines} proxies to the rate process. The
      // upstream gates all three on the same ASK_TOKEN bearer as /ask, so none of them may be
      // reachable except through here. The shape is /api/engine/*'s, not /api/ask's: the caller's
      // Clerk session JWT is verified, then the upstream request carries OUR service bearer and
      // nothing the caller sent in Authorization. Same CORS rule as the engine route too:
      // ALLOWED_ORIGINS shapes the CORS headers for a browser caller (fresh_app's web build) but is
      // not the boundary here — a native caller sends no Origin at all. The JWT is the boundary.
      //
      // The upstream's status and body pass through unchanged: fresh_app's recipeService.ts reads
      // them directly (a 503's `reason`, a 400's error, the candidates payload). Its headers do
      // not: only RECIPE_RESPONSE_HEADERS cross this hop.
      //
      // This hop's own 400, 401, 413, 503, 429 and 502 carry `reason` beside `error`, in the same
      // register as the upstream's. As of 2026-09-30 recipeService.ts reads `reason` on the rate
      // route only; extract and transcribe show the bare status.
      if (req.method === "POST" && Object.hasOwn(RECIPE_ROUTES, path)) {
        // Generic 401 either way — never leak which check failed.
        const unauthorized = () => json({ error: "unauthorized",
                                          reason: "could not verify sign-in; sign in again" }, 401, cors);
        const m = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (!m) return unauthorized();
        // As on /api/ask: a bearer that cannot be checked because Clerk is unconfigured here, or
        // because Clerk's JWKS is unreachable, is this server's outage, not a bad sign-in. A 503
        // keeps the app from telling a signed-in person to sign in again. A missing or invalid
        // token is still the 401 above and below.
        if (!env.CLERK_ISSUER || !env.CLERK_JWKS_URL)
          return json({ error: "sign-in verification not configured",
                        reason: "sign-in cannot be checked on this server right now; try again later" }, 503, cors);
        const verified = await verifyClerkJWT(m[1], {
          issuer: env.CLERK_ISSUER,
          jwksUrl: env.CLERK_JWKS_URL,
          jwksCache: clerkJwksCache,
        });
        if (!verified.ok && verified.reason === "jwks_unavailable")
          return json({ error: "sign-in verification unavailable",
                        reason: "sign-in cannot be checked right now; try again later" }, 503, cors);
        if (!verified.ok) return unauthorized();

        // After the JWT check, so an anonymous caller cannot learn whether this deploy has the
        // recipe service configured.
        if (!env.ASK_UPSTREAM || !env.ASK_TOKEN)
          return json({ error: "recipe service not configured",
                        reason: "recipe service is not configured on this server" }, 503, cors);

        // Same size cap as /api/engine/*, enforced twice: a declared Content-Length over the cap
        // is refused here before anything is claimed or forwarded, and a body with no
        // Content-Length (chunked) is counted as it is read and refused at the cap (see
        // readCapped below). transcribe's base64 photos are the large case; the upstream's own cap
        // for that route (50 MB) is looser, so a 413 here is always this hop.
        const tooLarge = () => json({ error: "request body too large",
                                      reason: "photos too large; send fewer or smaller photos" }, 413, cors);
        const contentLength = req.headers.get("Content-Length");
        if (contentLength && Number(contentLength) > ENGINE_MAX_BODY_BYTES) return tooLarge();

        // Check the ceiling and claim a slot in ONE statement, BEFORE the upstream call. Two
        // separate steps (count, then log after the call returns) let every request that arrives
        // while earlier ones are still in flight — up to RECIPE_UPSTREAM_TIMEOUT_MS each — read
        // the same count and pass, so N parallel transcribes were N paid vision calls whatever
        // the ceiling said. D1 runs one statement at a time, so this INSERT ... WHERE count < max
        // admits exactly `recipeCeiling` claims per hour and no more. Claiming first also counts
        // an attempt the upstream may have billed even when this hop then times out.
        // `status` stays NULL until the upstream answers (see recordStatus below).
        // The JWT above is already verified, so the dev check costs no second verification. The
        // tester list is RECIPE_DEV_SUBS when that secret exists and ASK_DEV_SUBS when it does not,
        // so one list governs both ceilings unless the recipe route is deliberately given its own.
        // Setting RECIPE_DEV_SUBS to a value naming no real sub (e.g. "none") turns the recipe
        // raise off while /api/ask keeps its own.
        // A sub the list does not name gets the public ceiling: no different status, body or header
        // marks that the raise exists.
        const recipeDevList = env.RECIPE_DEV_SUBS ?? env.ASK_DEV_SUBS;
        const recipeDevSubs = String(recipeDevList || "").split(",").map(s => s.trim()).filter(Boolean);
        const recipeCeiling = recipeDevSubs.includes(verified.sub) ? RECIPE_PER_HOUR_DEV : RECIPE_PER_HOUR;

        const hash = await ipHash(req);
        const claim = await env.DB.prepare(
          "INSERT INTO engine_log (path, ip_hash, status) SELECT ?1, ?2, NULL " +
          "WHERE (SELECT COUNT(*) FROM engine_log WHERE ip_hash = ?2 AND path LIKE '/recipe/%' " +
          "AND created_at > datetime('now', '-1 hour')) < ?3"
        ).bind(RECIPE_ROUTES[path], hash, recipeCeiling).run();
        if (!claim?.meta?.changes)
          return json({ error: "too many requests — try again later",
                        reason: `recipe limit reached (${recipeCeiling} per hour); try again later` }, 429, cors);
        // Best effort: the attempt is already counted, so a failed status write costs only the
        // status column — never the response the upstream already produced (and billed).
        const recordStatus = async status => {
          try {
            await env.DB.prepare("UPDATE engine_log SET status = ?1 WHERE id = ?2")
              .bind(status, claim.meta.last_row_id).run();
          } catch { /* status stays NULL */ }
        };

        // account_id. fresh-assistant-api reads `account_id` from the JSON body (the rate route
        // logs it, and forwards the body to the rate process), so whatever id this hop forwards
        // decides whose log line a call lands in. Exactly as on /api/ask, the forwarded id is the
        // verified Clerk `sub` or nothing: a body-supplied account_id is overwritten, or removed
        // when the sub is not a forwardable shape, never merely added when missing. That means
        // reading and parsing the body here instead of streaming it through, on all three routes:
        // a route the upstream does not log account_id on today must not start carrying a
        // caller's claim the day it does.
        //
        // Cost (withAccountId, measured 2026-10-01 in Node 24's V8 on a loaded Windows dev machine
        // where a bare loop over 10 MiB takes 135-155 ms): a 10 MiB photo body ~150-175 ms, a 10 MiB
        // body of 3.4M empty objects ~830 ms, a typical 2 KB rate body 0.06 ms. Memory is the read
        // copy plus an output no larger than it (~20 MB at the cap), whatever the body's shape,
        // with ~10 MB held through the upstream call. Inside Workers Paid's limits (30 s CPU by
        // default, 128 MB per isolate); over Workers Free's 10 ms CPU for any large photo body.
        //
        // A body that is not JSON or not an object is this hop's 400, never forwarded unchanged.
        // After the claim, so a caller at the ceiling costs no parse; the attempt counts like any
        // upstream 400 would.
        const badBody = () => json({ error: "invalid request body",
                                     reason: "request body must be a JSON object" }, 400, cors);

        // Headers built from scratch, as on the engine route: the inbound Authorization (the
        // user's Clerk JWT) never travels upstream.
        // Everything between the claim and the upstream's answer sits inside this try, so any
        // throw records a status on the claimed row instead of leaving it NULL behind a 500.
        // A body that cannot be read (the caller disconnected mid-upload) is the caller's
        // failure, a 400, not "recipe service unreachable".
        let raw;
        try {
          raw = await readCapped(req.body, ENGINE_MAX_BODY_BYTES);
        } catch {
          await recordStatus(400);
          return badBody();
        }
        if (!raw) {
          await recordStatus(413);
          return tooLarge();
        }
        const body = withAccountId(raw, forwardableSub(verified.sub));
        raw = null; // when withAccountId built a new body, the read copy is not held through the call
        if (!body) {
          await recordStatus(400);
          return badBody();
        }

        let upstream;
        try {
          const upstreamHeaders = new Headers({
            "Authorization": `Bearer ${env.ASK_TOKEN}`,
            "Content-Type": "application/json",
          });
          upstream = await fetch(env.ASK_UPSTREAM.replace(/\/$/, "") + path, {
            method: "POST",
            headers: upstreamHeaders,
            body,
            signal: AbortSignal.timeout(RECIPE_UPSTREAM_TIMEOUT_MS),
          });
        } catch {
          await recordStatus(502);
          return json({ error: "recipe service unreachable",
                        reason: "recipe service did not respond; try again later" }, 502, cors);
        }

        // Route label and status only — see RECIPE_ROUTES.
        await recordStatus(upstream.status);

        const respHeaders = new Headers(cors);
        for (const name of RECIPE_RESPONSE_HEADERS) {
          const v = upstream.headers.get(name);
          if (v !== null) respHeaders.set(name, v);
        }
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      }

      // ── Admin (token-guarded): review everything, hide a comment, export subscribers.
      if (path.startsWith("/admin/")) {
        const token = req.headers.get("Authorization")?.replace("Bearer ", "") || url.searchParams.get("token");
        if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: "no" }, 401, cors);
        if (path === "/admin/comments") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM comments ORDER BY created_at DESC LIMIT 1000").all();
          return json({ comments: results }, 200, cors);
        }
        if (path === "/admin/hide" && req.method === "POST") {
          const b = await req.json().catch(() => ({}));
          await env.DB.prepare("UPDATE comments SET hidden = 1 WHERE id = ?1").bind(b.id | 0).run();
          return json({ ok: true }, 200, cors);
        }
        if (path === "/admin/subscribers") {
          const { results } = await env.DB.prepare(
            "SELECT email, source, created_at FROM subscribers ORDER BY created_at DESC").all();
          return json({ subscribers: results }, 200, cors);
        }
        if (path === "/admin/feedback") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM feedback ORDER BY created_at DESC LIMIT 1000").all();
          return json({ feedback: results }, 200, cors);
        }
      }

      if (path === "/health") return json({ ok: true }, 200, cors);
      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: "server error" }, 500, cors);
    }
}

// One wrapper rather than a change at each return, so a route added later cannot forget to stamp,
// and an error path carries the version too — the 500 you are debugging names the code that threw.
export default {
  async fetch(req, env) {
    const res = await handleRequest(req, env);
    const extra = versionHeaders(env);
    if (!extra) return res;
    try {
      for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
      return res;
    } catch {
      // A Response proxied straight from an upstream fetch (the /api/engine/* path) has immutable
      // headers; rebuilding is the only way to add to it.
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(extra)) out.headers.set(k, v);
      return out;
    }
  },
};
