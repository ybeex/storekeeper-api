/**
 * Database connection.
 *
 * Pool size is intentionally small *per process*. At 1M+ users, the
 * scaling lever is more stateless app instances behind a load balancer,
 * each holding a modest pool, all multiplexed through PgBouncer in
 * transaction-pooling mode — not one instance with a huge pool.
 * Postgres itself tops out around a few hundred real backend
 * connections; PgBouncer is what lets thousands of app-server
 * connections share that safely. Full reasoning and the sizing formula
 * are in references/performance-and-scale.md — don't raise DB_POOL_MAX
 * without reading that first.
 *
 * Two driver options here exist *because* of PgBouncer's transaction
 * pooling mode, and both are easy to get wrong:
 *
 *  - `prepare: false`. postgres.js uses named prepared statements by
 *    default; in transaction-pooling mode consecutive statements can
 *    land on different real connections, so a prepared statement
 *    created on one isn't there on the next ("prepared statement ...
 *    does not exist"). Disabling them costs a little parse overhead
 *    per query and buys correctness. (PgBouncer >= 1.21 can track
 *    protocol-level prepared statements if `max_prepared_statements`
 *    is configured — if you've confirmed that, this can be flipped.)
 *  - No `connection: { statement_timeout }` startup parameter.
 *    PgBouncer rejects unknown startup parameters ("unsupported startup
 *    parameter") unless explicitly ignored, and session settings
 *    wouldn't survive connection reuse anyway. The statement timeout is
 *    set on the *role* instead — see drizzle/manual/0001_role_settings.sql.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import type { PostgresJsQueryResultHKT } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';
import { env } from '../env.js';

const queryClient = postgres(env.DATABASE_URL, {
  max: env.DB_POOL_MAX, // per-process cap; see file header
  idle_timeout: 20,
  connect_timeout: 10,
  prepare: false, // required behind PgBouncer transaction pooling; see file header
});

export const db = drizzle(queryClient, { schema });

// Optional read replica for heavy, staleness-tolerant reads (dashboard, analytics, reports). Falls back to the primary.
const readClient = env.DATABASE_READ_URL
  ? postgres(env.DATABASE_READ_URL, { max: env.DB_READ_POOL_MAX, idle_timeout: 20, connect_timeout: 10, prepare: false })
  : null;
export const dbRead = readClient ? drizzle(readClient, { schema }) : db;

/**
 * The type every service function accepts — deliberately the *base*
 * `PgDatabase`, not `typeof db`. Both the top-level `db` and the `tx`
 * handed to a `db.transaction(async (tx) => ...)` callback are
 * assignable to it, which is what lets `checkoutOne(tx, ...)` and
 * `checkoutOne(db, ...)` share one signature. (Typing this as
 * `typeof db` looks equivalent but isn't: newer Drizzle versions add a
 * `$client` property to the top-level db that transactions don't have,
 * so a `tx` stops being assignable.)
 */
export type Db = PgDatabase<PostgresJsQueryResultHKT, typeof schema>;

export async function closeDb() {
  await queryClient.end({ timeout: 5 });
  await readClient?.end({ timeout: 5 });
}
