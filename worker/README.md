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
