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
-- model call, which is why the rate ceiling reads this table. Same privacy posture as
-- retrieval_log: what was asked, from which page and surface, never who asked it — ip_hash
-- rotates daily and is not reversible, and no reader identity is stored.
CREATE TABLE IF NOT EXISTS ask_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page       TEXT,                      -- pathname the question came from
  ip_hash    TEXT,
  app        TEXT,                      -- surface family, e.g. fresh_food_branded
  q          TEXT NOT NULL,
  n_actions  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ask_rate ON ask_log(ip_hash, created_at);
