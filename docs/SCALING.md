# Scaling notes

What the code already does for load, what it deliberately leaves for later, and how to tell when "later" has arrived.
Nothing here has been load-tested at "millions of users" scale; the numbers marked **measured** come from one run on a
single small machine and are there to size expectations, not to promise capacity.

## What load actually looks like

Users are not the unit of load; **movements per organisation** are. A store with 100 workers records a few thousand
movements a day. Millions of users means many such organisations, each small. That shape scales out cleanly, because every
table is keyed by `org_id` and no request touches more than one organisation. The design below leans on that.

## Already in the code

| Concern | What is done | Where |
| --- | --- | --- |
| Many people watching one dashboard | Read-through Redis cache (15 s for the tiles, 60 s for analytics). Concurrent misses collapse into one query per instance. Every successful write bumps the organisation's cache version in `onSend`, so you always see your own change immediately; the TTL only covers changes made by the worker. Redis down = queries just run. | `src/lib/cache.ts`, `src/app.ts` |
| Heavy reads competing with ledger writes | Optional read replica: set `DATABASE_READ_URL` and the dashboard, analytics and reports read from it. Unset, they use the primary. | `src/db/index.ts`, `src/plugins/db.ts` |
| Big imports | Streamed into `import_rows`, validated and committed in chunks, each chunk one transaction that also writes its checkpoint (resumable). No whole-file buffer anywhere, including the web proxy. | `src/modules/imports/module.ts` |
| Time-window analytics | Bounded by `org_id` and a date window, backed by `tx_org_occurred_idx`. | `src/modules/views/module.ts` |
| Browsing a big catalog | Keyset (cursor) pagination, not OFFSET. A per-category index keeps "items in this category" cheap. | `items_org_category_created_idx` |
| Duplicate and replayed requests | Idempotency keys on every write; ledger is append-only (DB triggers). | pre-existing |

**Measured:** importing 20,000 consumables (new shelves, categories, items and opening-stock ledger entries) took 73 s on
one worker, about 275 rows/s, with the commit request itself returning in 6 ms. Upload and validation of the same file
took about 2 s and 0.5 s. A 200,000-row file would therefore import in roughly 12 minutes in the background. Several
imports can run at once across several workers.

## Not built yet, and the signal to build it

1. **Connection pooling (PgBouncer, transaction mode).** Do this before running more than a handful of API instances. The role-level
   timeouts in `0001_role_settings.sql` were written with it in mind.
2. **More workers.** Run `npm run dev:worker` as separate processes. Queue concurrency is `JOBS_CONCURRENCY`. Add workers when
   imports or the email outbox queue up.
3. **A bulk insert path for imports.** The 275 rows/s is the cost of creating each item through the same code path as the UI
   (ledger entry, stock level, audit). A multi-row path would be roughly an order of magnitude faster but must reproduce those
   invariants exactly. Worth doing when people routinely import more than ~50,000 rows.
4. **Partitioning `transactions`.** Not yet. The table has self-referencing foreign keys (corrections) and append-only triggers,
   and a partitioned table needs the partition key inside every key that is referenced. That is a design pass of its own.
   Revisit when a single organisation's ledger reaches tens of millions of rows; until then the `(org_id, ...)` indexes are enough.
5. **Rollup tables for analytics.** Today's analytics read a bounded window of the ledger. If a very large organisation's 30-day
   window gets slow, precompute per-day counts in the worker and read those instead.
6. **Load test.** Before a large launch, run a k6 script that mixes checkouts, check-ins and dashboard reads across, say, 500
   organisations, and write down the p95 you are willing to accept. Without that number, "scales" is only a guess.
7. **Direct-to-storage uploads.** Photos and CSVs go through the API today. For very large files, hand the browser a pre-signed
   S3 URL instead (the S3 client is already a dependency).
