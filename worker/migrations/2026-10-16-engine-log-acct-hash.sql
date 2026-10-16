-- Per-account ceilings for /api/engine/* and /api/food/* (engine 300, food 3,000 per account per hour).
-- Run ONCE against the live database BEFORE deploying the Worker that writes acct_hash:
--   npx wrangler d1 execute fresh-insights-engage --remote --file=migrations/2026-10-16-engine-log-acct-hash.sql
-- Rows written earlier keep acct_hash NULL and simply do not count toward an account's hour.
ALTER TABLE engine_log ADD COLUMN acct_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_engine_acct ON engine_log(acct_hash, created_at);
