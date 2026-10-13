-- Hand-written, not drizzle-kit generated — see drizzle/manual/README.md
-- for why this lives outside the normal migration flow and exactly
-- when to run it.
--
-- pg_trgm backs the GIN trigram index on items.name declared in
-- src/db/schema.ts (`items_name_trgm_idx`), which is what makes
-- partial-match, case-insensitive item search (SRCH-01) fast instead
-- of a sequential scan. The extension must exist before drizzle-kit's
-- generated migration creates that index, or it fails outright.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
