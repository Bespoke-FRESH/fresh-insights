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
