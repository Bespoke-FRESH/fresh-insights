# fresh-insights-engage

The long-term, self-owned engagement backend for insights.freshfoodrecs.com:
**comments** (name + comment, no reader account needed), **subscribe**, and
**feedback** — all stored in our own Cloudflare D1 database. Nothing goes to a
third party. Replaces giscus (GitHub-account comments) once deployed.

## One-time setup (Josh — ~2 minutes)

Authorize wrangler against the Cloudflare account (the same one that holds the
FRESH R2 buckets). Either:

```bash
npx wrangler login
```

(opens the browser; approve), **or** create an API token in the Cloudflare
dashboard (My Profile → API Tokens → template “Edit Cloudflare Workers”, plus
D1 edit) and set `CLOUDFLARE_API_TOKEN` in the environment.

Then say the word — Claude runs the rest:

```bash
cd worker
npx wrangler d1 create fresh-insights-engage    # paste database_id into wrangler.toml
npx wrangler d1 execute fresh-insights-engage --remote --file=schema.sql
npx wrangler secret put ADMIN_TOKEN             # any long random string; keep it
npx wrangler deploy                             # → https://fresh-insights-engage.<acct>.workers.dev
```

After deploy, the site's comment sections and subscribe/feedback forms are
switched from giscus/mailto to this API (native house-styled UI, one PR).
Optionally add a custom hostname later (api.freshfoodrecs.com needs the zone on
Cloudflare; the workers.dev URL works fine meanwhile).

## Endpoints

- `GET  /api/comments?page=/slug/` — visible comments for a page
- `POST /api/comments` `{page, name, body}` — honeypot field `website`; 5/hour/IP/page
- `POST /api/subscribe` `{email, source}` — deduped
- `POST /api/feedback` `{page, body, email?}`
- `GET  /admin/comments|subscribers|feedback` + `POST /admin/hide {id}` — `Authorization: Bearer <ADMIN_TOKEN>`
- `*    /api/engine/*` — Clerk-authenticated proxy to the fresh_diet engine; see below
- `POST /api/recipe/extract|transcribe|rate` — Clerk-authenticated proxy to fresh-assistant-api; see below

Moderation model: comments appear immediately, `POST /admin/hide` retracts;
IP hashes rotate daily so they are not long-term identifiers.

## `/api/retrieve` — corpus lookup for essays

Proxies `fresh-assistant-api`'s `/retrieve` so a page can pull the passages behind a claim.
The proxy exists because this Worker already holds the origin allowlist and per-IP limiting
the Fly service lacks, and it can carry the bearer token that unlocks the model-backed
answer pass — a browser cannot keep a secret.

```
POST /api/retrieve  {q, k?: 1-8 = 5, answer?: false, page?}
  → the upstream response: {hits: [...], answer: null | {mode, text, cited, unresolvable_citations}}
```

Limits are per rotating daily IP hash: **40/hour** for passage lookup (deterministic, free
upstream) and **10/hour** when `answer: true` (one model call each). Lookups are recorded in
`retrieval_log` for rate limiting and to learn which claims readers check — never who checked
them.

### Config

```bash
npx wrangler secret put RETRIEVE_TOKEN      # must match the API's RETRIEVE_TOKEN
npx wrangler d1 execute fresh-insights-engage --remote --file=schema.sql   # adds retrieval_log
```

| Var | Effect |
|---|---|
| `RETRIEVE_UPSTREAM` | base URL of fresh-assistant-api. **Unset ⇒ the route returns 503**, so the panel fails closed |
| `RETRIEVE_TOKEN` | secret; sent as `Authorization: Bearer` upstream |
| `RETRIEVE_ANSWERS` | set to `off` to serve passages only, without redeploying the site |

The reader-facing panel is `_corpus-sources.html`, opt-in per essay.

## `/api/engine/*` — fresh_diet engine proxy (Clerk-authenticated)

Proxies to the fresh_diet plumber engine on Fly for the fresh_app consumer app
(fresh-insights#33). The engine verifies nothing itself by design — its
`auth_verify()` is a separate Supabase path used only by the Shiny app — so
**the engine must be reachable only through this Worker.** This route:

1. requires `Authorization: Bearer <Clerk session JWT>` and verifies it against
   Clerk's JWKS (RS256; `exp`/`nbf`/`iss` checked; JWKS cached in-memory with a
   1-hour TTL, refetched once on an unknown `kid` to pick up key rotation);
2. on success, forwards the request to `ENGINE_UPSTREAM` with the inbound
   `Authorization` **replaced** by `Authorization: Bearer <ENGINE_TOKEN>` (the
   service token) and the verified Clerk `sub` set in `X-Fresh-User` — any
   inbound `Authorization` or `X-Fresh-User` from the caller is discarded, never
   forwarded;
3. forwards method, path suffix, query string, and JSON body; returns the
   engine's response status and body unchanged.

```
GET  /api/engine/version   → engine GET /version   (first target; returns a chat_tool_envelope)
*    /api/engine/<suffix>  → engine <method> /<suffix>
```

Failure modes:

| Condition | Response |
|---|---|
| `ENGINE_UPSTREAM` or `ENGINE_TOKEN` not set | `503` — fails closed, matching `/api/ask` and `/api/retrieve` |
| Missing/invalid/expired/wrong-issuer JWT | `401 {"error":"unauthorized"}` — generic on every failure reason, request never reaches the engine |
| Over the per-IP ceiling | `429` |
| Engine unreachable | `502` |

Rate limit: **60/hour per rotating daily IP hash** (`engine_log`), looser than
`/api/ask`'s because these are compute calls on an already-authenticated
caller, not paid model calls. `ALLOWED_ORIGINS`/CORS is applied for parity with
the other routes but is not the security boundary here — a native Expo app
sends no browser `Origin`, so the JWT check is what actually gates this route.

### Why the engine can't be reached directly

Fly-side, `fresh-diet-engine` must accept only requests carrying the shared
service token. Concretely: reject (401/403) any request whose
`Authorization: Bearer <ENGINE_TOKEN>` header doesn't match the configured
token, and take the authenticated user id from `X-Fresh-User` (set by this
Worker after JWT verification, never trusted from an inbound caller directly).
As of this writing the engine (`fresh_diet` PR #76) serves `/healthz` and
`/version` but does not yet enforce this — see the comment left on that PR.
Until it does, the engine is *intended* to be reachable only through this
Worker but is not yet *enforced* to be.

### Config

```bash
npx wrangler secret put ENGINE_TOKEN        # service token; must match what the Fly engine checks
npx wrangler d1 execute fresh-insights-engage --remote --file=schema.sql   # adds engine_log
```

| Var | Effect |
|---|---|
| `ENGINE_UPSTREAM` | base URL of the fresh_diet plumber engine on Fly. **Unset ⇒ 503** |
| `ENGINE_TOKEN` | secret; sent as `Authorization: Bearer` upstream. **Unset ⇒ 503** |
| `CLERK_ISSUER` | expected `iss` claim on the caller's JWT (dev instance value checked in) |
| `CLERK_JWKS_URL` | Clerk JWKS endpoint for that instance (public by design, not a secret) |

## `/api/recipe/*` — recipe import and rating (Clerk-authenticated)

fresh_app's recipe import and rating (`src/data/recipeService.ts`) call three
routes on fresh-assistant-api, which gates all of them on the same `ASK_TOKEN`
bearer as `/ask`. This Worker exposes them with the `/api/engine/*` shape:

```
POST /api/recipe/extract     {url}                            → upstream POST /api/recipe/extract
POST /api/recipe/transcribe  {images:[{data, media_type}]}    → upstream POST /api/recipe/transcribe
POST /api/recipe/rate        {title?, servings, lines, ...}   → upstream POST /api/recipe/rate
```

1. requires `Authorization: Bearer <Clerk session JWT>`, verified exactly as on
   `/api/engine/*`;
2. claims a slot under the per-IP ceiling (below), then reads the body (up to
   10 MB) and requires it to be UTF-8 JSON whose top level is an object;
3. sets the body's top-level `account_id` to the **verified Clerk `sub`**, exactly
   as `/api/ask` does: a caller-supplied `account_id` is overwritten (or removed,
   if the `sub` is not a forwardable shape, `[A-Za-z0-9_.@+-]{1,200}`), never
   merely added when missing. fresh-assistant-api's rate route logs `account_id`
   and forwards the body to the rate process, so this is what puts the real
   account on those log lines and keeps a caller's claim out of them;
4. forwards to `ASK_UPSTREAM` + the same path with `Authorization: Bearer <ASK_TOKEN>`
   and `Content-Type: application/json`; the caller's own headers are never
   forwarded. Returns the upstream status and body unchanged — the app reads them
   directly.

The body is never handed to `JSON.parse`. One pass over the bytes checks the
full JSON grammar (and UTF-8 inside strings) and copies every top-level member
except `account_id` into the outgoing body, byte for byte, behind
`{"account_id":"<sub>"`. A base64 photo is copied once and never decoded. A
top-level `account_id` is recognised under any JSON escape spelling and every
duplicate is removed; nested `account_id` keys are left alone; only whitespace
between top-level members is dropped. A full parse was ruled out in code review:
its memory follows the body's shape, and a 10 MB body of ~3.4M empty objects grows
the heap by ~230 MB, past a Worker isolate's 128 MB.

| Condition | Response |
|---|---|
| No bearer, or a bearer that fails verification (bad signature, expired, wrong issuer, unknown key) | `401 {"error":"unauthorized","reason":"could not verify sign-in; sign in again"}` |
| A bearer, but `CLERK_ISSUER` or `CLERK_JWKS_URL` not set | `503 {"error":"sign-in verification not configured","reason":...}` |
| A bearer, but Clerk's JWKS unreachable or answering non-2xx | `503 {"error":"sign-in verification unavailable","reason":...}` |
| `ASK_UPSTREAM` or `ASK_TOKEN` not set (checked after the JWT) | `503 {"error":"recipe service not configured","reason":...}` |
| Declared `Content-Length` over 10 MB (the engine route's cap) | `413 {"error":"request body too large","reason":...}`, before a slot is claimed |
| Chunked body that reaches past 10 MB as it is read | `413`, same body; the attempt counts, logged as `413` |
| Body cannot be read (caller disconnected mid-upload) | `400`, same body as below; logged as `400` |
| Over the per-IP ceiling | `429` with `error` and `reason` (the app shows `reason`); the body is not read |
| Body not UTF-8 JSON, or JSON whose top level is not an object (array, string, number, `null`, empty) | `400 {"error":"invalid request body","reason":"request body must be a JSON object"}`; nothing forwarded; logged as `400` |
| Upstream unreachable or over the 60 s timeout | `502` with `error` and `reason` |
| Any upstream status (400, 500, 503, ...) | passed through with its body |

The two `503`s for sign-in follow `/api/ask`: when the bearer cannot be checked
at all, that is this server's outage, and a `401` would have the app tell a
signed-in person to sign in again.

Cost of reading the body, measured 2026-10-01 in Node 24's V8 on a loaded
Windows dev machine (where a bare loop over 10 MiB took 135-155 ms and
`JSON.parse` of a 10 MiB string 72-90 ms):

| Body | Time | Memory |
|---|---|---|
| 10 MiB photo body (the cap) | ~150-175 ms | read copy + output, ~20 MB; ~10 MB held through the upstream call |
| 10 MiB of 3.4M empty objects (worst case found) | ~830 ms | same ~20 MB, no growth with shape |
| typical 2 KB rate body | 0.06 ms | negligible |

All three are inside Workers Paid's limits (30 s CPU by default, 128 MB per
isolate). The photo and empty-object rows are over Workers Free's 10 ms CPU.

Timeouts on `/api/recipe/rate`, outermost first: fresh_app aborts at **30 s**
(`recipeService.ts` `REQUEST_TIMEOUT_MS`), this Worker at **60 s**
(`RECIPE_UPSTREAM_TIMEOUT_MS`), fresh-assistant-api answers `503` itself at
**27 s** (`RATE_TIMEOUT_MS`, fresh-assistant-api PR #51). The Worker never cuts
the call off before the upstream's own answer.

Rate limit: **30/hour per rotating daily IP hash**, its own ceiling (transcribe is a
paid vision call) and not a share of the engine's 60. Each request claims its
`engine_log` row *before* the upstream call, in one `INSERT ... WHERE count < 30`
statement, so parallel requests cannot overshoot the ceiling and an attempt that
times out still counts. The row holds a fixed label (`/recipe/extract`,
`/recipe/transcribe`, `/recipe/rate`) and, once the upstream answers, its status
(`NULL` while in flight); never the URL, the body, or the caller's `sub`. The
engine's ceiling excludes these rows. No schema change: `engine_log` already exists.

CORS follows the engine rule: `ALLOWED_ORIGINS` shapes the headers for a browser
caller (the app's Expo web build on `localhost:8081`/`8083`/`8085`/`8086`, listed in
`wrangler.toml`) but is not the boundary — the JWT is. `Access-Control-Allow-Headers`
includes `Authorization` so a browser preflight for a bearer request succeeds.
