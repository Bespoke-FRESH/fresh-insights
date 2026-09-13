-- fresh-insights-engage D1 schema
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page       TEXT NOT NULL,             -- pathname, e.g. /the-shape-of-disagreement/
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  hidden     INTEGER NOT NULL DEFAULT 0,
  ip_hash    TEXT
);
CREATE INDEX IF NOT EXISTS idx_comments_page ON comments(page, hidden, created_at);

CREATE TABLE IF NOT EXISTS subscribers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  source     TEXT,                      -- pathname the signup came from
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page       TEXT,
  email      TEXT,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Retrieval lookups against the FRESH papers corpus (/api/retrieve). Kept for rate limiting
-- and to learn which claims readers actually check — never who checked them: ip_hash rotates
-- daily and is not reversible, and no reader identity is stored.
CREATE TABLE IF NOT EXISTS retrieval_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page       TEXT,                      -- pathname the lookup came from
  ip_hash    TEXT,
  q          TEXT NOT NULL,
  answered   INTEGER NOT NULL DEFAULT 0, -- 1 = the model-backed answer pass ran
  n_hits     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_retrieval_rate ON retrieval_log(ip_hash, answered, created_at);

-- Surface-chat turns proxied to the assistant service (/api/ask). Every row is one upstream
-- model call, which is why the rate ceiling reads this table. This surface can carry
-- self-reported health information (fresh_app issue #75, commitment 5: "no query text/food
-- name/health content in any log — app logs, Worker D1, crash reports"), so unlike the
-- blog-reader posture below, NO question content is retained: not the text, not a
-- prefix/truncation of it, not `context` or `history` (both are forwarded to the assistant
-- service and never reach this table). Only bounded, non-content metadata is kept: which
-- page/surface asked, the rotating daily IP hash the rate ceiling reads, how many actions the
-- turn returned, and a coarse length bucket. No reader identity is stored either way.
CREATE TABLE IF NOT EXISTS ask_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  page         TEXT,                      -- pathname the question came from
  ip_hash      TEXT,
  app          TEXT,                      -- surface family, e.g. fresh_food_branded
  q_len_bucket TEXT,                      -- 'short'|'medium'|'long' — NEVER the question text
  n_actions    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ask_rate ON ask_log(ip_hash, created_at);

-- MIGRATION for the already-deployed database (fresh-insights#75): `CREATE TABLE IF NOT
-- EXISTS` above only takes effect for a database that has never had this table — the live
-- `ask_log` still carries the original `q TEXT NOT NULL` column. SQLite (and D1) cannot drop
-- or relax a NOT NULL constraint without a full table rebuild, so as of this PR the legacy
-- `q` column is left in place and every insert writes it a fixed empty string — never the
-- real text, never a truncation of it. Run this once against the remote database to add the
-- new metadata column (safe, additive, does not touch existing rows):
--   npx wrangler d1 execute fresh-insights-engage --remote --command \
--     "ALTER TABLE ask_log ADD COLUMN q_len_bucket TEXT;"
-- Dropping the legacy `q` column (and deciding what happens to the question text already
-- sitting in existing rows) is a retention decision for Josh, not covered by this migration
-- — see the PR body for the existing-rows cleanup proposal.

-- Calls proxied to the fresh_diet engine on Fly (/api/engine/*). Every caller is already
-- Clerk-authenticated by the time a row is written, so this table exists for the per-IP abuse
-- ceiling and for spotting a misbehaving client — never for who called it: no sub, no request
-- body, no response body. ip_hash rotates daily and is not reversible.
CREATE TABLE IF NOT EXISTS engine_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,             -- engine path suffix, e.g. /version
  ip_hash    TEXT,
  status     INTEGER,                   -- upstream response status
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engine_rate ON engine_log(ip_hash, created_at);
