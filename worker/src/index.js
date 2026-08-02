// fresh-insights-engage — comments / subscribe / feedback API.
// All data lives in our own D1 database; no third party sees a reader's email.

const MAX_BODY = 4000;
const MAX_NAME = 80;
const POSTS_PER_HOUR = 5; // per ip_hash per page
const RETRIEVE_PER_HOUR = 40;         // passage lookup: deterministic upstream, costs nothing
const RETRIEVE_ANSWERS_PER_HOUR = 10; // answer pass: one model call each, so a tighter ceiling

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
            body: JSON.stringify({ q, k, answer: wantAnswer }),
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
