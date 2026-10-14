-- 0004: lets one admin run several organisations. Idempotent; safe to run twice.
-- account_id groups the ADMIN rows of one person (one row per organisation). It is nullable and stays null for everyone
-- who works in a single organisation, including every invited user. Run with:
--   psql "$DATABASE_URL" -f drizzle/manual/0004_org_accounts.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS users_account_org_unique ON users (account_id, org_id) WHERE account_id IS NOT NULL;
