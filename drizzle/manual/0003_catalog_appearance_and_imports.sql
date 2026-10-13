-- 0003: shelf/category/item colours and icons, the streaming import pipeline, and the indexes browsing needs.
-- Idempotent: safe to run more than once, and safe to run before or after `drizzle-kit migrate` has applied the same
-- schema changes (every statement uses IF NOT EXISTS). Run with:  psql "$DATABASE_URL" -f drizzle/manual/0003_catalog_appearance_and_imports.sql

-- Visual identity: palette / icon KEYS, validated by the API (src/lib/appearance.ts).
ALTER TABLE shelves     ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE shelves     ADD COLUMN IF NOT EXISTS icon  text;
ALTER TABLE categories  ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE categories  ADD COLUMN IF NOT EXISTS icon  text;
ALTER TABLE items       ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE items       ADD COLUMN IF NOT EXISTS icon  text;

-- Import pipeline: a 'validating' stage, progress counters, and a row-per-record staging table.
ALTER TYPE import_status ADD VALUE IF NOT EXISTS 'validating' AFTER 'uploaded';
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS file_bytes     bigint;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS processed_rows integer NOT NULL DEFAULT 0;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS valid_rows     integer;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS invalid_rows   integer;
ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS failure_reason text;

CREATE TABLE IF NOT EXISTS import_rows (
  import_id uuid    NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
  row_no    integer NOT NULL,
  data      jsonb   NOT NULL,
  PRIMARY KEY (import_id, row_no)
);

-- Keyset browsing of the items inside one category (the catalog's category page), and the time-window reads behind the
-- dashboard analytics. CONCURRENTLY so building them never blocks writes on a busy database (psql runs each statement on
-- its own, which CONCURRENTLY requires; do not wrap this file in a transaction).
CREATE INDEX CONCURRENTLY IF NOT EXISTS items_org_category_created_idx ON items (org_id, category_id, created_at, id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS tx_org_occurred_idx ON transactions (org_id, occurred_at);
