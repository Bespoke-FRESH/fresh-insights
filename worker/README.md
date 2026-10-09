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
- `POST /api/recipe/extract|transcribe|transcribe-video|rate` — Clerk-authenticated proxy to fresh-assistant-api; see below

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

fresh_app's recipe import and rating (`src/data/recipeService.ts`) call four
routes on fresh-assistant-api, which gates all of them on the same `ASK_TOKEN`
bearer as `/ask`. This Worker exposes them with the `/api/engine/*` shape:

```
POST /api/recipe/extract     {url}                            → upstream POST /api/recipe/extract
POST /api/recipe/transcribe  {images:[{data, media_type}]}    → upstream POST /api/recipe/transcribe
POST /api/recipe/transcribe-video  {url?, post?:{text}, media?:{data, media_type}, frames?}
                                                              → upstream POST /api/recipe/transcribe-video
POST /api/recipe/rate        {title?, servings, lines, ...}   → upstream POST /api/recipe/rate
```

1. requires `Authorization: Bearer <Clerk session JWT>`, verified exactly as on
   `/api/engine/*`;
2. claims a slot under the per-IP ceiling (below), then handles the body (see
   *Body handling*);
3. makes the top-level `account_id` the upstream reads the **verified Clerk
   `sub`**, exactly as `/api/ask` does: a caller-supplied `account_id` never
   reaches the upstream's `JSON.parse` result, and the sub is never merely added
   when missing. fresh-assistant-api's rate route logs `account_id` and forwards
   the body to the rate process, so this is what puts the real account on those
   log lines and keeps a caller's claim out of them. A sub that is not a
   forwardable shape (`[A-Za-z0-9_.@+-]{1,200}`) is sent as no account_id
   (on transcribe, `account_id: null`);
4. forwards to `ASK_UPSTREAM` + the same path with `Authorization: Bearer <ASK_TOKEN>`
   and `Content-Type: application/json`; the caller's own headers are never
   forwarded. Returns the upstream status and body unchanged — the app reads them
   directly.

### Body handling

The Cloudflare account that runs this Worker is on **Workers Free**: 10 ms CPU per request
(confirmed 2026-10-01, when the API refused a CPU-limit setting with "CPU limits
are not supported for the Free plan"). The routes split on that budget:

- **extract, rate** (at most 200 KB, fresh-assistant-api's own cap for them):
  read whole and rewritten. One pass over the bytes checks the full JSON grammar
  (and UTF-8 inside strings), removes every top-level `account_id` under any
  JSON escape spelling, and copies the other members byte for byte behind
  `{"account_id":"<sub>"`. Never `JSON.parse`, whose memory follows the body's
  shape (a 10 MB body of ~3.4M empty objects grows the heap ~230 MB). Not JSON,
  or not an object: this hop's `400`, nothing forwarded.
- **transcribe** (up to 10 MB of photos) and **transcribe-video** (up to 60 MB, the upstream's own
  cap; a base64 video rides in `media.data`): read whole, then
  `,"account_id":"<sub>"` is inserted before the closing brace (one native
  copy; only the leading and trailing whitespace are examined). `JSON.parse`
  keeps the last of duplicate keys and nothing can follow that member, so the
  `account_id` the upstream reads is the sub even if the caller sent one earlier
  (that earlier value stays in the bytes, unread). The insertion begins with a
  comma and adds no brackets, so it cannot turn an unparseable body into a
  parseable one with a different value. A body that does not start with `{` and
  end with `}` is this hop's `400`; other malformed JSON is the upstream's `400`
  (`{"error":"invalid JSON"}`), as before. The body is not streamed: a stream
  cut short (by the cap, or a bad tail) would already have delivered a prefix
  such as `{"account_id":"theirs"}`, and whether the upstream parsed it would
  depend on every hop aborting rather than ending the connection.

All four routes send the upstream a complete body with a `Content-Length`, and
nothing at all when this hop refuses the request.

| Condition | Response |
|---|---|
| No bearer, or a bearer that fails verification (bad signature, expired, wrong issuer, unknown key) | `401 {"error":"unauthorized","reason":"could not verify sign-in; sign in again"}` |
| A bearer, but `CLERK_ISSUER` or `CLERK_JWKS_URL` not set | `503 {"error":"sign-in verification not configured","reason":...}` |
| A bearer, but Clerk's JWKS unreachable or answering non-2xx | `503 {"error":"sign-in verification unavailable","reason":...}` |
| `ASK_UPSTREAM` or `ASK_TOKEN` not set (checked after the JWT) | `503 {"error":"recipe service not configured","reason":...}` |
| Declared `Content-Length` over the route's cap (transcribe-video 60 MB, transcribe 10 MB, extract/rate 200 KB) | `413 {"error":"request body too large","reason":...}`, before a slot is claimed |
| Chunked body that runs past the route's cap as it is read | `413`, same body; the attempt counts, logged as `413` |
| Body cannot be read (caller disconnected mid-upload) | `400`, same body as below; logged as `400` |
| Over the per-IP ceiling | `429` with `error` and `reason` (the app shows `reason`); the body is not read |
| extract/rate: body not UTF-8 JSON, or not an object (array, string, number, `null`, empty) | `400 {"error":"invalid request body","reason":"request body must be a JSON object"}`; nothing forwarded; logged as `400` |
| transcribe, transcribe-video: body not starting with `{` and ending with `}` (or empty) | the same `400`; logged as `400` |
| Upstream unreachable or over the 60 s timeout | `502` with `error` and `reason` |
| Any upstream status (400, 500, 503, ...) | passed through with its body |

The two `503`s for sign-in follow `/api/ask`: when the bearer cannot be checked
at all, that is this server's outage, and a `401` would have the app tell a
signed-in person to sign in again.

Cost, measured 2026-10-01 in Node 24's V8 on a loaded Windows dev machine
(where a bare loop over 10 MiB took 135-155 ms):

| Body | Time | Memory |
|---|---|---|
| typical 2 KB rate body (scan) | ~0.1 ms | negligible |
| 200 KB rate body, the cap (scan) | ~3 ms median | ~0.4 MB |
| 200 KB of empty objects, worst shape found (scan) | ~4 ms median | ~0.4 MB |
| 10 MiB photo body (read in 64 KB chunks, then insert) | ~11 ms read (including the test's own stream source) + ~5 ms insert | read copy + output, ~20 MB |

The full scan on a 10 MiB photo body would take ~150 ms on the same machine, far
over Workers Free's 10 ms, which is why transcribe only inserts. The read and the
insert are native copies; on this machine a bare JS loop over 10 MiB took
135-155 ms, so Cloudflare's figure will be lower. It is checked live after deploy.

#### transcribe-video: size, memory and CPU

The 60 MB cap matches fresh-assistant-api's. Three platform limits sit around it. The first is the
only one that is documented here as a number; the other two are the reason the read is built the
way it is, and **none of the three has been exercised on Cloudflare itself** (the deploy probe is
unauthenticated, so it stops at the `401`).

- **Request body size.** Cloudflare's published ceiling is 100 MB on Free and Pro (200 MB Business,
  500 MB Enterprise); 60 MB is under it. Taken from Cloudflare's Workers limits page from memory, not
  re-read when this was written: confirm it there before relying on a larger cap.
- **Memory, 128 MB per isolate.** Joining the stream's chunks and then copying the body again to add
  `account_id` is three copies of it, ~120 MB of buffers at 60 MB, measured. So for the two media
  routes, when the request declares a `Content-Length`, the bytes are written once into a buffer
  with 256 spare bytes, and `account_id` goes into that room (`insertAccountId(bytes, id, true)`);
  only the closing brace and trailing whitespace move. Measured 2026-10-09 in Node 22, a 60 MB body
  through the real handler: **~80 MB peak** of buffers with a `Content-Length` (60 MB of it the
  body, the rest not-yet-collected 64 KB chunks), **~120 MB** without one (the chunk-list path
  above). A mobile `fetch` with a string body sends the header; a chunked 60 MB upload may not fit
  the isolate. The in-place write is only done to a buffer `readCapped` allocated itself, never to a
  window into a buffer the stream handed over.
- **CPU, 10 ms per request on Workers Free.** Reading is now one native copy of 60 MB. On a Node
  dev machine that read took ~65 ms wall including the test's own chunk source, so it is not
  established that it fits 10 ms. The Workers Paid plan raises the limit (30 s default), and
  `wrangler.toml` has no `[limits]` block because Free refuses one. If a real video upload fails
  with Cloudflare error 1102 (exceeded resources), that is this limit, and the choices are the paid
  plan or sending `url` / `post.text` / sampled `frames` instead of the whole video.

A request of only `{url}` or `{post}` is a few hundred bytes and not affected by any of this.

Timeouts on `/api/recipe/rate`, outermost first: fresh_app aborts at **30 s**
(`recipeService.ts` `REQUEST_TIMEOUT_MS`), this Worker at **60 s**
(`RECIPE_UPSTREAM_TIMEOUT_MS`), fresh-assistant-api answers `503` itself at
**27 s** (`RATE_TIMEOUT_MS`, fresh-assistant-api PR #51). The Worker never cuts
the call off before the upstream's own answer.

Rate limit: **30/hour per rotating daily IP hash**, its own ceiling (transcribe and
transcribe-video are paid model calls) and not a share of the engine's 60. All four recipe routes
count against the one ceiling, since the count is over every `/recipe/%` label; listed
`RECIPE_DEV_SUBS` / `ASK_DEV_SUBS` subs get 200. Each request claims its
`engine_log` row *before* the upstream call, in one `INSERT ... WHERE count < 30`
statement, so parallel requests cannot overshoot the ceiling and an attempt that
times out still counts. The row holds a fixed label (`/recipe/extract`,
`/recipe/transcribe`, `/recipe/transcribe-video`, `/recipe/rate`) and, once the upstream answers, its status
(`NULL` while in flight); never the URL, the body, or the caller's `sub`. The
engine's ceiling excludes these rows. No schema change: `engine_log` already exists.

CORS follows the engine rule: `ALLOWED_ORIGINS` shapes the headers for a browser
caller (the app's Expo web build on `localhost:8081`/`8083`/`8085`/`8086`, listed in
`wrangler.toml`) but is not the boundary — the JWT is. `Access-Control-Allow-Headers`
includes `Authorization` so a browser preflight for a bearer request succeeds.
