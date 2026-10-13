# Hand-written SQL

Drizzle cannot express these, so they are applied by `npm run db:setup` **in this order**:

1. `0000_enable_extensions.sql` — `pg_trgm` (must exist before the generated migration creates the trigram indexes)
2. `drizzle-kit migrate` — tables, enums, indexes from `src/db/schema.ts`
3. `0001_role_settings.sql` — role-level `statement_timeout` / `lock_timeout` (set on the role, not per connection, because PgBouncer transaction pooling discards session settings)
4. `0002_ledger_immutability.sql` — append-only triggers on `transactions` and `audit_events`, self-referencing FKs, and the "corrected at most once" unique index. **Runs after the tables exist.**

Run 0001 with the application role as the target. Tests disable the ledger triggers only inside `resetDb()`.
5. `0003_catalog_appearance_and_imports.sql` — shelf/category/item colour and icon columns, the streaming-import staging table and progress fields, and the per-category browse index. Idempotent (every statement is `IF NOT EXISTS`), so it is safe on a database that already exists: run it directly with `psql "$DATABASE_URL" -f drizzle/manual/0003_catalog_appearance_and_imports.sql`. If you also run `drizzle-kit generate`, generate it from a clean snapshot or skip it for these columns, otherwise Drizzle will try to add them a second time.
