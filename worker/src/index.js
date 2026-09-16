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

// Module-level so the JWKS cache survives across requests within the same warm isolate.
const clerkJwksCache = createJwksCache();

function corsHeaders(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
  const ok = allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] || "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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

export default {
  async fetch(req, env) {
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
        // knows nor checks TRACE_ACCOUNTS, that allowlist lives only on the assistant service —
        // it only carries account_id/conversation_id through if the caller sent one, and always
        // contributes a request_id so the chain has one even from a caller that sends none or
        // sends garbage. None of this is written to ask_log below: that table stays exactly as
        // content-free as it is today (fresh_app#75 commitment 5) — the id pass-through and the
        // production-telemetry table are deliberately two different things sharing this one route.
        const accountId = /^[A-Za-z0-9_.@+-]{1,200}$/.test(String(b.account_id || "")) ? String(b.account_id) : null;
        const conversationId = /^[A-Za-z0-9_.-]{1,200}$/.test(String(b.conversation_id || "")) ? String(b.conversation_id) : null;
        const requestId = /^[A-Za-z0-9_.-]{1,200}$/.test(String(b.request_id || "")) ? String(b.request_id) : crypto.randomUUID();

        // Development ceiling. fresh_app is hand-tested against the LIVE Worker, where ten
        // questions an hour is a lock-out within minutes, and every locked-out turn is also one a
        // coordinating session cannot spend probing. The PUBLIC ceiling does not move: every turn
        // is a paid model call. So the ceiling is raised for one named, verified identity and for
        // nobody else. Four properties, each load-bearing:
        //
        //   1. VERIFIED, NOT CLAIMED. `account_id` below travels through ungated and is forgeable
        //      by anyone — this route authenticates nothing — so keying a ceiling on it would hand
        //      an unmetered paid endpoint to whoever learns one Clerk user id. This reads the same
        //      Clerk session JWT that /api/engine/* verifies, against Clerk's JWKS. The
        //      pass-through fields stay exactly as ungated as they are today; a claimed id still
        //      decides nothing here.
        //   2. RAISED, NOT REMOVED. A bypass on a paid model endpoint is a different risk class
        //      from a looser ceiling: ASK_PER_HOUR_DEV still bounds what a lost device can spend.
        //   3. SILENT, AND FAILS CLOSED. No Authorization header, an unverifiable one, a sub that
        //      is not listed, or an empty ASK_DEV_SUBS all land on the public ceiling — never a
        //      401, never a different body, never a hint that this block exists. Unset var, no
        //      feature. The JWKS fetch happens only when a bearer is actually present, so the
        //      public path costs nothing and gains no new way to fail.
        //   4. NO SHAPE CHANGE. fresh_app parses this response; nothing here touches it.
        let askCeiling = ASK_PER_HOUR;
        const devSubs = String(env.ASK_DEV_SUBS || "").split(",").map(s => s.trim()).filter(Boolean);
        const askBearer = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (devSubs.length && askBearer && env.CLERK_ISSUER && env.CLERK_JWKS_URL) {
          const dev = await verifyClerkJWT(askBearer[1], {
            issuer: env.CLERK_ISSUER,
            jwksUrl: env.CLERK_JWKS_URL,
            jwksCache: clerkJwksCache,
          });
          if (dev.ok && devSubs.includes(dev.sub)) askCeiling = ASK_PER_HOUR_DEV;
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

        // Logged like retrieval: what was asked, from which page and surface, never who
        // asked it (ip_hash rotates daily and is not reversible). The rate ceiling reads
        // this table, so only turns that actually reached the model count against it.
        await env.DB.prepare(
          "INSERT INTO ask_log (page, ip_hash, app, q, n_actions) VALUES (?1, ?2, ?3, ?4, ?5)"
        ).bind(cleanPage(b.page) || null, hash, app || null, q,
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

        const hash = await ipHash(req);
        const { results: recent } = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM engine_log WHERE ip_hash = ?1 AND created_at > datetime('now', '-1 hour')"
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
  },
};
