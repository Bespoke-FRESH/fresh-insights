// The invite link's preview: what a messenger's link card and the invite page show for one code
// (Josh, 2026-11-15: "can we include the recipe image on the invite somewhere (not the login), or the
// weekly plan (some info about it), general invite can just use the fresh logo").
//
// Two routes, one lookup:
//   GET /invite/?code=…               the invite page, fetched from the site (INVITE_ORIGIN) and served
//                                     with its og/twitter tags rewritten to the code's preview. Messengers
//                                     (iMessage) read these tags without running scripts, so they must be
//                                     in the served HTML. The page reads the same preview from an inline
//                                     JSON block, so the link card and the page cannot disagree.
//   GET /api/invite/preview?code=…    the same preview as JSON, for the page when it is served straight
//                                     from GitHub Pages (no Worker in front of it).
//
// The lookup is a Supabase RPC called with the project's anon key (SUPABASE_URL, SUPABASE_ANON_KEY:
// secrets set with `wrangler secret put`, never in this public repo). Unset, failed, slow or empty, the
// general invite is served: the page exactly as the site has it.
//
// Nothing the caller sent reaches the output. The code is used only as the lookup key; `by`, `from`,
// `kind` on the link are never read here. Every value from the lookup is cut to a plain string of a
// bounded length and escaped where it is placed; a photo is accepted only as an https URL.

// ---------------------------------------------------------------------------------------------
// THE ONE CONFIG SPOT for the lookup's shape: fresh_app's `public.invite_preview(p_code text)`, granted to
// anon (fresh_app#1064, supabase/migrations/20261115160000_recipe_invites.sql, head 971a37d). If the function
// changes, change the names here and nothing else.
// ---------------------------------------------------------------------------------------------
export const INVITE_PREVIEW_RPC = {
  fn: "invite_preview",          // POST {SUPABASE_URL}/rest/v1/rpc/<fn>; returns a table (0 or 1 row)
  codeParam: "p_code",
  fields: {
    kind: "kind",                    // 'general' | 'plan' | 'event' | 'recipe'
    senderName: "sender",            // the sender's first name
    recipeTitle: "recipe_title",
    recipePhotoUrl: "recipe_photo",  // https, or null (a catalog recipe has no public photo address yet)
    planName: "plan_name",
    dinnerCount: "dinners",          // dinners planned in the group
    startsOn: "starts_on",           // date, 'YYYY-MM-DD' (the event's own days, else the first and last dinner)
    endsOn: "ends_on",
  },
  // A plan and an event (a plan group with its own days) draw the same card.
  kinds: { recipe: ["recipe"], plan: ["plan", "event"] },
};

export const PREVIEW_TTL_MS = 5 * 60 * 1000; // "cache a preview briefly (minutes) by code"
const PREVIEW_TIMEOUT_MS = 3000;             // a messenger waits a few seconds for a card, no more
const PREVIEW_CACHE_MAX = 500;
const DEFAULT_ORIGIN = "https://insights.freshfoodrecs.com";
// The general card's mark: a plan has no picture of its own, and a recipe without an https photo falls
// back to the image the general invite already uses.
const MARK_IMAGE = "/fresh-mark.png";
const GENERAL_IMAGE = "/invite/invite-card.png";

// The page's own code rule (invite/index.qmd): letters, digits and hyphens, at most 32.
const CODE_SHAPE = /^[A-Za-z0-9-]{1,32}$/;

export function inviteCode(url) {
  const raw = url.searchParams.get("code") || "";
  return CODE_SHAPE.test(raw) ? raw : null;
}

// A plain one-line string of at most `max` characters, or null.
function cleanText(v, max) {
  if (typeof v !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "\u2026" : s;
}

export function httpsUrl(v) {
  if (typeof v !== "string" || v.length > 2048) return null;
  let u;
  try { u = new URL(v); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  return u.href;
}

// A service address (the site, Supabase): https, or plain http on this machine for `wrangler dev`.
function serviceUrl(v) {
  if (typeof v !== "string") return null;
  try {
    const u = new URL(v);
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1") && !u.username && !u.password) return u.href;
  } catch { return null; }
  return httpsUrl(v);
}

function dinnerCount(v) {
  const n = typeof v === "string" && /^\d{1,3}$/.test(v) ? Number(v) : v;
  return Number.isInteger(n) && n >= 1 && n <= 999 ? n : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// A Postgres date as PostgREST sends it ('2026-11-17'), read as a calendar day (UTC, so no timezone shift).
function calendarDay(v) {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? null : d;
}

// "Nov 17", "Nov 17–21", "Nov 28 – Dec 2"; null when neither day is readable.
export function dateRange(startsOn, endsOn) {
  let a = calendarDay(startsOn), b = calendarDay(endsOn);
  if (!a && !b) return null;
  if (!a || !b) return `${MONTHS[(a || b).getUTCMonth()]} ${(a || b).getUTCDate()}`;
  if (b < a) [a, b] = [b, a];
  const day = d => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (a.getTime() === b.getTime()) return day(a);
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) return `${day(a)}–${b.getUTCDate()}`;
  return `${day(a)} – ${day(b)}`;
}

// The lookup's row -> the card both surfaces show, or null for the general invite.
// { kind: "recipe"|"plan", title, description, image (absolute https), photo (bool) }
export function previewCard(row, origin = DEFAULT_ORIGIN) {
  if (!row || typeof row !== "object") return null;
  const f = INVITE_PREVIEW_RPC.fields;
  const kind = row[f.kind];
  const name = cleanText(row[f.senderName], 40);
  if (INVITE_PREVIEW_RPC.kinds.recipe.includes(kind)) {
    const recipe = cleanText(row[f.recipeTitle], 120);
    if (!recipe) return null;
    const photo = httpsUrl(row[f.recipePhotoUrl]);
    return {
      kind: "recipe",
      title: `${name || "A friend"} sent you a recipe`,
      description: recipe,
      image: photo || origin + GENERAL_IMAGE,
      photo: Boolean(photo),
    };
  }
  if (INVITE_PREVIEW_RPC.kinds.plan.includes(kind)) {
    const plan = cleanText(row[f.planName], 80);
    const n = dinnerCount(row[f.dinnerCount]);
    const range = dateRange(row[f.startsOn], row[f.endsOn]);
    const dinners = [n ? `${n} ${n === 1 ? "dinner" : "dinners"}` : null, range].filter(Boolean).join(", ");
    const description = [plan, dinners].filter(Boolean).join(" \u00b7 ");
    if (!description) return null;
    return {
      kind: "plan",
      title: `${name || "A friend"} invited you to plan meals together`,
      description,
      image: origin + MARK_IMAGE,
      photo: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The lookup, cached per isolate by code. A completed lookup (a card or "nothing for this code") is kept
// for PREVIEW_TTL_MS; a failure is not kept, so the next request tries again. The Cache API is not used:
// it is a no-op on workers.dev, where this Worker runs today.
// ---------------------------------------------------------------------------------------------
const previewCache = new Map();

export function clearPreviewCache() { previewCache.clear(); }

export async function lookupPreview(code, env, now = Date.now()) {
  if (!code || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const hit = previewCache.get(code);
  if (hit && hit.exp > now) return hit.card;
  if (hit) previewCache.delete(code);
  const base = serviceUrl(env.SUPABASE_URL);
  if (!base) return null;
  let row;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/rest/v1/rpc/${INVITE_PREVIEW_RPC.fn}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": env.SUPABASE_ANON_KEY,
        "Authorization": `Bearer ${env.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ [INVITE_PREVIEW_RPC.codeParam]: code }),
      redirect: "manual", // Workers has no "error" mode; a 3xx is not ok, so it is a failed lookup
      signal: AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // A set-returning function comes back as an array, a scalar/jsonb one as the object itself.
    row = Array.isArray(data) ? data[0] : data;
  } catch {
    return null;
  }
  const card = previewCard(row, inviteOrigin(env));
  if (previewCache.size >= PREVIEW_CACHE_MAX) previewCache.delete(previewCache.keys().next().value);
  previewCache.set(code, { card, exp: now + PREVIEW_TTL_MS });
  return card;
}

// ---------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// JSON safe inside <script type="application/json">: no "</script>", no "<!--", no line separators.
export function scriptJson(v) {
  return JSON.stringify(v)
    .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function headTags(card) {
  const t = escapeHtml(card.title), d = escapeHtml(card.description), i = escapeHtml(card.image);
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="FRESH">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${i}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
    `<script type="application/json" id="fi-invite-preview-data">${scriptJson(card)}</script>`,
  ].join("\n");
}

const removeEl = { element(el) { el.remove(); } };

export function inviteOrigin(env) {
  return (serviceUrl(env.INVITE_ORIGIN || DEFAULT_ORIGIN) || DEFAULT_ORIGIN).replace(/\/$/, "");
}

// Serve the site's invite page with the code's preview. Served from another host than the site (the
// workers.dev address), a <base> makes the page's relative links (../site_libs, ../fresh-mark.png)
// resolve against the site.
export async function invitePage(req, env) {
  const url = new URL(req.url);
  const origin = inviteOrigin(env);
  const page = await fetch(`${origin}/invite/`, { headers: { "Accept": "text/html" } });
  if (!page.ok || !(page.headers.get("Content-Type") || "").includes("text/html")) return page;
  const card = await lookupPreview(inviteCode(url), env);
  const sameHost = new URL(origin).host === url.host;

  let rw = new HTMLRewriter();
  if (card) {
    rw = rw
      .on('meta[property^="og:"]', removeEl)
      .on('meta[name^="twitter:"]', removeEl)
      .on('meta[name="description"]', removeEl)
      .on("title", removeEl);
  }
  rw = rw.on("head", {
    element(el) {
      if (!sameHost) el.prepend(`<base href="${escapeHtml(origin + "/invite/")}">`, { html: true });
      if (card) el.append(headTags(card), { html: true });
    },
  });
  const out = rw.transform(new Response(page.body, page));
  const res = new Response(out.body, { status: 200, headers: out.headers });
  for (const h of ["ETag", "Last-Modified", "Content-Length", "Age", "Expires"]) res.headers.delete(h);
  res.headers.set("Content-Type", "text/html; charset=utf-8");
  res.headers.set("Cache-Control", "public, max-age=300");
  return res;
}

export async function previewJson(req, env, cors) {
  const card = await lookupPreview(inviteCode(new URL(req.url)), env);
  return new Response(JSON.stringify({ preview: card }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300", ...cors },
  });
}
