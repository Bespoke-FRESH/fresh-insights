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
- `POST /api/recipe/extract|transcribe|transcribe-video|rate|image|archive-video|suggest-swaps|photo` — Clerk-authenticated proxy to fresh-assistant-api; see below
- `POST /api/plan/ideas|idea-image`, `POST /api/recipe/steps` and `POST /api/recipe/allergy-check` — Clerk-authenticated proxy to fresh-assistant-api's Plan my week idea list, its idea pictures and the saved-recipe allergy check (docs/api/recipe_write_contract.md sections 4d and 4e). The verified account id goes in the body, the verified token goes upstream as `X-User-Token` on the ideas list and the allergy check (they read the person's saved allergies with it), and each route has its own per-account ceiling (60 / 30 / 120 an hour, 200 / 100 / 400 for a listed tester) over its own `engine_log` label.
- `POST /api/recipe/photo/upload` `{image:{media_type,data}, recipe_id}` — Clerk-authenticated, handled as `/api/recipe/write` is: forwards to fresh-assistant-api at the same path with `ASK_TOKEN`, `X-Account-Id` (the verified Clerk `sub`) and `X-User-Token`; its own per-account ceiling (60 an hour, 200 for a listed tester, address backstop 5x) over the `/recipe/photo/upload` label, apart from the import count; body cap 8 MB (a base64 image up to 5 MB decoded); 40 s upstream timeout. Contract: fresh-assistant-api `docs/api/recipe_photo_upload_contract.md`.
- `POST /api/recipe/photo/purge-account` `{}` — Clerk-authenticated (the signature check is required: the route deletes every photo the account holds, and the API does not verify the token), handled as `/api/recipe/photo/upload` is: forwards to fresh-assistant-api at the same path with `ASK_TOKEN`, `X-Account-Id` (the verified Clerk `sub`) and `X-User-Token`; its own per-account ceiling (6 an hour, 20 for a listed tester, address backstop 5x) over the `/recipe/photo/purge-account` label, apart from the import count; no media, an empty body or `{}` is accepted and a body over 1 KB is a 413; 60 s upstream timeout (the purge deletes R2 objects one at a time).
- `GET  /api/food/{fndds|sr}/{code}/{attributes|ledger}` — Clerk-authenticated proxy to fresh-assistant-api's per-food attribute panel and served ledger view; see below
- `GET  /api/record/{item_id}` — Clerk-authenticated proxy to fresh-assistant-api's scoring record of one item; see below
- `GET  /api/rating-tuple` — Clerk-authenticated read of the rate host's rating tuple from fresh-assistant-api's `/health`; see below
- `POST /api/recipe/suggest-swaps/stored` `{suggest-swaps body}` and `POST /api/recipe/suggest-swaps/stored/batch` `{recipes:[{id, body}] (1-20), include?}` — Clerk-authenticated, handled as `/api/recipe/rate` is (same 401 and 503s, same upstream, `ASK_TOKEN` bearer, verified `account_id` inserted in the body; no `X-User-Token`). Read-only: the upstream answers from what is already stored (`{status:"none"}` when nothing is) and never computes, so each route has its own per-address ceiling over its own label (`/recipe/suggest-swaps/stored`, `/recipe/suggest-swaps/stored/batch`: 600 an hour, 1500 for a listed tester), apart from the `suggest-swaps` compute ceiling and the import count; body cap 200 KB (single) and 1 MB (batch); 15 s upstream timeout. Contract: fresh-assistant-api `docs/api/recipe_swaps_contract.md` section 12 (fresh-assistant-api#296). fresh_app's Plan reads the batch to show the healthier mark only when an answer is held.
- `POST /api/recipe/ledger-view` `{ledger_rows, composition?, name?}` — Clerk-authenticated, handled as `/api/recipe/rate` is (same 401 and 503s, same upstream, `ASK_TOKEN` bearer, verified `account_id` inserted in the body; no `X-User-Token`); its own per-account ceiling (120 an hour, 400 for a listed tester, address backstop 5x) over the `/recipe/ledger-view` label, apart from the import count; body cap 700 KB (the contract's maximum is 600 KB); 15 s upstream timeout; the response (about 150 KB) streams through. Contract: fresh-assistant-api `docs/api/ledger_contract.md` "Own recipes".
- `GET  /api/recipe/rate/progress/{request_id}` — Clerk-authenticated read of where a rating (or a swap search) is, for the import screen; see below
- `GET  /invite/?code=…` and `GET /api/invite/preview?code=…` — the invite link's preview card and page; see below
- `GET  /recipe-photos/{sha256}.webp` — a catalog recipe photo from R2 by content hash, public, never a listing; see below

Moderation model: comments appear immediately, `POST /admin/hide` retracts;
IP hashes rotate daily so they are not long-term identifiers.

## `/invite/` — the invite link's preview card (no sign-in)

The FRESH app texts one line and the invite link, so the messenger draws the link's preview card from
the page's `og:` tags, which it reads without running scripts. This route serves the site's invite page
(`INVITE_ORIGIN` + `/invite/`, fetched on each request) with those tags rewritten (HTMLRewriter) to what
the code carries:

| Code | `og:title` | `og:description` | `og:image` |
|---|---|---|---|
| recipe | `<sender> sent you a recipe` | the recipe's title | the recipe's photo (https only; a catalog recipe has none yet, so the general card image) |
| plan or event | `<sender> invited you to plan meals together` | `<plan name> · <n> dinners, <date range>`, e.g. `Week of Nov 17 · 5 dinners, Nov 17–21` | the FRESH mark (`/fresh-mark.png`) |
| general, no code, a bad code, a failed or slow lookup, secrets unset | the page as the site serves it: "You're invited to FRESH", the general text, `invite/invite-card.png` | | |

The same card goes into the page as `<script type="application/json" id="fi-invite-preview-data">`, and
the page shows it at the top (the photo and title, or the plan's name and dinners). Served straight from
GitHub Pages, the page asks `GET /api/invite/preview?code=…` for it instead (`{"preview": card | null}`).

The lookup is fresh_app's `public.invite_preview(p_code)` (fresh_app#1064, granted to anon), called with
the anon key; the date range is built from its `starts_on` and `ends_on`. Its function name, argument and
field names are one constant, `INVITE_PREVIEW_RPC` in `src/invitePreview.js`; change them there and
nothing else. A completed lookup is cached per isolate for 5 minutes by code; a failure is not cached. Nothing
from the link but the code is read, and the code is never written into the page. Every value is cut to
one line of bounded length and HTML-escaped.

```bash
npx wrangler secret put SUPABASE_URL        # https://<project>.supabase.co
npx wrangler secret put SUPABASE_ANON_KEY   # the project's anon key
```

| Var | Effect |
|---|---|
| `INVITE_ORIGIN` | where the page is fetched from (default `https://insights.freshfoodrecs.com`) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | secrets. **Either unset ⇒ every invite gets the general card** |

For a messenger to see the card, the link it reads must reach this Worker: a route
`insights.freshfoodrecs.com/invite/*` (needs the domain's DNS on Cloudflare), or the app's link pointing
at this Worker's own address. On the site's host, every other `/invite/` file goes straight to the site.

## `GET /recipe-photos/{sha256}.webp` — catalog recipe photos by content hash (fresh_app plan row P8)

The FRESH app's catalog recipe photos, served from R2 so a phone gets a new picture with an over-the-air
update and no native build. Public catalog content: no sign-in, no account data, no `engine_log` row.

```
GET  /recipe-photos/<64 lowercase hex>.webp
  → 200 <the bytes>   Content-Type: image/webp (always)   Cache-Control: public, max-age=31536000, immutable
                      ETag: "<sha256>"   Content-Length   X-Content-Type-Options: nosniff
                      Access-Control-Expose-Headers: ETag   (+ the usual CORS headers and version stamp)
HEAD /recipe-photos/<sha256>.webp   → the same headers, no body
GET  with If-None-Match "<sha256>" (W/, a list or * match) → 304, no body
```

- **The key** is exactly `<sha256>.webp`, the hash of the file's bytes, so an address never changes what it
  serves: the year-long `immutable` cache is safe, and a new picture is a new address. `Content-Type` is always
  `image/webp`, whatever type the object was stored with (with `X-Content-Type-Options: nosniff`).
- **Never a listing.** Only a path matching `^/recipe-photos/[0-9a-f]{64}\.webp$` reaches R2, and only as one
  `get` (or `head`) of that key. The bare `/recipe-photos`, `/recipe-photos/`, `?list`, `?prefix=`, uppercase
  hex, another length or extension, an extra segment or a file name are `404 {"error":"not found"}` without
  touching R2. The query string is ignored on a good path. No route calls `list` on the bucket.
- **Errors:** a missing object is `404`; any method but `GET`, `HEAD` or `OPTIONS` is `405` with
  `Allow: GET, HEAD, OPTIONS`; the binding absent is `503 {"error":"recipe photos not configured"}`. Every
  error carries `Cache-Control: no-store`, so a photo uploaded after a `404` is seen at once.

### Bucket and binding

`wrangler.toml` binds the bucket `fresh-recipe-photos` as `RECIPE_PHOTOS`. Create it once, before the first
deploy that carries the binding (a deploy with a binding to a missing bucket fails):

```bash
cd worker
npx wrangler r2 bucket create fresh-recipe-photos
npx wrangler deploy
```

The bucket stays private: nothing is served from an R2 public URL or custom domain, only through this route.

### Uploading photos

`scripts/upload_recipe_photos.mjs` takes two inputs, either or both in one run:

- **`--dir <folder> --record <files_sha256.tsv>`**: a folder of `.webp` files and their record (columns `file`,
  `sha256`, `bytes`, `px`, one row per file). Every row is checked: the file exists, its size is `bytes`, its
  sha256 is `sha256` (64 lowercase hex), and every `.webp` in the folder has a row.
- **`--added <photo_added.json> --added-dir <folder>`**: a fresh_composition release's `photo_added.json`
  (`photos[]`, each with `recipe_id`, `file`, `webp_sha256`, `webp_px`) and the folder the release's
  `recipe_img.zip` was extracted to. Each listed `file` is looked for recursively under the folder and must be
  found exactly once, with a sha256 equal to `webp_sha256`. A file the record does not list is ignored (and
  not read): the zip holds other recipes' photos.

All checks run before anything else; any problem stops the run with nothing uploaded. Each file then goes to
the bucket as `<sha256>.webp` with content type `image/webp`; two files with the same bytes are one object,
and a key that already exists is skipped, so a rerun after a failure continues where it stopped. Existence is
read with `HEAD` on this route (`--base`, default the workers.dev address), which needs no credentials; the
writes are `wrangler r2 object put --remote`, run from `worker/`, under wrangler's own login.

**A dry run is the default.** It prints what it would upload and writes nothing:

```bash
cd worker
node scripts/upload_recipe_photos.mjs --dir <folder> --record <files_sha256.tsv> --exclude usda_pear-rabbit \
  --added <photo_added.json> --added-dir <recipe_img folder>
```

`--exclude` leaves a file out (repeatable, or comma-separated): the file name, the name without `.webp`, or
the recipe id before a `__` suffix, so `usda_pear-rabbit` matches `usda_pear-rabbit__higgsfield.webp`. An
exclude that matches no file stops the run. `--offline` skips the existence check (dry run only), and
`--bucket` names another bucket.

The real upload adds `--write`, after the bucket exists and the Worker is deployed:

```bash
node scripts/upload_recipe_photos.mjs --dir <folder> --record <files_sha256.tsv> --exclude usda_pear-rabbit \
  --added <photo_added.json> --added-dir <recipe_img folder> --write
curl -sI https://fresh-insights-engage.freshfoodrecs.workers.dev/recipe-photos/<one sha256>.webp   # 200, image/webp
```

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
| Over the per-account ceiling (300/hour) or the per-IP backstop (600/hour) | `429` JSON `{error, reason, scope: "account"\|"address", retry_after}` with a `Retry-After` header |
| Engine unreachable | `502` |

Rate limit: **300/hour per account** (the verified Clerk `sub`, hashed with the day into `engine_log.acct_hash`) with a **600/hour per-IP backstop** (rotating daily IP hash); both over `engine_log`, separate from
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

fresh_app's recipe import and rating (`src/data/recipeService.ts`) call these
routes on fresh-assistant-api, which gates all of them on the same `ASK_TOKEN`
bearer as `/ask`. This Worker exposes them with the `/api/engine/*` shape:

```
POST /api/recipe/extract     {url}                            → upstream POST /api/recipe/extract
POST /api/recipe/transcribe  {images:[{data, media_type}]}    → upstream POST /api/recipe/transcribe
POST /api/recipe/transcribe-video  {url?, post?:{text}, media?:{data, media_type}, frames?}
                                                              → upstream POST /api/recipe/transcribe-video
POST /api/recipe/rate        {title?, servings, lines, ...}   → upstream POST /api/recipe/rate
POST /api/recipe/image       {title, ingredients[], ...}      → upstream POST /api/recipe/image
POST /api/recipe/archive-video  {url, media?, transcript?, post?, screenText?}
                                                              → upstream POST /api/recipe/archive-video
POST /api/recipe/suggest-swaps  {title?, servings, lines, ...}  → upstream POST /api/recipe/suggest-swaps
POST /api/recipe/photo       {url}                            → upstream POST /api/recipe/photo
POST /api/recipe/write       {request?, idea?, image?, base?, preferences?, context?}
                                                              → upstream POST /api/recipe/write
```

`/api/recipe/write` (fresh-assistant-api `docs/api/recipe_write_contract.md`) writes a recipe **draft** from
words, an idea or a photo of a cooked meal, and revises it from plain-words changes (`base` + `request`);
the draft is not rated or saved. One model call per request (a second only to fix a gap), inside the
upstream's 30 s budget. Here it is forwarded like transcribe: same JWT check, same insertion path for the
verified `sub` (the body can carry a photo as base64 in `image.data`, up to 4.5 MB decoded), with three
differences: an **8,000,000-byte body cap** (`RECIPE_WRITE_BODY_BYTES`, the upstream's own; a 413 says
`photo too large; send a smaller photo`), a **40 s** upstream timeout (`RECIPE_WRITE_UPSTREAM_TIMEOUT_MS`),
and its **own hourly ceiling** (below). The upstream's closed body shape allows `account_id` and
`conversation_id`, so the inserted `account_id` is accepted. A refusal to write is the upstream's `200` with
a `reason`, passed through unchanged.

`POST /api/recipe/extract` also takes the two shapes the upstream added (video_import_contract 2.3): a pasted
`{conversation}` with no `url`, and a `{url}` for a ChatGPT share link. This route reads no field of an extract
body, so both pass through unchanged beside the verified `sub`; tests pin it.

`/api/recipe/photo` (fresh-assistant-api `docs/api/video_import_contract.md` section 3.7, PR #130)
returns a saved video recipe's current post photo from its `source.url`: one platform page read, no
recipe parse, no model call, cached upstream per link. Here it is forwarded exactly like rate (same
JWT check, same 200 KB cap, same `account_id` rewrite, the default 60 s timeout), with one
difference: its **own hourly ceiling** (below), so refreshing the photos of a shelf of saved
recipes cannot use up a person's imports.

`/api/recipe/suggest-swaps` (fresh-assistant-api PR #111) takes `/api/recipe/rate`'s body and runs one
Claude call plus a re-rate per proposed swap, which can take up to about 50 s. Here it is forwarded
exactly like rate (same JWT check, same 200 KB cap, same `account_id` rewrite), with two differences:
its **own hourly ceiling** (below), so swap requests cannot use up a person's imports, and a **60 s**
upstream timeout (`RECIPE_SWAPS_UPSTREAM_TIMEOUT_MS`). fresh_app's 30 s abort on rate is too short
for this route; the app side sets its own.

`/api/recipe/archive-video` (fresh-assistant-api `docs/api/video_import_contract.md` section 3.5,
PR #109) keeps the video, transcript and caption of a caption import in the API's private recipe
corpus. fresh_app calls it in the background after each import. Here it is forwarded like
transcribe-video (same JWT check, same 60 MB cap, same insertion path), with two differences: it
has its **own hourly ceiling** (below), so archiving cannot use up a person's imports, and a
**110 s** upstream timeout, inside the 120 s client timeout the contract gives the app.

`/api/recipe/image` (fresh-assistant-api `docs/api/recipe_image_contract.md`, fresh_app#379)
generates one photo of the dish with OpenAI, 3 per account per UTC day, counted upstream on
the `account_id` this hop forwards. Its `429 daily_cap`, `503 disabled` / `store_unavailable` /
`not_configured` and `404` pass through unchanged like any upstream status. The signed
`image_url` it returns is served by fresh-assistant-api itself (`GET /api/recipe/image/<sha256>?exp=&sig=`,
no bearer, the address is the capability) on the upstream host, so the phone loads it
directly and this Worker has no image GET route.

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

- **rate, image** (at most 200 KB, fresh-assistant-api's own cap for rate;
  the upstream refuses an image body over 20,000 characters itself with its own `413`):
  read whole and rewritten. One pass over the bytes checks the full JSON grammar
  (and UTF-8 inside strings), removes every top-level `account_id` under any
  JSON escape spelling, and copies the other members byte for byte behind
  `{"account_id":"<sub>"`. Never `JSON.parse`, whose memory follows the body's
  shape (a 10 MB body of ~3.4M empty objects grows the heap ~230 MB). Not JSON,
  or not an object: this hop's `400`, nothing forwarded.
- **transcribe** (up to 10 MB of photos), **transcribe-video** (up to 60 MB, the upstream's own
  cap; a base64 video rides in `media.data`) and **archive-video** (the same 60 MB here; the
  upstream's own cap is 34 MB, so a body between the two is the upstream's `413`): read whole, then
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

All nine routes send the upstream a complete body with a `Content-Length`, and
nothing at all when this hop refuses the request.

| Condition | Response |
|---|---|
| No bearer, or a bearer that fails verification (bad signature, expired, wrong issuer, unknown key) | `401 {"error":"unauthorized","reason":"could not verify sign-in; sign in again"}` |
| A bearer, but `CLERK_ISSUER` or `CLERK_JWKS_URL` not set | `503 {"error":"sign-in verification not configured","reason":...}` |
| A bearer, but Clerk's JWKS unreachable or answering non-2xx | `503 {"error":"sign-in verification unavailable","reason":...}` |
| `ASK_UPSTREAM` or `ASK_TOKEN` not set (checked after the JWT) | `503 {"error":"recipe service not configured","reason":...}` |
| Declared `Content-Length` over the route's cap (transcribe-video and archive-video 60 MB, transcribe 10 MB, write 8 MB, extract 4 MB, rate/image/suggest-swaps/photo 200 KB) | `413 {"error":"request body too large","reason":...}`, before a slot is claimed |
| Chunked body that runs past the route's cap as it is read | `413`, same body; the attempt counts, logged as `413` |
| Body cannot be read (caller disconnected mid-upload) | `400`, same body as below; logged as `400` |
| Over the per-IP ceiling (the import one, or archive-video's, suggest-swaps', photo's or write's own) | `429` with `error` and `reason` (the app shows `reason`); the body is not read |
| extract/rate/image/suggest-swaps: body not UTF-8 JSON, or not an object (array, string, number, `null`, empty) | `400 {"error":"invalid request body","reason":"request body must be a JSON object"}`; nothing forwarded; logged as `400` |
| transcribe, transcribe-video, archive-video, write: body not starting with `{` and ending with `}` (or empty) | the same `400`; logged as `400` |
| Upstream unreachable or over the timeout (60 s; 40 s on image and write; 110 s on archive-video; 60 s on suggest-swaps) | `502` with `error` and `reason` |
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

Two uploads of that size in flight at once in one isolate do not fit 128 MB under any buffering
design, and the buffer is sized from the declared `Content-Length` when the request starts, so a
slow upload holds its buffer the whole time. The Node figures above leave out workerd's own handling
of the body given to `fetch()`, so read them as a floor, not a budget.

A request of only `{url}` or `{post}` is a few hundred bytes and not affected by any of this.

Timeouts on `/api/recipe/rate`, outermost first: fresh_app aborts at **30 s**
(`recipeService.ts` `REQUEST_TIMEOUT_MS`), this Worker at **60 s**
(`RECIPE_UPSTREAM_TIMEOUT_MS`), fresh-assistant-api answers `503` itself at
**27 s** (`RATE_TIMEOUT_MS`, fresh-assistant-api PR #51). The Worker never cuts
the call off before the upstream's own answer.

Timeouts on `/api/recipe/image`: this Worker at **40 s**
(`RECIPE_IMAGE_UPSTREAM_TIMEOUT_MS`). Josh ruled on 2026-10-16 that generation must be fast
("100s feels abhorrently long"), so fresh-assistant-api caps the OpenAI call at 30 s with no retry
on a timeout; 40 s leaves room for that call, the store write and the upstream's own answer. If
this hop cut first, it would 502 a request the upstream had already stored and charged a daily
slot for. The upstream's image handler does not abort on a client disconnect (read in its
`server.js`, not tested live), so an image finished after a disconnect is still stored, and a
repeat tap of the same recipe is answered from the store with no slot used.

Rate limit: **30/hour per rotating daily IP hash**, its own ceiling (transcribe,
transcribe-video and image are paid model calls) and not a share of the engine's 60. The five import
routes count against the one ceiling, over every `/recipe/%` label except `/recipe/archive-video`, `/recipe/suggest-swaps` and `/recipe/photo` and `/recipe/write`;
listed `RECIPE_DEV_SUBS` / `ASK_DEV_SUBS` subs get 200. **archive-video has a ceiling of its own:
20/hour on the same IP hash (100 for a listed sub), counted over its own rows only.** Archive rows are
left out of the import count and import rows out of the archive count, so background archiving
cannot use up a person's imports. **suggest-swaps has its own as well: 10/hour on the same IP hash
(40 for a listed sub), over its own rows only**, and its rows are likewise left out of the import
count (each request is a model call plus several rate runs, so the figure is modest). **photo has
its own too: 120/hour on the same IP hash (400 for a listed sub), over its own rows only**, higher
than the import figure because each request is one cached page read, and left out of the import
count. **write has its
own, and is counted per verified ACCOUNT: 60/hour per account (200 for a listed sub), over its own rows only**,
with a per-address backstop of 5x that (300/hour; the address hash is the same rotating one), because it is a
signed-in route and people on one household wifi or a carrier NAT share an address. A refusal says which
limit (`scope` `account` or `address`, and the figure). Its rows carry `acct_hash` (sha256 of `"acct:" + sub +
"|" + UTC day`, opaque, rotates daily, so an account's count restarts at UTC midnight) and are left out of the
import count. One model call per draft or revision, so between swaps' 10 and photo's 120. The other recipe
routes keep their per-address key. A refused
archive is a `429` the app retries later, per the contract. Each request claims its
`engine_log` row *before* the upstream call, in one `INSERT ... WHERE count < ceiling`
statement, so parallel requests cannot overshoot the ceiling and an attempt that
times out still counts. The row holds a fixed label (`/recipe/extract`,
`/recipe/transcribe`, `/recipe/transcribe-video`, `/recipe/rate`, `/recipe/image`,
`/recipe/archive-video`, `/recipe/suggest-swaps`, `/recipe/photo`, `/recipe/write`) and, once the upstream answers, its status
(`NULL` while in flight); never the URL, the body, or the caller's `sub`. The
engine's ceiling excludes these rows. No schema change: `engine_log` already exists.

CORS follows the engine rule: `ALLOWED_ORIGINS` shapes the headers for a browser
caller (the app's Expo web build on `localhost:8081`/`8083`/`8085`/`8086`, listed in
`wrangler.toml`) but is not the boundary — the JWT is. `Access-Control-Allow-Headers`
includes `Authorization` so a browser preflight for a bearer request succeeds.

## `/api/food/{source}/{code}/{attributes|ledger}` — per-food attribute panel and ledger view (Clerk-authenticated)

fresh_app's food card keeps only the store index and the 14 label lines on the
phone and fills the register from fresh-assistant-api's panel route when a card
opens: one request per food per open, cached on the device per food and release
(fresh_app#495). The API answers from a pinned, immutable composition release
and gates the route on the same `ASK_TOKEN` bearer as `/ask` and the recipe
routes (fresh-assistant-api#62), so it is reachable only through here.

```
GET /api/food/fndds/{code}/attributes   → upstream GET /api/food/fndds/{code}/attributes
GET /api/food/sr/{code}/attributes      → upstream GET /api/food/sr/{code}/attributes
  → the upstream response: {release, source, code, name, basis: "per100g", rows: [...], serving?}
GET /api/food/fndds/{code}/ledger       → upstream GET /api/food/fndds/{code}/ledger
GET /api/food/sr/{code}/ledger          → upstream GET /api/food/sr/{code}/ledger
  → the served food-card ledger view (fresh-assistant-api#69; drivers per system, the register,
    the lenses, each stamped with the algorithm and attributes releases). The app renders it and
    computes nothing (fresh_app#498, D-2026-10-09-5); until the API pins an algorithm release the
    upstream answers 404 and that passes through.
```

The two views are one route family (fresh-insights#58): the leaf picks the view, and everything
below applies to both. Their `engine_log` labels, `/food/:source/:code/attributes` and
`/food/:source/:code/ledger`, both sit under `/food/%`, so they share the one 600/hour read
ceiling: a caller that reads both spends two of it.

`source` is the API's closed set, `fndds` | `sr` (`branded` is added here the day
the API ships it). `code` is `[A-Za-z0-9_.-]{1,40}`; any other path shape, and any
method but `GET`, is this hop's `404` with nothing forwarded.

1. requires `Authorization: Bearer <Clerk session JWT>`, verified exactly as on
   `/api/recipe/*`, with the same `401` and the same two `503`s;
2. checks the route's own per-IP ceiling (below) before the upstream call and
   writes one `engine_log` row, status included, after it;
3. forwards `GET` to `ASK_UPSTREAM` + the same path with
   `Authorization: Bearer <ASK_TOKEN>`, plus the caller's `If-None-Match` when it
   is printable ASCII of at most 500 bytes (so the ETag below is usable: a
   validator gets the upstream's `304`). **Nothing else the caller sent travels
   upstream:** not `Authorization`, `X-Fresh-User` or `Cookie`, and not the query
   string (the route takes no parameters; `?account_id=` or anything else there
   is dropped). The verified sub is not forwarded either: the upstream's contract
   has no account field and the answer is per food, not per person. Should the
   API route come to want the caller's identity, the line to add is the engine
   route's `X-Fresh-User: <verified sub>`, never a value from the request;
4. returns the upstream status and body unchanged (the panel, the upstream's
   `404` for an unknown code, a `304`); of the upstream's headers only
   `Content-Type`, `ETag`, `Cache-Control` and `Retry-After` cross this hop.

| Condition | Response |
|---|---|
| No bearer, or a bearer that fails verification | `401 {"error":"unauthorized","reason":"could not verify sign-in; sign in again"}` |
| A bearer, but `CLERK_ISSUER` or `CLERK_JWKS_URL` not set | `503 {"error":"sign-in verification not configured","reason":...}` |
| A bearer, but Clerk's JWKS unreachable or answering non-2xx | `503 {"error":"sign-in verification unavailable","reason":...}` |
| `ASK_UPSTREAM` or `ASK_TOKEN` not set (checked after the JWT) | `503 {"error":"food service not configured","reason":...}` |
| Over the per-account ceiling (3,000/hour) or the per-IP backstop (6,000/hour) | `429 {"error":"too many requests — try again later","reason":"food lookup limit reached for this account (3000 per hour); try again in N min","scope":"account","retry_after":S}` with `Retry-After: S` |
| Upstream unreachable or over the 60 s timeout | `502 {"error":"food service unreachable","reason":...}`; the attempt counts, logged as `502` |
| Any upstream status (200, 304, 404, 429, 503, ...) | passed through with its body (none for a `304`) |

Rate limit: **3,000/hour per account** with a **6,000/hour per-IP backstop**, a READ ceiling of the route's
own. It is neither a share of the recipe routes' 30 (paid vision calls) nor of the
engine's 60 (compute): a person browsing foods must not spend the recipe budget,
and a recipe import must not lock the card. The three ceilings count disjoint
label sets in `engine_log` (`/food/%`, `/recipe/%`, everything else), so none
touches another. There is no development raise on this route; 3,000 is already
above a hand-tester's rate.

The count is read before the upstream call and one row is written after it, as
on `/api/engine/*`, not the recipe routes' claim-then-update. That pattern exists
because an over-admitted recipe call is a paid vision call; here it is one sqlite
read, and it would cost two D1 row writes per request where this costs one. This
will be the app's most frequent call, and Workers Free allows 100,000 D1 rows
written a day across every route, so the write per request is the figure that
matters. The known cost: card opens arriving while earlier ones are in flight
read the same count, so a burst can overshoot the ceiling by the number in
flight; at the ceiling itself every one of them is refused. The log write is
best effort: a D1 write failure loses the row, never the response.

The row holds the view's fixed label (`/food/:source/:code/attributes` or `/food/:source/:code/ledger`) and the status;
never the code, the source, or the caller's `sub` — which food a device opened
is the kind of same-day clustering `engine_log`'s schema comment promises not
to hold. No schema change.

`Cache-Control` passes through as the upstream set it, `public` included, on a
response to a request that carried `Authorization`; a shared cache may then
store it and serve it without the JWT. That is acceptable only because the
panel is per food, not per person. For a browser caller the `ETag` is for the
browser's own HTTP cache (which sends `If-None-Match` itself); it is not
exposed to page JavaScript, since the version wrapper's
`Access-Control-Expose-Headers` names only the `X-Worker-*` headers. A native
caller reads every header.

CORS as on the recipe routes: `ALLOWED_ORIGINS` shapes the headers for a browser
caller, the JWT is the boundary.

## `/api/record/{item_id}` — one item's scoring record (Clerk-authenticated)

fresh_app's scoring-record reader reads fresh-assistant-api's `GET /api/record/{item_id}`
(fresh-assistant-api#168, `docs/api/scoring_record_contract.md` there): the record the pinned
scoring-record release holds for one item, byte for byte, gated on the same `ASK_TOKEN` bearer as
the food views. Everything below follows the food views except where it says otherwise.

```
GET /api/record/fndds:22311510                  → upstream GET /api/record/fndds%3A22311510
GET /api/record/sr%3A5062                       → upstream GET /api/record/sr%3A5062
GET /api/record/usda:black-bean-and-rice-salad  → upstream GET /api/record/usda%3Ablack-bean-and-rice-salad
  → {scoring_record: {release, tuple_sha256}, record_sha256, record}   (up to about 210 KB)
```

- **The id.** `<source>:<code>`, the colon raw or `%3A` (either case). `source` is `fndds`, `sr`
  (foods) or `usda`, `gen`, `nhlbi`, `hhs` (the 186 catalog recipes: 45, 82, 53 and 6 in
  `scoring-record-1.2.2-2026-10-24`); `code` is `[A-Za-z0-9._~-]{1,160}`, the upstream's own
  tail. Anything else under `/api/record/` is this hop's
  `400 {"error":"not an item id","reason":...}`, after the JWT check (an anonymous caller gets the
  `401` whatever the path) and before the ceiling: no row, nothing forwarded. Any method but `GET`
  is `404`.
- **Upstream request.** Built from the two matched parts, the colon always sent as `%3A`; the
  service bearer; the caller's `If-None-Match` when it passes the same shape check as the food views
  (the API's ETag is `"<32 hex>-<16 hex>-c1"`, which passes). Nothing else the caller sent.
- **Response.** Status and body pass through (200, the `304` with no body, the upstream's `400`,
  `404`, `500`, `503`). `Content-Type`, `ETag`, `Cache-Control`, `Retry-After` and
  `X-Scoring-Record-Release` cross this hop; `X-Scoring-Record-Release` and `ETag` are named in
  `Access-Control-Expose-Headers` (beside the version pair) so the web build can read them.
  `Access-Control-Allow-Headers` lists `If-None-Match` for the web build's own revalidation.
- **Ceiling.** Its own read ceiling at the food figures, **3,000/hour per account** and
  **6,000/hour per address**, over the `engine_log` label `/record/:item_id` (never the id). The
  food ceiling counts `/food/%` only, and the engine ceiling now excludes `/record/%`, so the three
  read/compute ceilings stay disjoint. Count before the call, one row after it, as on the food views.
- **Errors of this hop's own:** `401`, the two sign-in `503`s, `503 record service not configured`,
  `429` (scope `account`/`address`, `Retry-After`), `502 record service unreachable` (60 s timeout).

## `/api/rating-tuple` — the rate host's rating tuple (Clerk-authenticated)

fresh_app stores `rating_tuple.tuple_sha256` with a saved recipe's rating and re-rates the recipe when
the stored value differs from the current one (fresh-assistant-api `docs/api/recipe_rate_contract.md`
3.19, fresh-assistant-api#172). The current value is on that service's `/health`, which is public and
carries a good deal besides the tuple (model names, corpus counts, release pins). This route reads it
there and returns only the tuple.

```
GET /api/rating-tuple
  → 200 {"rating_tuple": {"tuple_sha256": "<64 hex>"}}   ETag: "<64 hex>"   Cache-Control: private, max-age=60
  → 304 (no body)   when If-None-Match names that ETag (a W/ prefix, a list, or * all match)
  → 503 {"error":"rating tuple unavailable","reason":...}   Cache-Control: no-store   (no ETag)
```

A `200` always means "here is the tuple". When there is none to give, the answer is a `503`, so the app's
existing error path keeps the last tuple it had.

- **Caller side:** the food and record routes' shape. Clerk JWT required (`401`, and the same two
  sign-in `503`s), a read ceiling of its own checked before the upstream call, one `engine_log` row
  (label `/rating-tuple`, status; never the tuple or the sub) after it. **300/hour per account, 600/hour
  per address**; the other ceilings exclude `/rating-tuple%` and this one counts only it. One call per
  app session is the expected use. Any method but `GET`, and any other path, is `404`.
- **Upstream side:** `GET ASK_UPSTREAM/health` with **no headers at all**: `/health` is public, so
  `ASK_TOKEN` is not needed for it and is not spent on it (only `ASK_UPSTREAM` must be set, else
  `503 rating service not configured`, after the JWT). The query string and everything the caller
  sent stay here. 15 s timeout.
- **Response:** the body is rebuilt from the one field read, so nothing else from `/health` can cross.
  A value that is not 64 lowercase hex is treated as no tuple (the `503` below). The `ETag` is the strong hash in quotes;
  the 304 is decided here from the value just read, so every call reads the upstream and a 304 still
  counts against the ceiling. `ETag` is in `Access-Control-Expose-Headers` for the web build.
- **No tuple, and failure:** one answer for every case where this hop has no tuple to give: `/health`
  says `rating_tuple: null` (the rate host has not answered since a boot, 3.19; or an older rate host),
  the field is absent or not 64 lowercase hex, `/health` is unreachable or over the timeout, is non-2xx,
  or its body is not a JSON object. All are `503 {"error":"rating tuple unavailable","reason":...}` with
  `Cache-Control: no-store` and no `ETag`, logged as `503`, so nothing is cached and there is no
  validator to revalidate. A `503` is never a `304`, whatever If-None-Match the caller sends. (Until
  2026-10-29 the null case was a `200 {"rating_tuple":null}` and a failure a `502`; a null was seen on
  2 of 30 calls through the Worker that day, and the API session attributed it to a machine that had not
  yet had an answer from the rate host since its boot.)

## `/api/recipe/rate/progress/{request_id}` — where a rating is (Clerk-authenticated)

The import screen polls this about once a second for the 10 to 30 s a rating takes
(fresh-assistant-api `docs/api/recipe_rate_contract.md` 3.21; 3.22 for a swap search, same route). The
app sends a `request_id` in the body of `POST /api/recipe/rate` (or `suggest-swaps`); the API keeps the
stage of that request in memory, and this route reads it.

```
GET /api/recipe/rate/progress/{request_id}      Authorization: Bearer <Clerk session JWT>
  → 200 {stage, lines_matched, lines_total, updated_at}      (a rating; a swap search has its own fields)
  → 404 {"error":"unknown request_id"}    unknown, expired, another account's, not started yet, or not an id
  → every response this route builds carries  Cache-Control: no-store  (the 401 and 503s, 404, 429 and 502 too)
```

- **Identity.** Clerk JWT required (`401`, and the same two sign-in `503`s). The upstream request is
  `GET ASK_UPSTREAM/api/recipe/rate/progress/<id>` with `Authorization: Bearer ASK_TOKEN` and
  `X-Account-Id: <the verified sub>`, the same value the rate route puts in the body's `account_id`
  (so a sub that is not fit to forward there, `[A-Za-z0-9_.@+-]{1,200}`, sends no header here either).
  The header is set from the verified token only: a client's own `X-Account-Id`, `Authorization`,
  `Cookie` and query string are never forwarded, and the upstream URL has no query string.
- **The id** is a `request_id`: `[A-Za-z0-9._-]`, at most 200, not starting with `.`, not ending in `.jsonl` (any case; the API refuses it). Anything else is
  the API's own `404 {"error":"unknown request_id"}`, answered here after the JWT check with no
  upstream call and no row. The id is URL-encoded on the way up.
- **Response:** the upstream's status and JSON body are passed through unchanged (200, its 404, its own
  401/503); of its headers only `Content-Type` crosses. This hop's own 502 (`progress service
  unreachable`) and 503 (`progress service not configured`) carry `reason`; `ASK_UPSTREAM` and
  `ASK_TOKEN` must both be set. 3 s timeout, no retry.
- **Ceiling:** its own, label `/rate-progress` (outside `/recipe/`, so a poll never spends the rate
  route's hourly ceiling and the rate route's rows never block a poll): **6,000/hour per account,
  12,000/hour per address**, a poll every second for an hour and a half. One `engine_log` row per poll,
  label, status and account hash only, never the request id or the sub. That is 30 rows per rating
  against Workers Free's 100,000 D1 rows written a day; the other ceilings exclude `/rate-progress%`.
- **Method:** only `GET`; any other method is `404`.

## `GET /api/recipes/common` and `/api/recipes/common/{id}` — the community feed (fresh_app #1056)

fresh-assistant-api `docs/api/recipe_common_contract.md` sections 3 and 3.2 (fresh-assistant-api#304): the feed and one entry of it, for Discover's People chip and community shelves.

- **Identity.** Clerk JWT required (`401`, and the same two sign-in `503`s, all `Cache-Control: private, no-store`). The upstream is a `GET` with `Authorization: Bearer ASK_TOKEN`, `X-Account-Id: <verified sub>` and `X-User-Token: <the verified token>` (the API requires both and checks the token's `sub` against the account); a client's own copies of those, `Cookie` and any other header are never forwarded. Redirects are refused (`502`).
- **Query (feed).** Allow-list only: `limit` 1 to 48, `shelf` community|connections, `meal`/`cuisine`/`method` (lowercase words, at most 24), `cursor` (an offset, or `<digits>.<64 hex>`). Anything else is dropped; a known name with a bad value is this hop's `400 {code: "bad_request"}`, no call, no row. **Entry id** is 64 lowercase hex; anything else is the API's own `404 {code: "not_found"}`, answered here after the sign-in check.
- **Ceilings,** each its own and per verified account with an address backstop at twice the account figure, labels outside `/recipe/` and excluded from the engine count: feed `/common/feed` **300/hour** (900 for a listed tester; Discover loads it when it opens, the app keeps a page 5 minutes per account and shelf), entry `/common/item` **600/hour** (1,500; one call per tile opened, saved or planned). One `engine_log` row per call: label, status, hashes. Never the query, the entry id or the sub.
- **Response:** the upstream's status and body unchanged; of its headers only `Content-Type` and `Retry-After` cross. 15 s timeout, no retry. Only `GET`.

## `GET /api/scan/{code}` — a scanned barcode (fresh_app #444)

fresh-assistant-api `docs/api/scan_lookup_contract.md`: the product's label, one picture and its rating (or `rating: {status: "no_rating_yet"}`) for the scan screen.

- **Identity.** Clerk JWT required (`401`, and the same two sign-in `503`s, all `Cache-Control: private, no-store`). The upstream gates on the service bearer alone, so the call carries `Authorization: Bearer ASK_TOKEN` and the caller's `If-None-Match` when it is printable ASCII of at most 499 characters: no `X-Account-Id`, no `X-User-Token`, no cookie, no query. Redirects are refused (`502`).
- **Code.** 8, 12, 13 or 14 ASCII digits (EAN-8, UPC-A, EAN-13, GTIN-14, the lengths the API takes), tested on the raw path segment. Anything else (letters, hyphens, spaces, encoded slashes, dots or digits, an extra segment, an empty code) is this hop's `400 {code: "bad_code", reason: "not_digits" | "wrong_length"}`, judged after the sign-in check, with no call and no row. The upstream URL is built from the matched digits only.
- **Ceiling,** its own, `/scan`: **360/hour** per verified account (1,080 for a listed `ASK_DEV_SUBS` / `RECIPE_DEV_SUBS` tester), address backstop at twice that, excluded from the engine count. A full shop of 100 to 150 scans is under half of it; the cold shard read upstream is the costly part, so it sits well under the record route's 3,000.
- **Response.** The upstream's status and body unchanged (`200`, `304` with no body, `404` when `SCAN_LOOKUP` is off or the code is unknown, `503 not_ready` or `busy`); of its headers only `Content-Type`, `ETag` and `Retry-After` cross, and `ETag` and `Retry-After` are exposed to a browser caller. `Cache-Control` is always `private, no-store`; the app keeps its copy under the ETag. 15 s timeout, no retry. Only `GET`.
- **Log.** One `engine_log` row per forwarded call: the label `/scan`, the status, the hashes. Never the code, the sub or the validator.

## `X-User-Token` — the caller's own sign-in, to the API, on three routes (D-2026-10-29-1)

fresh_app's decision D-2026-10-29-1 (fresh_app `DECISION_LOG.md`): nothing about the person rides with every Chat
message; fresh-assistant-api reads that person's **own synced rows during their own request**, using their forwarded
sign-in token against the database's owner-only rules. It holds no master key, stores nothing, and logs no token or
value. This Worker's part is one header.

- **Which routes.** `POST /api/ask`, `POST /api/recipe/write` and `GET /api/recipes/common[/{id}]`, and no other: every other route that reaches an
  upstream is called with the service bearer (and, on a few, `X-Fresh-User` or `X-Account-Id`), never the caller's
  token. A test calls every other route signed in and asserts the header is absent, and another asserts the header
  name appears in the source only in these places.
- **What is sent.** `X-User-Token: <the Clerk session JWT as the caller presented it>`, byte for byte, beside the
  service `Authorization: Bearer ASK_TOKEN` the upstream already requires. `account_id` in the body is still the
  verified sub.
- **When.** Only after the JWT verified. An anonymous `/api/ask` sends none; a token that fails verification is the
  Worker's `401` and nothing goes upstream. A client-sent `X-User-Token` is never forwarded: upstream headers are built
  from scratch.
- **Where it never goes.** Not in a request body, not in `ask_log` or `engine_log` (rows hold labels, statuses and
  opaque hashes), not in a response body, a response header or an error body (this Worker's errors are fixed strings),
  and not in a log line (the Worker writes none).
- **What is forwarded.** Only a token that is three plain base64url segments (`a.b.c`): the verifier decodes with
  `atob`, which tolerates base64 padding, so a token with a trailing `=` can verify and is answered but sent as no
  token. And only to an `https://` upstream (loopback `http://` is allowed for local development): a bearer credential
  is never sent in the clear. In both cases the API sees an anonymous request, not an error.
- **Redirects.** Both calls use `redirect: "manual"`, and any `3xx` is refused unread (a `502`, with nothing of the
  `Location` or the body passed on). `fetch` drops `Authorization` on a cross-origin redirect but not a custom header,
  so a followed redirect would carry the token to wherever it points. (Cloudflare Workers supports `follow` and
  `manual` only; `error` is a `TypeError` there and would have failed every call.)
- **The token's life.** A Clerk session token lasts about a minute; the API uses it for that request's reads and
  drops it.

## Per-account ceilings and the 4 MB extract body (2026-10-16)

- `engine_log` gains `acct_hash` (sha256 of `"acct:" + sub + "|" + UTC day`, 24 hex: opaque, rotates daily, never the sub).
  **Run `migrations/2026-10-16-engine-log-acct-hash.sql` against the live D1 BEFORE deploying this Worker**
  (`npx wrangler d1 execute fresh-insights-engage --remote --file=migrations/2026-10-16-engine-log-acct-hash.sql`);
  a Worker that writes `acct_hash` into a table without the column fails every engine and food request.
- Engine: 300 per account per hour, 600 per address. Food: 3,000 and 6,000. Rows from before the migration have a NULL
  `acct_hash` and do not count toward an account. Every 429 is JSON with `reason`, `scope` and `retry_after`, plus `Retry-After`.
- `/api/recipe/extract` accepts 4 MB (a recipe page the phone fetched, 3 MB of HTML escaped as JSON) and takes the
  `insertAccountId` path; rate and image stay at 200 KB with `withAccountId`.
