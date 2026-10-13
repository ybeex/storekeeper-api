-- Hand-written; see drizzle/manual/README.md. Run once per environment,
-- as a superuser or the role's owner, *after* the application role
-- exists. Replace `storekeeper` with your actual application role.
--
-- Why role-level and not a driver option: the app connects through
-- PgBouncer in transaction-pooling mode, which rejects unrecognized
-- startup parameters like `statement_timeout` and can't carry session
-- settings across reused connections anyway. Settings attached to the
-- *role* apply to every session that role opens, PgBouncer or not.

-- A runaway query on a 1M-user system is an incident, not a slow
-- request. 5s is well above every PRD response-time target (2s for
-- listing/dashboard, 500ms for search), so a query hitting it is a bug.
-- Long-running work (CSV import, report export) belongs in the
-- background worker, which connects as a *different* role without
-- this cap — see references/performance-and-scale.md.
ALTER ROLE storekeeper SET statement_timeout = '5s';

-- A transaction that opens and then sits idle holds row locks (and a
-- PgBouncer server connection) hostage. Nothing in this codebase does
-- meaningful non-DB work mid-transaction, so anything idle this long
-- is a leaked transaction.
ALTER ROLE storekeeper SET idle_in_transaction_session_timeout = '10s';

-- Advisory-lock and row-lock waits (the concurrency patterns in
-- references/idempotency-and-concurrency.md) should fail fast rather
-- than queue indefinitely behind a stuck holder.
ALTER ROLE storekeeper SET lock_timeout = '3s';
