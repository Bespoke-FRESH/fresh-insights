// fresh-insights-engage — comments / subscribe / feedback API.
// All data lives in our own D1 database; no third party sees a reader's email.

import { createJwksCache, verifyClerkJWT } from "./clerkAuth.js";

const MAX_BODY = 4000;
const MAX_NAME = 80;
const POSTS_PER_HOUR = 5; // per ip_hash per page
const RETRIEVE_PER_HOUR = 40;         // passage lookup: deterministic upstream, costs nothing
const RETRIEVE_ANSWERS_PER_HOUR = 10; // answer pass: one model call each, so a tighter ceiling
const ASK_PER_HOUR = 60;              // surface chat: TestFlight testers from 2026-10-12; Josh ruled "60 per hour is fine for testers."
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
// `client_tools` (ask contract 1.7): the service reads at most 16 names of at most 40 characters.
const ASK_MAX_CLIENT_TOOLS = 16;
const CLIENT_TOOL_NAME = /^[a-z_]{1,40}$/;
// Engine calls are compute (a diet-engine scoring pass on Fly), not a paid model call like
// /api/ask, and every caller is already Clerk-authenticated — so this is an abuse ceiling, not a
// cost ceiling; it remains separate from ASK_PER_HOUR.
//
// Two ceilings, both over `engine_log`. The PRIMARY one is per ACCOUNT: the verified Clerk `sub`,
// hashed with the day like the IP hash (acct_hash), because the old per-IP-only figure (60) was
// shared by everyone behind one address and by one phone as its address changed, and it locked
// testers out of the Diet room (Josh, 2026-10-16: "Diet and card errors"). The BACKSTOP is per IP
// (the daily-rotating hash), set above the account figure so a household on one address is not
// refused before any one member is, and it still bounds a script that mints many accounts from
// one address. A 429 names which one fired in `reason` and carries Retry-After.
export const ENGINE_PER_HOUR = 300;
export const ENGINE_PER_HOUR_IP = 600;
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
export const RECIPE_UPSTREAM_TIMEOUT_MS = 60000;
// /api/recipe/image (fresh-assistant-api docs/api/recipe_image_contract.md, fresh_app#379) gets its
// own bound. Josh, 2026-10-16: generation must be fast ("100s feels abhorrently long"), so the
// upstream caps the provider call at 30 s with no retry on a timeout. 40 s leaves room for that
// call plus the store write and the upstream's own answer, so this hop does not 502 a request the
// upstream is about to answer (by then it may have stored the image and spent one of the person's
// 3 daily slots).
export const RECIPE_IMAGE_UPSTREAM_TIMEOUT_MS = 40000;
// /api/recipe/archive-video (fresh-assistant-api docs/api/video_import_contract.md section 3.5, PR
// #109; Josh, 2026-10-16: every imported video and its transcript are stored). The app calls it in
// the background after each caption import, so it has a ceiling of its OWN, counted only over its
// own rows and lower than the import ceiling, and its rows are left out of the import count: a
// person's archives can never use up their imports, and an import never waits on an archive slot.
// A refused archive is a 429 the app retries later (at most 3 tries, per the contract), and the API
// has a backfill for any that never land.
export const RECIPE_ARCHIVE_PER_HOUR = 20;
// The listed-tester figure for the same ceiling (same tester list as RECIPE_PER_HOUR_DEV), still
// below that route's 200.
export const RECIPE_ARCHIVE_PER_HOUR_DEV = 100;
// The contract gives the app a 120 s client timeout for an archive (a store upload plus a
// speech-to-text call, and a wait while an import reads a large video). This hop cuts at 110 s, inside
// the app's bound, so the app sees this hop's 502 rather than its own abort; a re-sent archive is
// safe upstream (held texts and media are not stored twice).
export const RECIPE_ARCHIVE_UPSTREAM_TIMEOUT_MS = 110000;
// /api/recipe/suggest-swaps (fresh-assistant-api PR #111): the body is /api/recipe/rate's. One Claude
// call plus a re-rate per proposed swap, so a request is several paid calls and can run up to about
// 50 s. Like archive-video it has a ceiling of its OWN over its own rows, and its rows are left out
// of the import count, so a person's swap requests can never use up their imports. Modest, because
// each request is a model call plus several rate-process runs: 10 an hour, 40 for a listed tester
// (same tester list as RECIPE_PER_HOUR_DEV), both below the import figures.
export const RECIPE_SWAPS_PER_HOUR = 10;
export const RECIPE_SWAPS_PER_HOUR_DEV = 40;
// The upstream's own run is up to about 50 s; 60 s keeps this hop from cutting a request the
// upstream is about to answer. fresh_app's own abort for this route is its side to size (its
// 30 s on rate is too short for this one).
export const RECIPE_SWAPS_UPSTREAM_TIMEOUT_MS = 60000;
// /api/recipe/photo (fresh-assistant-api docs/api/video_import_contract.md section 3.7, PR #130):
// {url} in, the post's current photo address out. One platform page read, no recipe parse, no model
// call, and the upstream caches each link (3 hours found, 10 minutes missed). The app calls it for
// each saved video recipe whose photo fails to load or is more than a day old, so opening a shelf of
// saved recipes can send many at once. It has a ceiling of its OWN over its own rows, higher than
// the import ceiling because each request is cheap, and its rows are left out of the import count:
// refreshing photos can never use up a person's 30 imports an hour. 120 an hour, 400 for a listed
// tester (same tester list as RECIPE_PER_HOUR_DEV). It takes the default 60 s upstream timeout.
export const RECIPE_PHOTO_PER_HOUR = 120;
export const RECIPE_PHOTO_PER_HOUR_DEV = 400;
// /api/recipe/write (fresh-assistant-api docs/api/recipe_write_contract.md, live on Fly v127): a recipe
// DRAFT from words, an idea or a photo of a cooked meal, one model call (a second only to fix a gap)
// inside the upstream's own 30 s budget. A change in plain words ("for 2", "less oil") is another call
// on the same draft, so a person refining one recipe sends several. It has a ceiling of its OWN over its
// own rows, apart from the import count (a person's drafts can never use up their 30 imports an hour,
// and an import never waits on a draft slot): 60 an hour, 200 for a listed tester (same tester list as
// RECIPE_PER_HOUR_DEV). Each call is a paid model pass, so this is deliberately well below photo's 120
// and well above swaps' 10, which is several model calls and re-rates per request; Josh can move it.
export const RECIPE_WRITE_PER_HOUR = 60;
export const RECIPE_WRITE_PER_HOUR_DEV = 200;
// The upstream's budget is 30 s (WRITE_BUDGET_MS) and fresh_app aborts every recipe call at 30 s; 40 s
// leaves the store-free answer room to arrive, as image's 40 s does, so this hop does not 502 a draft
// the upstream is about to return.
export const RECIPE_WRITE_UPSTREAM_TIMEOUT_MS = 40000;
// The upstream's own cap (server.js): one photo of at most 4.5 MB decoded, about 6 MB as base64, beside
// the words. Held to the same number here, so an oversize request is refused before a slot is claimed.
// The body carries a photo, so it takes the insertion path for account_id (see bigBody).
export const RECIPE_WRITE_BODY_BYTES = 8_000_000;
// The only recipe routes this Worker forwards. Each value is also the label written to
// engine_log: a fixed string per route, never the request URL or anything in the body (a recipe
// URL or a photo is the user's own content).
const RECIPE_ROUTES = {
  "/api/recipe/extract": "/recipe/extract",
  "/api/recipe/transcribe": "/recipe/transcribe",
  "/api/recipe/transcribe-video": "/recipe/transcribe-video",
  "/api/recipe/rate": "/recipe/rate",
  "/api/recipe/image": "/recipe/image",
  "/api/recipe/archive-video": "/recipe/archive-video",
  "/api/recipe/suggest-swaps": "/recipe/suggest-swaps",
  "/api/recipe/photo": "/recipe/photo",
  "/api/recipe/write": "/recipe/write",
};
// The engine_log labels the import ceiling does not count: each has a ceiling of its own.
const RECIPE_ARCHIVE_LABEL = RECIPE_ROUTES["/api/recipe/archive-video"];
const RECIPE_SWAPS_LABEL = RECIPE_ROUTES["/api/recipe/suggest-swaps"];
const RECIPE_PHOTO_LABEL = RECIPE_ROUTES["/api/recipe/photo"];
const RECIPE_WRITE_LABEL = RECIPE_ROUTES["/api/recipe/write"];
// fresh-assistant-api's body cap for /api/recipe/transcribe-video (server.js, PR #56): a video's
// base64 `media.data` rides in the JSON body, so this is far above the photo route's 10 MB. The
// Worker holds the caller to the same number, so an oversize request is refused here, before a slot
// is claimed, instead of being read and forwarded to be refused upstream. Cloudflare's own request
// body ceiling sits above it (100 MB on Free and Pro as best recalled, NOT re-read from Cloudflare's
// Workers limits page when this was written; check the page before raising this cap). The memory and
// CPU figures in the README were measured in Node, not workerd, and omit workerd's own handling of
// the body given to fetch(); treat them as a floor.
const RECIPE_VIDEO_BODY_BYTES = 60_000_000;
// The only upstream response headers /api/recipe/* passes back to the caller. recipeService.ts
// reads the status and the JSON body; Retry-After is kept for a 429/503 the upstream sends itself.
// Anything else the upstream emits (Set-Cookie, a stale Content-Length or Content-Encoding, a
// server banner) stays on this hop.
const RECIPE_RESPONSE_HEADERS = ["content-type", "retry-after"];
// Per-food attribute panel (fresh-assistant-api GET /api/food/{source}/{code}/attributes) for
// fresh_app's food card: fresh_app#495, fresh-assistant-api#62, fresh-insights#54. A read: the
// upstream answers from a pinned, immutable composition release, with no model call and no engine
// pass, and one card open is one request. So it has a READ ceiling of its own, neither a share of
// RECIPE_PER_HOUR (paid vision calls) nor of ENGINE_PER_HOUR (compute): a person browsing foods
// must not spend the recipe budget, and a recipe import must not lock the card. Generous, and
// still a bound: a lost phone or a scripted walk of the store reads at most this many foods an
// hour per address. No development raise: the public figure is already above a hand-tester's rate.
export const FOOD_PER_HOUR = 3000;
// The per-address backstop for the same reads (see ENGINE_PER_HOUR_IP for why it sits above the account figure).
export const FOOD_PER_HOUR_IP = 6000;
// The upstream reads a sqlite release; a slow answer is a cold cache, not a model pass. Same
// outermost bound as the recipe routes.
const FOOD_UPSTREAM_TIMEOUT_MS = 60000;
// The path shape. `source` is the API's closed set (fresh-assistant-api#62; `branded` is a later
// addition there and is added here the day it ships, not before). `code` is a food code, an FNDDS
// 8-digit code or an SR Legacy NDB number; it is bounded and character-restricted so the upstream
// URL is built from a known shape, and anything else is this hop's 404 with nothing forwarded.
// The leaf is the view: `attributes` (the per-food attribute panel, fresh-assistant-api#62) or
// `ledger` (the served food-card ledger view, fresh-assistant-api#69, fresh-insights#58). Both are
// reads of a pinned release through the same bearer, the same ceiling and the same headers; the
// view is the one thing that differs in the upstream URL and the log label.
const FOOD_ROUTE = /^\/api\/food\/(fndds|sr)\/([A-Za-z0-9_.-]{1,40})\/(attributes|ledger)$/;
// The one label per view written to engine_log: the template, never the code. Which food a device
// opened, clustered by same-day ip_hash, is exactly what that table's schema comment promises not
// to hold. Both labels sit under `/food/%`, so the two views share the one read ceiling.
const foodRouteLabel = view => `/food/:source/:code/${view}`;
// Passed back to the caller: Content-Type; ETag and Cache-Control, which the phone caches on (per
// food and release, fresh_app#495); Retry-After for an upstream 429/503, as on the recipe routes.
const FOOD_RESPONSE_HEADERS = ["content-type", "etag", "cache-control", "retry-after"];
// The one request header forwarded upstream, so the ETag passed back is usable: a validator the
// phone sends gets the upstream's 304 instead of a second copy of the body. Bounded to printable
// ASCII; anything else is dropped (the upstream then answers in full), never refused.
const IF_NONE_MATCH_SHAPE = /^[\x21-\x7e][\x20-\x7e]{0,498}$/;
// One item's scoring record (fresh-assistant-api GET /api/record/{item_id}, its
// docs/api/scoring_record_contract.md, fresh-assistant-api#168) for fresh_app's scoring-record
// reader. Like the food views, a read of a pinned, immutable release with no model call, so it has
// a READ ceiling of its own at the food figures: a reader opened beside a food card spends neither
// the card's ceiling nor the engine's.
export const RECORD_PER_HOUR = 3000;
export const RECORD_PER_HOUR_IP = 6000;
const RECORD_UPSTREAM_TIMEOUT_MS = 60000;
// The item id is `<source>:<code>`, the colon raw or percent-encoded (the pathname keeps `%3A` as
// sent). `source` is a closed set: the prefixes the pinned release holds. Foods are fndds and sr;
// the 186 catalog recipes are gen (82), nhlbi (53), usda (45) and hhs (6), counted from
// scoring-record-1.2.2-2026-10-24's recipes shard on 2026-10-28. The contract names only some of
// them, so the set is the release's, not the contract's. A new one is added here the day a release
// holds it (the upstream's 404 `unknown item` is what an absent id gets). `code` is the upstream's own
// ITEM_ID_RE tail (lib/scoring_record.js), so a request this hop forwards is one the upstream can
// read as an id. Anything else under /api/record/ is this hop's 400, nothing forwarded.
const RECORD_PREFIX = "/api/record/";
const RECORD_ROUTE = /^\/api\/record\/(fndds|sr|usda|gen|hhs|nhlbi)(?::|%3[Aa])([A-Za-z0-9._~-]{1,160})$/;
// The one label written to engine_log: never the item id (see foodRouteLabel).
const RECORD_LABEL = "/record/:item_id";
// Passed back to the caller: the food views' four, plus the release the record came from.
const RECORD_RESPONSE_HEADERS = [...FOOD_RESPONSE_HEADERS, "x-scoring-record-release"];
// The rate host's tuple of rating inputs (fresh-assistant-api docs/api/recipe_rate_contract.md 3.19,
// fresh-assistant-api#172), read from that service's /health. fresh_app stores it with a saved
// recipe's rating and re-rates the recipe when the stored value differs from this one; one call per
// app session is the expected use. /health is public and carries a good deal besides the tuple (the
// model name, the corpus counts, the release pins), so this route reads it and returns ONLY the
// tuple: nothing else from /health crosses this hop. A read of a small page with no model call and
// no engine pass, so an abuse ceiling of its own, at the engine's figures, not a share of another's.
export const RATING_TUPLE_PER_HOUR = 300;
export const RATING_TUPLE_PER_HOUR_IP = 600;
const RATING_TUPLE_UPSTREAM_TIMEOUT_MS = 15000;
const RATING_TUPLE_PATH = "/api/rating-tuple";
// The one label written to engine_log (the route has no instance to hide, but it is a label like the others).
const RATING_TUPLE_LABEL = "/rating-tuple";
// Where a rating (or a swap search) is, for fresh_app's import screen: fresh-assistant-api
// GET /api/recipe/rate/progress/{request_id} (docs/api/recipe_rate_contract.md 3.21 and 3.22). The app
// polls about once a second per import for the 10 to 30 s a rating takes, so this is by far the most
// frequent call here and has a ceiling of its own, far above the rate route's (which a poll must not
// spend): 6,000 an hour per account is one import polled every second for an hour and a half over,
// 12,000 per address. Each poll writes one engine_log row (label and status only), the figure that
// matters against Workers Free's 100,000 D1 rows written a day. The upstream answers from memory
// (and, on a miss, asks its sibling machine for at most 0.8 s each), so 3 s is generous; no retry.
export const RATE_PROGRESS_PER_HOUR = 6000;
export const RATE_PROGRESS_PER_HOUR_IP = 12000;
const RATE_PROGRESS_UPSTREAM_TIMEOUT_MS = 3000;
// The id is a request_id: letters, digits, '.', '_' and '-', at most 200, not starting with '.'
// (the contract's own shape; the app mints ids of it). It is the whole tail of the path.
// The API also refuses an id ending in .jsonl (its trace-file suffix, any case), so this does too, with no call.
const RATE_PROGRESS_ROUTE = /^\/api\/recipe\/rate\/progress\/(?![^]*\.jsonl$)([A-Za-z0-9_-][A-Za-z0-9._-]{0,199})$/i;
const RATE_PROGRESS_PREFIX = "/api/recipe/rate/progress/";
// Written to engine_log in place of the path, which carries the request id. Not under /recipe/, so
// it never counts toward (or against) the recipe routes' per-hour ceilings.
const RATE_PROGRESS_LABEL = "/rate-progress";
// A sha256 as 64 lowercase hex. Anything else the upstream sends in its place is answered as null.
const TUPLE_SHA256 = /^[0-9a-f]{64}$/;
// short enough that a re-pin reaches the app within the minute, long enough that an app opening
// several screens reads it once.
const RATING_TUPLE_CACHE_CONTROL = "private, max-age=60";

// The views readCapped allocated itself with spare room behind them. Only these may be written past
// their end: a chunk the stream handed over can be a window into a larger shared buffer, where
// "bytes after the view" belong to someone else.
const ownsRoomBehind = new WeakSet();

// Reads `body` into one Uint8Array, or returns null once more than `max` bytes have arrived (the
// read stops there; nothing past the cap is held).
//
// `declared` (the inbound Content-Length) and `room` are for the bodies big enough that copies
// matter: a Worker isolate has 128 MB, and the chunk list plus its joined copy plus insertAccountId's
// output is three copies of the body (~120 MB of buffers at transcribe-video's 60 MB, measured). With
// a usable `declared`, the bytes are written once into a buffer of `declared + room`, and the result
// is a view of it with `room` spare bytes behind it, which insertAccountId can fill in place. A body
// that turns out longer than declared drops to the plain chunk path (the result then has no spare).
async function readCapped(body, max, declared = 0, room = 0) {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  let chunks = [];
  let total = 0;
  const sized = Number.isSafeInteger(declared) && declared > 0 && declared <= max;
  let buf = sized ? new Uint8Array(declared + room) : null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    if (buf && total + value.byteLength <= declared) {
      buf.set(value, total);
    } else {
      if (buf) { chunks = [buf.subarray(0, total)]; buf = null; }
      chunks.push(value);
    }
    total += value.byteLength;
  }
  if (buf) {
    const view = buf.subarray(0, total);
    ownsRoomBehind.add(view);
    return view;
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

// fresh-assistant-api's own body cap for every recipe route except the media ones, transcribe and
// transcribe-video (server.js bodyCap).
// extract and rate bodies are read whole and checked here (withAccountId), so this hop holds them
// to the same size, which also bounds the scan's CPU well inside a Workers Free request's 10 ms.
const RECIPE_SMALL_BODY_BYTES = 200_000;
// /api/recipe/extract is the exception: the phone fetches the recipe page itself and sends it as
// `{url, html}` (fresh_app recipeService.extractFromUrl), and the upstream accepts up to 3 MB of HTML
// (7 MB JSON-escaped, its bodyCap). 200 KB refused almost every real recipe page with "request too
// large" (Josh, 2026-10-16: URL import). 4 MB covers 3 MB of HTML plus JSON escaping; the body goes
// through insertAccountId, like transcribe, because withAccountId's full-grammar pass is ~3 ms per
// 200 KB and does not fit Workers Free's 10 ms of CPU at this size. rate and image stay at 200 KB.
export const RECIPE_EXTRACT_BODY_BYTES = 4 * 1024 * 1024;

// The body of /api/recipe/transcribe (10 MB of photos) or /api/recipe/transcribe-video (60 MB) with
// `,"account_id":<accountId>` inserted before its closing brace. Used instead of withAccountId because this account is on Workers Free (10 ms CPU per
// request; confirmed 2026-10-01, when the API refused a CPU-limit setting with "not supported for
// the Free plan"), and no pass over every byte of a 10 MB photo body fits in that. This looks only
// at the leading and trailing whitespace; the copy is one native set().
//
// Why the insertion is enough: JSON.parse keeps the LAST of duplicate keys, and nothing can follow
// the inserted member except the closing brace and whitespace. So in any body the upstream can
// parse, the top-level account_id it reads is this one, whatever the caller put earlier; and the
// insertion cannot make an unparseable body parseable with a different value (it begins with a
// comma, so it cannot complete an open string or escape, and it adds no brackets). Returns null
// for a body that does not start with `{` and end with `}` (the route's 400); anything else
// malformed in between is the upstream's 400 ("invalid JSON"), exactly as before this change.
// A leading UTF-8 BOM is dropped, since the upstream's JSON.parse rejects one.
//
// The whole body is read before anything is sent (not streamed with the insertion at the end):
// a stream cut short by the cap or a bad tail would already have delivered a prefix such as
// `{"account_id":"theirs"}`, and whether the upstream then parses it would rest on every hop
// aborting the connection rather than ending it. A complete, fixed-length body leaves no prefix.
//
// With `inPlace`, and `bytes` a view readCapped allocated with spare room behind it, the member is
// written into that room and only the closing brace and trailing whitespace move: no second copy of
// the body, which is what lets a 60 MB transcribe-video body fit a 128 MB isolate. That mutates the
// buffer, so it is opt-in, and any other array (not allocated by readCapped) gets a fresh copy.
export function insertAccountId(bytes, accountId, inPlace = false) {
  const isWs = c => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;
  let start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let f = start;
  while (f < bytes.length && isWs(bytes[f])) f++;
  let k = bytes.length - 1;
  while (k >= f && isWs(bytes[k])) k--;
  if (f >= bytes.length || bytes[f] !== 0x7b || k <= f || bytes[k] !== 0x7d) return null;
  let j = k - 1;
  while (j > f && isWs(bytes[j])) j--;
  // `{}` takes the member with no comma; anything else after its last member.
  const member = new TextEncoder().encode(
    (j === f ? "" : ",") + `"account_id":${JSON.stringify(accountId ?? null)}`);
  if (inPlace && ownsRoomBehind.has(bytes)
      && bytes.buffer.byteLength - bytes.byteOffset - bytes.length >= member.length) {
    const full = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length + member.length);
    full.copyWithin(k + member.length, k, bytes.length); // `}` and trailing whitespace: a few bytes
    full.set(member, k);
    return full.subarray(start);
  }
  const out = new Uint8Array(bytes.length - start + member.length);
  out.set(bytes.subarray(start, k), 0);
  out.set(member, k - start);
  out.set(bytes.subarray(k), k - start + member.length);
  return out;
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
    // gate: /api/comments, /api/subscribe, /api/feedback, /api/retrieve, /api/ask, /api/recipe/*,
    // /api/food/*, /api/record/*, /api/rating-tuple, /api/recipe/rate/progress/* and /admin/hide check their own method, but /admin/comments, /admin/subscribers,
    // /admin/feedback and /health answer any method. A new handler must check its own method.
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    // Authorization is listed because the Clerk-authenticated routes (/api/engine/*,
    // /api/recipe/*) are called from fresh_app's web build too, and a browser preflight for a
    // bearer-carrying request fails without it. Listing it grants nothing: the JWT check is
    // the boundary on those routes, and every other route ignores the header. If-None-Match is
    // listed so the web build can revalidate a scoring record (/api/record/*) itself; the food
    // and record routes forward it upstream only after a shape check.
    "Access-Control-Allow-Headers": "Content-Type, Authorization, If-None-Match",
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

// The caller's verified Clerk `sub`, hashed with the day exactly as ipHash is: not reversible,
// unlinkable across days, and never written beside a route instance (engine_log's schema comment
// still holds: it records which route was hit, and now an opaque same-day account key for the
// ceiling to count; nothing readable names a person).
async function acctHash(sub) {
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("acct:" + sub + "|" + day));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

// Count this caller's rows in the last hour for the per-account ceiling and the per-IP backstop in
// ONE query, and say which fired. `pathSql` is a fixed fragment chosen by the route (never caller
// input). Retry-After is when the OLDEST counted row leaves the hour window (never 0, never over
// 3600); when a count cannot say (a scripted test DB), 60.
async function overCeiling(env, { pathSql, acct, ip, acctMax, ipMax }) {
  const { results } = await env.DB.prepare(
    "SELECT " +
    "SUM(CASE WHEN acct_hash = ?1 THEN 1 ELSE 0 END) AS acct_n, " +
    "CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', MIN(CASE WHEN acct_hash = ?1 THEN created_at END)) AS INTEGER) AS acct_age, " +
    "SUM(CASE WHEN ip_hash = ?2 THEN 1 ELSE 0 END) AS ip_n, " +
    "CAST(strftime('%s','now') AS INTEGER) - CAST(strftime('%s', MIN(CASE WHEN ip_hash = ?2 THEN created_at END)) AS INTEGER) AS ip_age " +
    "FROM engine_log WHERE (acct_hash = ?1 OR ip_hash = ?2) AND " + pathSql +
    " AND created_at > datetime('now', '-1 hour')"
  ).bind(acct, ip).all();
  const r = results?.[0] || {};
  const wait = age => Number.isFinite(age) ? Math.min(3600, Math.max(1, 3600 - age)) : 60;
  if ((r.acct_n || 0) >= acctMax) return { scope: "account", max: acctMax, retryAfter: wait(r.acct_age) };
  if ((r.ip_n || 0) >= ipMax) return { scope: "address", max: ipMax, retryAfter: wait(r.ip_age) };
  return null;
}

// The 429 for either ceiling: JSON with `error` and a `reason` a person can read, and Retry-After.
function tooMany(hit, what, cors) {
  const who = hit.scope === "account" ? "this account" : "this network address";
  const res = json({ error: "too many requests — try again later",
                     reason: `${what} limit reached for ${who} (${hit.max} per hour); try again in ${Math.ceil(hit.retryAfter / 60)} min`,
                     scope: hit.scope, retry_after: hit.retryAfter }, 429, cors);
  res.headers.set("Retry-After", String(hit.retryAfter));
  return res;
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
  "/simulate",
  "/intakes/latest",
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

        // The tools this client answers itself (ask contract 1.7: `get_my_diet` today, `suggest_recipes`
        // and `write_recipe` for the server-run recipe tools). The assistant service offers a tool to
        // the model only when the request declares it, so a Worker that drops the field makes every
        // tool look unsupported: a signed-in build asked "how is my diet" got no get_my_diet call
        // through here while a direct call to Fly got one. The service bounds it the same way
        // (16 names, 40 characters); this hop adds the name shape, so nothing but identifiers
        // travels, and a name it does not know is the service's to ignore. A list is a capability
        // set, not a round, so an entry that fails is dropped alone and the rest still go.
        const clientTools = Array.isArray(b.client_tools)
          ? b.client_tools.slice(0, ASK_MAX_CLIENT_TOOLS).filter(n => typeof n === "string" && CLIENT_TOOL_NAME.test(n))
          : [];

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
              ...(clientTools.length ? { client_tools: clientTools } : {}),
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

        // Recipe, food and record rows share engine_log (see /api/recipe/*, /api/food/* and
        // /api/record/* below) but not this ceiling.
        const hash = await ipHash(req);
        const acct = await acctHash(verified.sub);
        const hit = await overCeiling(env, {
          pathSql: "path NOT LIKE '/recipe/%' AND path NOT LIKE '/food/%' AND path NOT LIKE '/record/%' AND path NOT LIKE '/rating-tuple%' AND path NOT LIKE '/rate-progress%'",
          acct, ip: hash, acctMax: ENGINE_PER_HOUR, ipMax: ENGINE_PER_HOUR_IP,
        });
        if (hit) return tooMany(hit, "diet engine", cors);

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
          "INSERT INTO engine_log (path, ip_hash, status, acct_hash) VALUES (?1, ?2, ?3, ?4)"
        ).bind(routeLabelFor(suffix), hash, upstream.status, acct).run();

        // Pass the engine's response through unchanged (status + body); only the CORS headers
        // are ours to add on top.
        const respHeaders = new Headers(upstream.headers);
        for (const [k, v] of Object.entries(cors)) respHeaders.set(k, v);
        return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
      }

      // ── Recipe import and rating (fresh-assistant-api /api/recipe/*) for fresh_app.
      //
      // extract {url} is a deterministic fetch+parse, transcribe {images:[{data, media_type}]} is
      // a paid vision model call, transcribe-video {url? | post? | media? | frames?} is a paid model
      // call over a video (fresh-assistant-api PR #56), rate {title?, servings, lines} proxies to the
      // rate process, image {title, ingredients} generates one photo of the dish (a paid OpenAI
      // call, 3 per account per UTC day, counted upstream on the account_id this hop forwards; its
      // 429 daily_cap, 503 disabled / store_unavailable and 404 pass through unchanged). The
      // signed image_url it returns points at the upstream host and needs no bearer, so the phone
      // loads it directly and this Worker serves no image GET. archive-video {url, media?,
      // transcript?, post?, screenText?} keeps a caption import's video and texts in the API's
      // corpus (fresh-assistant-api PR #109) under its own ceiling (RECIPE_ARCHIVE_PER_HOUR).
      // suggest-swaps takes rate's body (fresh-assistant-api PR #111), runs one model call plus a
      // re-rate per swap, and has its own ceiling and timeout (RECIPE_SWAPS_PER_HOUR). photo {url}
      // returns a saved video recipe's current post photo (fresh-assistant-api PR #130) under its own
      // ceiling (RECIPE_PHOTO_PER_HOUR).
      // The upstream gates all eight on the same ASK_TOKEN bearer as /ask, so none of them may be
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

        // Size caps, enforced twice: a declared Content-Length over the cap is refused here before
        // anything is claimed or forwarded, and a body with no Content-Length (chunked) is counted
        // as it is read and refused at the cap. transcribe's base64 photos get the engine route's
        // 10 MB (the upstream allows 50 MB there); extract and rate get the upstream's own 200 KB.
        // Either way a 413 is this hop's.
        // transcribe-video takes the upstream's own 60 MB (RECIPE_VIDEO_BODY_BYTES). Both transcribe
        // routes carry media, so both take the insertion path below instead of the full scan.
        // archive-video takes the same 60 MB as transcribe-video (the upstream's own cap there is
        // 34 MB, ARCHIVE_BODY_CAP: 24 MB of media as base64 plus texts), so this hop never refuses an
        // archive body the upstream accepts; one between the two caps is the upstream's 413.
        const isTranscribe = path === "/api/recipe/transcribe";
        const isVideo = path === "/api/recipe/transcribe-video";
        const isArchive = path === "/api/recipe/archive-video";
        const isExtract = path === "/api/recipe/extract";
        const isWrite = path === "/api/recipe/write";
        const hasMedia = isTranscribe || isVideo || isArchive || isWrite;
        // Bodies too big for withAccountId's per-byte pass on Workers Free (media, a recipe writer's
        // photo, and an extract carrying a fetched page) take the insertion path.
        const bigBody = hasMedia || isExtract;
        const maxBody = isVideo || isArchive ? RECIPE_VIDEO_BODY_BYTES
                      : isTranscribe ? ENGINE_MAX_BODY_BYTES
                      : isWrite ? RECIPE_WRITE_BODY_BYTES
                      : isExtract ? RECIPE_EXTRACT_BODY_BYTES : RECIPE_SMALL_BODY_BYTES;
        const tooLarge = () => json({ error: "request body too large",
                                      reason: isVideo || isArchive ? "video too large; send a shorter or smaller clip"
                                            : isTranscribe ? "photos too large; send fewer or smaller photos"
                                            : isWrite ? "photo too large; send a smaller photo"
                                            : isExtract ? "page too large to import; paste the recipe text instead"
                                            : "request too large" }, 413, cors);
        const contentLength = req.headers.get("Content-Length");
        if (contentLength && Number(contentLength) > maxBody) return tooLarge();

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
        const isDev = recipeDevSubs.includes(verified.sub);
        // Five ceilings on the same key: archive-video, suggest-swaps, photo and write each count only
        // their own rows against their own figure (RECIPE_ARCHIVE_PER_HOUR, RECIPE_SWAPS_PER_HOUR,
        // RECIPE_PHOTO_PER_HOUR, RECIPE_WRITE_PER_HOUR), and every other recipe route counts every
        // /recipe/% row except those four routes' against RECIPE_PER_HOUR.
        const isSwaps = path === "/api/recipe/suggest-swaps";
        const isPhoto = path === "/api/recipe/photo";
        const recipeCeiling = isArchive ? (isDev ? RECIPE_ARCHIVE_PER_HOUR_DEV : RECIPE_ARCHIVE_PER_HOUR)
                            : isSwaps ? (isDev ? RECIPE_SWAPS_PER_HOUR_DEV : RECIPE_SWAPS_PER_HOUR)
                            : isPhoto ? (isDev ? RECIPE_PHOTO_PER_HOUR_DEV : RECIPE_PHOTO_PER_HOUR)
                            : isWrite ? (isDev ? RECIPE_WRITE_PER_HOUR_DEV : RECIPE_WRITE_PER_HOUR)
                            : (isDev ? RECIPE_PER_HOUR_DEV : RECIPE_PER_HOUR);
        const hash = await ipHash(req);
        const ownLabel = isArchive || isSwaps || isPhoto || isWrite;
        const counted = ownLabel ? "path = ?1"
                                 : "path LIKE '/recipe/%' AND path NOT IN (?4, ?5, ?6, ?7)";
        const countBinds = ownLabel ? [RECIPE_ROUTES[path], hash, recipeCeiling]
                                    : [RECIPE_ROUTES[path], hash, recipeCeiling,
                                       RECIPE_ARCHIVE_LABEL, RECIPE_SWAPS_LABEL, RECIPE_PHOTO_LABEL, RECIPE_WRITE_LABEL];

        const claim = await env.DB.prepare(
          "INSERT INTO engine_log (path, ip_hash, status) SELECT ?1, ?2, NULL " +
          `WHERE (SELECT COUNT(*) FROM engine_log WHERE ip_hash = ?2 AND ${counted} ` +
          "AND created_at > datetime('now', '-1 hour')) < ?3"
        ).bind(...countBinds).run();
        if (!claim?.meta?.changes)
          return json({ error: "too many requests — try again later",
                        reason: `${isArchive ? "archive" : isSwaps ? "swap suggestion" : isPhoto ? "photo refresh" : isWrite ? "recipe writing" : "recipe"} limit reached (${recipeCeiling} per hour); try again later` }, 429, cors);
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
        // decides whose log line a call lands in. Exactly as on /api/ask, the id the upstream reads
        // is the verified Clerk `sub`: a body-supplied account_id never reaches it, and the sub is
        // never merely added when missing. Every route, so a route the upstream does not log
        // account_id on today does not start carrying a caller's claim the day it does.
        //   - rate, image, suggest-swaps, photo (at most 200 KB): read whole and rewritten by withAccountId, which
        //     checks the full JSON grammar, removes every top-level account_id and puts the sub
        //     first. Not JSON, or not an object: this hop's 400, nothing forwarded.
        //   - extract (up to 4 MB: a page the phone fetched), transcribe (up to 10 MB of photos) and
        //     transcribe-video (up to 60 MB): read whole, then
        //     insertAccountId inserts the sub
        //     as the last member, where JSON.parse's last-duplicate-wins makes it the value the
        //     upstream reads. A body that does not start with `{` and end with `}` is this hop's
        //     400; other malformed JSON is the upstream's 400, as before.
        // The split is the CPU budget: this account is on Workers Free, 10 ms per request.
        // Measured 2026-10-01 (Node 24, a loaded dev machine): withAccountId takes ~0.1 ms on a
        // 2 KB rate body and ~3 ms at 200 KB, but ~150 ms on a 10 MB photo body, where reading it
        // and insertAccountId together take a few ms (see the README).
        // After the claim, so a caller at the ceiling costs no read; a refused body counts like
        // any upstream 400 would.
        const badBody = () => json({ error: "invalid request body",
                                     reason: "request body must be a JSON object" }, 400, cors);
        const accountId = forwardableSub(verified.sub);
        // A body that cannot be read (the caller disconnected mid-upload) is the caller's
        // failure, a 400, not "recipe service unreachable".
        let raw;
        try {
          // Media bodies leave room (the longest member is under 230 bytes) for the in-place insertion.
          raw = await readCapped(req.body, maxBody, bigBody ? Number(contentLength) : 0, bigBody ? 256 : 0);
        } catch {
          await recordStatus(400);
          return badBody();
        }
        if (!raw) {
          await recordStatus(413);
          return tooLarge();
        }
        const body = bigBody ? insertAccountId(raw, accountId, true) : withAccountId(raw, accountId);
        // `raw` is dropped, but on an in-place insertion `body` is the same buffer, so a media body
        // stays held through the upstream call; only the copy path releases it.
        raw = null;
        if (!body) {
          await recordStatus(400);
          return badBody();
        }

        // Headers built from scratch, as on the engine route: the inbound Authorization (the
        // user's Clerk JWT) never travels upstream. The body is a complete Uint8Array, so it goes
        // with a Content-Length; nothing is sent until it has been checked.
        // Everything between the claim and the upstream's answer sits inside this try, so any
        // throw records a status on the claimed row instead of leaving it NULL behind a 500.
        let upstream;
        try {
          upstream = await fetch(env.ASK_UPSTREAM.replace(/\/$/, "") + path, {
            method: "POST",
            headers: new Headers({
              "Authorization": `Bearer ${env.ASK_TOKEN}`,
              "Content-Type": "application/json",
            }),
            body,
            signal: AbortSignal.timeout(path === "/api/recipe/image" ? RECIPE_IMAGE_UPSTREAM_TIMEOUT_MS
              : isArchive ? RECIPE_ARCHIVE_UPSTREAM_TIMEOUT_MS
              : isSwaps ? RECIPE_SWAPS_UPSTREAM_TIMEOUT_MS
              : isWrite ? RECIPE_WRITE_UPSTREAM_TIMEOUT_MS : RECIPE_UPSTREAM_TIMEOUT_MS),
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

      // ── Per-food attributes (fresh-assistant-api GET /api/food/{source}/{code}/attributes) for
      // fresh_app's food card. fresh_app#495: the phone keeps only the store index and the 14 label
      // lines, and fills the card's register from this route when a card opens, one request per
      // food per open, cached on the device per food and release. fresh-assistant-api#62 holds the
      // contract ({release, source, code, name, basis, rows, serving?}; 404 for an unknown code;
      // ETag; cached per food). The upstream gates it on the same ASK_TOKEN bearer as /ask and the
      // recipe routes, so it is reachable only through here.
      //
      // The shape is /api/recipe/*'s: the caller's Clerk session JWT is verified (the same 401 and
      // the two 503s), then the upstream request carries OUR service bearer and nothing the caller
      // sent. Nothing caller-supplied can name an account upstream: the inbound Authorization,
      // X-Fresh-User and Cookie are not forwarded, and neither is the query string (the route takes
      // no parameters, so `?account_id=` or anything else there is dropped, not passed). The
      // verified sub itself is NOT forwarded either: the upstream's contract has no account field,
      // the answer is per food and not per person, and sending an id the upstream does not read
      // would only create a which-food-this-account-opened record there should it ever log headers.
      // If the API route comes to want the caller's identity, the line is the engine route's
      // `X-Fresh-User: verified.sub`, set here from the verified sub and never from the request.
      //
      // Status and body pass through unchanged (a 200 with the panel, the upstream's 404 for an
      // unknown code, a 304 for a matching If-None-Match); of the upstream's headers only
      // FOOD_RESPONSE_HEADERS cross this hop. This hop's own 401, 503, 429 and 502 carry `reason`
      // beside `error`, as the recipe routes' do.
      const food = req.method === "GET" ? FOOD_ROUTE.exec(path) : null;
      if (food) {
        const unauthorized = () => json({ error: "unauthorized",
                                          reason: "could not verify sign-in; sign in again" }, 401, cors);
        const m = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (!m) return unauthorized();
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
        // service configured.
        if (!env.ASK_UPSTREAM || !env.ASK_TOKEN)
          return json({ error: "food service not configured",
                        reason: "food attributes are not configured on this server" }, 503, cors);

        // The ceiling: count before the call, write one row after it, as /api/engine/* does, and
        // NOT the recipe routes' claim-then-update. That pattern exists because an over-admitted
        // recipe call is a paid vision call; here an over-admitted call is one sqlite read, and it
        // costs two D1 row writes per request where this costs one. This will be the app's most
        // frequent call (one per food card opened), and Workers Free allows 100,000 D1 rows written
        // a day across every route, so the write per request is the figure that matters. The
        // known cost: card opens that arrive while earlier ones are still in flight all read the
        // same count, so a burst can overshoot the ceiling by the number in flight. At the ceiling
        // itself every one of them is refused. The count is over the `/food/%` labels only (both
        // views), so recipe and engine rows never count here, and the other two ceilings exclude
        // `/food/%`.
        const hash = await ipHash(req);
        const acct = await acctHash(verified.sub);
        const hit = await overCeiling(env, {
          pathSql: "path LIKE '/food/%'",
          acct, ip: hash, acctMax: FOOD_PER_HOUR, ipMax: FOOD_PER_HOUR_IP,
        });
        if (hit) return tooMany(hit, "food lookup", cors);
        // Route label and status only — see foodRouteLabel. Best effort: a D1 write failure costs
        // the row (one request escapes the count), never the answer the upstream already produced.
        const logRow = async status => {
          try {
            await env.DB.prepare("INSERT INTO engine_log (path, ip_hash, status, acct_hash) VALUES (?1, ?2, ?3, ?4)")
              .bind(foodRouteLabel(food[3]), hash, status, acct).run();
          } catch { /* the row is lost; the response is not */ }
        };

        // The upstream URL is built from the three matched segments only (source, code, view): no
        // query string, no fragment, nothing else from the request line. `code` already matches a URL-safe charset;
        // encodeURIComponent keeps that true should FOOD_ROUTE ever widen.
        const [, source, code, view] = food;
        const upstreamUrl = env.ASK_UPSTREAM.replace(/\/$/, "") +
          `/api/food/${source}/${encodeURIComponent(code)}/${view}`;
        // Headers built from scratch: the service bearer, and the caller's validator when it is a
        // sane shape. Nothing else the caller sent travels upstream.
        const upstreamHeaders = new Headers({ "Authorization": `Bearer ${env.ASK_TOKEN}` });
        const inm = req.headers.get("If-None-Match");
        if (inm !== null && IF_NONE_MATCH_SHAPE.test(inm)) upstreamHeaders.set("If-None-Match", inm);

        let upstream;
        try {
          upstream = await fetch(upstreamUrl, {
            method: "GET",
            headers: upstreamHeaders,
            signal: AbortSignal.timeout(FOOD_UPSTREAM_TIMEOUT_MS),
          });
        } catch {
          await logRow(502);
          return json({ error: "food service unreachable",
                        reason: "food service did not respond; try again later" }, 502, cors);
        }
        await logRow(upstream.status);

        // Cache-Control passes through as the upstream set it, `public` included, on a response to
        // a request that carried Authorization: a shared cache may then store it and serve it to
        // another client without the JWT. That is acceptable only because the panel is per food
        // and not per person. Should this route ever carry anything about the caller (the
        // X-Fresh-User line above, say), revisit this header at the same time.
        const respHeaders = new Headers(cors);
        for (const name of FOOD_RESPONSE_HEADERS) {
          const v = upstream.headers.get(name);
          if (v !== null) respHeaders.set(name, v);
        }
        // A 304 (and a 204) has no body by definition; the Response constructor throws on a non-null
        // body for those statuses, so the body is dropped here rather than trusted to be null.
        const nullBody = upstream.status === 204 || upstream.status === 304;
        return new Response(nullBody ? null : upstream.body, { status: upstream.status, headers: respHeaders });
      }

      // ── One item's scoring record (fresh-assistant-api GET /api/record/{item_id}) for fresh_app's
      // scoring-record reader. The food views' shape throughout: the caller's Clerk JWT is verified
      // (the same 401 and two 503s), the read ceiling is checked before the call and one row is
      // written after it, and the upstream request carries OUR service bearer, the caller's
      // If-None-Match when it is a sane shape, and nothing else. The verified sub is not forwarded:
      // a record is per item, not per person. Status and body pass through (200, the 304 with no
      // body, the upstream's 400, 404 and 503); of its headers only RECORD_RESPONSE_HEADERS cross.
      //
      // The one difference from the food views: an id that is not RECORD_ROUTE's shape is this
      // hop's 400 (the upstream's own `not an item id`), not a 404, checked after the JWT so an
      // anonymous caller gets the 401 whatever the path, and before the ceiling, so it costs no
      // row and nothing goes upstream.
      if (req.method === "GET" && path.startsWith(RECORD_PREFIX)) {
        const unauthorized = () => json({ error: "unauthorized",
                                          reason: "could not verify sign-in; sign in again" }, 401, cors);
        const m = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (!m) return unauthorized();
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

        const record = RECORD_ROUTE.exec(path);
        if (!record)
          return json({ error: "not an item id",
                        reason: "an item id is source:code, e.g. fndds:22311510" }, 400, cors);

        if (!env.ASK_UPSTREAM || !env.ASK_TOKEN)
          return json({ error: "record service not configured",
                        reason: "scoring records are not configured on this server" }, 503, cors);

        // Count before, one row after, over the `/record/%` label only; the food and engine
        // ceilings exclude it. See the food block for why this is not claim-then-update.
        const hash = await ipHash(req);
        const acct = await acctHash(verified.sub);
        const hit = await overCeiling(env, {
          pathSql: "path LIKE '/record/%'",
          acct, ip: hash, acctMax: RECORD_PER_HOUR, ipMax: RECORD_PER_HOUR_IP,
        });
        if (hit) return tooMany(hit, "scoring record", cors);
        const logRow = async status => {
          try {
            await env.DB.prepare("INSERT INTO engine_log (path, ip_hash, status, acct_hash) VALUES (?1, ?2, ?3, ?4)")
              .bind(RECORD_LABEL, hash, status, acct).run();
          } catch { /* the row is lost; the response is not */ }
        };

        // Built from the two matched parts only: the colon is always sent encoded, whichever form
        // the caller used, and the query string and anything else on the request line stay here.
        const [, source, code] = record;
        const upstreamUrl = env.ASK_UPSTREAM.replace(/\/$/, "") +
          `/api/record/${encodeURIComponent(`${source}:${code}`)}`;
        const upstreamHeaders = new Headers({ "Authorization": `Bearer ${env.ASK_TOKEN}` });
        const inm = req.headers.get("If-None-Match");
        if (inm !== null && IF_NONE_MATCH_SHAPE.test(inm)) upstreamHeaders.set("If-None-Match", inm);

        let upstream;
        try {
          upstream = await fetch(upstreamUrl, {
            method: "GET",
            headers: upstreamHeaders,
            signal: AbortSignal.timeout(RECORD_UPSTREAM_TIMEOUT_MS),
          });
        } catch {
          await logRow(502);
          return json({ error: "record service unreachable",
                        reason: "record service did not respond; try again later" }, 502, cors);
        }
        await logRow(upstream.status);

        const respHeaders = new Headers(cors);
        for (const name of RECORD_RESPONSE_HEADERS) {
          const v = upstream.headers.get(name);
          if (v !== null) respHeaders.set(name, v);
        }
        // A browser caller (the app's web build) reads the release, and the ETag it revalidates
        // with, from page JavaScript, which sees neither unless it is named here; the wrapper
        // merges its own names in.
        respHeaders.set("Access-Control-Expose-Headers", "X-Scoring-Record-Release, ETag");
        const nullBody = upstream.status === 204 || upstream.status === 304;
        return new Response(nullBody ? null : upstream.body, { status: upstream.status, headers: respHeaders });
      }

      // ── The rate host's rating tuple (fresh-assistant-api GET /health -> rating_tuple) for
      // fresh_app's saved recipes. The food and record routes' shape for the caller's side: the same
      // Clerk check (the same 401 and two 503s), a read ceiling of its own checked before the call
      // and one engine_log row written after it. The upstream side differs in two ways. /health is
      // public, so NO bearer is sent: ASK_TOKEN is not needed to read it and is not spent on it (only
      // ASK_UPSTREAM must be set). And nothing of what /health says crosses this hop but the tuple:
      // the body is rebuilt as {"rating_tuple": {"tuple_sha256": <64 hex>}} from the one field
      // read, whatever else the upstream sent, and a value that is not 64 lowercase hex is no tuple.
      //
      // A 200 always means "here is the tuple". `rating_tuple` is null on /health while the rate host
      // has not answered since a boot (the contract's 3.19), and /health can also fail, time out or
      // answer something that is not the object it is documented to be; every one of those is this
      // hop's 503 with `Cache-Control: no-store` and no ETag (nothing cached, nothing the client could
      // revalidate), so the app's existing error path keeps the last tuple it had and never reads an
      // absent tuple as an answer. A tuple carries a strong ETag of the hash and a short
      // `private, max-age=60`; an If-None-Match
      // that names it (or `*`) is answered 304 with no body, decided here from the value just read.
      // The upstream is read on every call (the tuple moves with a deploy, and this is the check that
      // says so), so a 304 still counts against the ceiling. The query string is dropped.
      if (req.method === "GET" && path === RATING_TUPLE_PATH) {
        const unauthorized = () => json({ error: "unauthorized",
                                          reason: "could not verify sign-in; sign in again" }, 401, cors);
        const m = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (!m) return unauthorized();
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

        if (!env.ASK_UPSTREAM)
          return json({ error: "rating service not configured",
                        reason: "the rating tuple is not configured on this server" }, 503, cors);

        const hash = await ipHash(req);
        const acct = await acctHash(verified.sub);
        const hit = await overCeiling(env, {
          pathSql: "path LIKE '/rating-tuple%'",
          acct, ip: hash, acctMax: RATING_TUPLE_PER_HOUR, ipMax: RATING_TUPLE_PER_HOUR_IP,
        });
        if (hit) return tooMany(hit, "rating tuple", cors);
        const logRow = async status => {
          try {
            await env.DB.prepare("INSERT INTO engine_log (path, ip_hash, status, acct_hash) VALUES (?1, ?2, ?3, ?4)")
              .bind(RATING_TUPLE_LABEL, hash, status, acct).run();
          } catch { /* the row is lost; the response is not */ }
        };
        const unavailable = async () => {
          await logRow(503);
          const res = json({ error: "rating tuple unavailable",
                             reason: "the rating tuple could not be read right now; try again later" }, 503, cors);
          res.headers.set("Cache-Control", "no-store");
          return res;
        };

        let upstream;
        try {
          upstream = await fetch(env.ASK_UPSTREAM.replace(/\/$/, "") + "/health", {
            method: "GET",
            headers: new Headers(),
            signal: AbortSignal.timeout(RATING_TUPLE_UPSTREAM_TIMEOUT_MS),
          });
        } catch {
          return unavailable();
        }
        // A non-2xx, or a body that is not a JSON object, is this hop failing to read the service.
        const data = upstream.ok ? await upstream.json().catch(() => null) : null;
        if (!data || typeof data !== "object" || Array.isArray(data)) return unavailable();
        const sha = data.rating_tuple && typeof data.rating_tuple === "object"
          ? data.rating_tuple.tuple_sha256 : null;
        const tuple = typeof sha === "string" && TUPLE_SHA256.test(sha) ? sha : null;

        if (!tuple) return unavailable();

        const respHeaders = new Headers(cors);
        // A browser caller reads the validator it revalidates with only if it is named here; the
        // wrapper merges its own names in.
        respHeaders.set("Access-Control-Expose-Headers", "ETag");
        const etag = `"${tuple}"`;
        respHeaders.set("ETag", etag);
        respHeaders.set("Cache-Control", RATING_TUPLE_CACHE_CONTROL);
        const inm = req.headers.get("If-None-Match");
        // The weak prefix is ignored (a weak comparison, RFC 9110 13.1.2): the edge may weaken the ETag
        // on a compressed 200 and the app sends back what it was given.
        if (inm !== null && IF_NONE_MATCH_SHAPE.test(inm) &&
            inm.split(",").some(v => { const t = v.trim().replace(/^W\//, ""); return t === etag || t === "*"; })) {
          await logRow(304);
          return new Response(null, { status: 304, headers: respHeaders });
        }
        await logRow(200);
        respHeaders.set("Content-Type", "application/json");
        return new Response(JSON.stringify({ rating_tuple: { tuple_sha256: tuple } }), { status: 200, headers: respHeaders });
      }

      // ── Where a rating is (fresh-assistant-api GET /api/recipe/rate/progress/{request_id}), for the
      // import screen's stages. The recipe routes' trust shape: the caller's Clerk session JWT is
      // verified (the same 401 and two 503s), and the upstream request carries OUR service bearer
      // and the verified subject as `X-Account-Id`, never anything the caller sent. The entry
      // belongs to the account of the rate call, which this Worker set from the verified sub
      // (forwardableSub, as on the rate route), so this sets the header from the same value: the
      // inbound X-Account-Id, Authorization, Cookie and query string are all dropped, and no
      // request id is ever written next to the subject (the log row holds the label, the status
      // and the account hash, as everywhere). A sub that is not fit to forward on the rate route
      // had no account upstream, so none is sent here.
      //
      // Status and JSON body pass through as the upstream gave them (200 {stage, lines_matched,
      // lines_total, updated_at} or a swap search's shape; the 404 {"error":"unknown request_id"}
      // for unknown, expired, another account's and not-started-yet; the upstream's own 401 and
      // 503), always with `Cache-Control: no-store`: a progress reading is stale at once. An id that
      // is not the shape above is the upstream's own 404, answered here with its body and no call.
      if (req.method === "GET" && path.startsWith(RATE_PROGRESS_PREFIX)) {
        // Every response this route builds says no-store, the 401 and the sign-in 503s included: a
        // poll once a second must not be answered from a cache with a stale error after sign-in recovers.
        const noStore = res => { res.headers.set("Cache-Control", "no-store"); return res; };
        const unauthorized = () => noStore(json({ error: "unauthorized",
                                                  reason: "could not verify sign-in; sign in again" }, 401, cors));
        const m = /^Bearer\s+(.+)$/.exec(req.headers.get("Authorization") || "");
        if (!m) return unauthorized();
        if (!env.CLERK_ISSUER || !env.CLERK_JWKS_URL)
          return noStore(json({ error: "sign-in verification not configured",
                                reason: "sign-in cannot be checked on this server right now; try again later" }, 503, cors));
        const verified = await verifyClerkJWT(m[1], {
          issuer: env.CLERK_ISSUER,
          jwksUrl: env.CLERK_JWKS_URL,
          jwksCache: clerkJwksCache,
        });
        if (!verified.ok && verified.reason === "jwks_unavailable")
          return noStore(json({ error: "sign-in verification unavailable",
                                reason: "sign-in cannot be checked right now; try again later" }, 503, cors));
        if (!verified.ok) return unauthorized();

        const progress = RATE_PROGRESS_ROUTE.exec(path);
        if (!progress) return noStore(json({ error: "unknown request_id" }, 404, cors));

        if (!env.ASK_UPSTREAM || !env.ASK_TOKEN)
          return noStore(json({ error: "progress service not configured",
                                reason: "rating progress is not configured on this server" }, 503, cors));

        const hash = await ipHash(req);
        const acct = await acctHash(verified.sub);
        const hit = await overCeiling(env, {
          pathSql: "path LIKE '/rate-progress%'",
          acct, ip: hash, acctMax: RATE_PROGRESS_PER_HOUR, ipMax: RATE_PROGRESS_PER_HOUR_IP,
        });
        if (hit) return noStore(tooMany(hit, "rating progress", cors));
        const logRow = async status => {
          try {
            await env.DB.prepare("INSERT INTO engine_log (path, ip_hash, status, acct_hash) VALUES (?1, ?2, ?3, ?4)")
              .bind(RATE_PROGRESS_LABEL, hash, status, acct).run();
          } catch { /* the row is lost; the response is not */ }
        };

        // Headers from scratch, so nothing the caller sent travels. The id is encoded and the URL has
        // no query string.
        const upstreamHeaders = new Headers({ "Authorization": `Bearer ${env.ASK_TOKEN}` });
        const subject = forwardableSub(verified.sub);
        if (subject) upstreamHeaders.set("X-Account-Id", subject);
        let upstream;
        try {
          upstream = await fetch(env.ASK_UPSTREAM.replace(/\/$/, "") + RATE_PROGRESS_PREFIX + encodeURIComponent(progress[1]), {
            method: "GET",
            headers: upstreamHeaders,
            signal: AbortSignal.timeout(RATE_PROGRESS_UPSTREAM_TIMEOUT_MS),
          });
        } catch {
          await logRow(502);
          return noStore(json({ error: "progress service unreachable",
                                reason: "rating progress did not respond; try again later" }, 502, cors));
        }
        await logRow(upstream.status);

        const respHeaders = new Headers(cors);
        const contentType = upstream.headers.get("Content-Type");
        if (contentType !== null) respHeaders.set("Content-Type", contentType);
        respHeaders.set("Cache-Control", "no-store");
        const nullBody = upstream.status === 204 || upstream.status === 205 || upstream.status === 304;
        return new Response(nullBody ? null : upstream.body, { status: upstream.status, headers: respHeaders });
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
    // A route that exposes headers of its own (/api/record/*) keeps them beside the version's.
    const ownExposed = res.headers.get("Access-Control-Expose-Headers");
    if (ownExposed) extra["Access-Control-Expose-Headers"] = `${ownExposed}, ${extra["Access-Control-Expose-Headers"]}`;
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
