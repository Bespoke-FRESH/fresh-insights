-- The hourly ceilings counted in one row per (hour bucket, key) instead of COUNT(*) over engine_log
-- (2026-11-20: the engine_log counts read ~6.1M D1 rows a day against the Free plan's 5M).
-- Run ONCE against the live database BEFORE deploying the Worker that reads it:
--   npx wrangler d1 execute fresh-insights-engage --remote --file=migrations/2026-11-20-ceiling-count.sql
-- Idempotent. A Worker deployed without it answers 500 on every ceiling check, so run it first. engine_log and its indexes are unchanged.
CREATE TABLE IF NOT EXISTS ceiling_count (
  bucket   INTEGER NOT NULL,
  key      TEXT NOT NULL,
  n        INTEGER NOT NULL,
  first_at INTEGER NOT NULL,
  PRIMARY KEY (bucket, key)
) WITHOUT ROWID;
