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
-- model call, which is why the rate ceiling reads this table. Unlike retrieval_log, this
-- surface can carry self-reported health information (fresh_app#75, commitment 5: "no query
-- text/food name/health content in any log"), so NO question content is kept: not the text,
-- not a prefix of it, not context/history/tool_results. Only page, surface, the rotating daily
-- IP hash the ceiling counts, and the action count. No reader identity is stored either.
--
-- `q` is LEGACY and always ''. The live table was created with `q TEXT NOT NULL` and SQLite
-- cannot drop or relax that without a table rebuild, so the Worker writes a fixed '' literal.
-- The DEFAULT '' here only affects a database created fresh from this file; `CREATE TABLE IF
-- NOT EXISTS` leaves the live table as it is. Rows written before this change still hold
-- question text; what happens to them is a separate retention decision (fresh-insights#37).
CREATE TABLE IF NOT EXISTS ask_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page       TEXT,                      -- pathname the question came from
  ip_hash    TEXT,
  app        TEXT,                      -- surface family, e.g. fresh_food_branded
  q          TEXT NOT NULL DEFAULT '',  -- LEGACY: always '', never the question (see above)
  n_actions  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ask_rate ON ask_log(ip_hash, created_at);

-- Calls proxied to the fresh_diet engine on Fly (/api/engine/*). Every caller is already
-- Clerk-authenticated by the time a row is written, so this table exists for the per-IP abuse
-- ceiling and for spotting a misbehaving client — never for who called it: no sub, no request
-- body, no response body. ip_hash rotates daily and is not reversible.
CREATE TABLE IF NOT EXISTS engine_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  path       TEXT NOT NULL,             -- known-route TEMPLATE or the constant "/unknown", never
                                         -- an instance: /intake/:id/score, not /intake/abc123/score,
                                         -- and never a raw/partially-redacted path for a route this
                                         -- table doesn't know (see routeLabelFor in index.js) — a
                                         -- raw id here would let same-day rows cluster which
                                         -- records one device touched
  ip_hash    TEXT,
  status     INTEGER,                   -- upstream response status; a /recipe/* row is claimed
                                         -- before its upstream call, so NULL there means in flight
                                         -- (or the status write failed)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_engine_rate ON engine_log(ip_hash, created_at);
