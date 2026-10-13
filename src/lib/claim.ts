/**
 * "Claim the idempotency key first" — the primitive every ledger-backed
 * mutating operation (checkout, check-in, consume, restock, adjustment)
 * is built on. See references/idempotency-and-concurrency.md.
 *
 * Why claim *before* mutating, not after: the obvious order is
 * "update the item, then insert the ledger row, and if the insert hits
 * the unique index, treat it as a replay." That order has two bugs that
 * only show up under a genuine concurrent duplicate:
 *
 *  1. Postgres aborts the whole transaction on any statement error, so
 *     the "re-check for the existing row" query after a caught unique
 *     violation fails with "current transaction is aborted" instead of
 *     finding the row it was looking for.
 *  2. Worse, for a quantity decrement the duplicate's UPDATE *succeeds*
 *     (stock is still sufficient) before the insert fails — and even if
 *     the abort in (1) were handled, that second decrement would already
 *     be applied. A duplicate request must never reach the mutation.
 *
 * Claiming first fixes both: the unique index admits exactly one
 * claimant per key. A duplicate blocks on the index until the winner
 * commits, then gets the unique violation *before* it has changed
 * anything. And because the claim runs inside its own SAVEPOINT, that
 * violation rolls back only the claim attempt, leaving the outer
 * transaction healthy enough to read the winner's row and replay it.
 * If the winner instead rolls back (its mutation hit a conflict), the
 * blocked duplicate's insert simply succeeds and it proceeds on its own
 * merits — a failed attempt never poisons its retries.
 */
import type { Db } from '../db/index.js';
import { isUniqueViolation } from './db-errors.js';

export type Claim<T> = { claimed: true; value: T } | { claimed: false };

export async function claimUnique<T>(
  tx: Db,
  constraintName: string,
  insert: (savepoint: Db) => Promise<T>,
): Promise<Claim<T>> {
  try {
    // Nested transaction call == SAVEPOINT (Drizzle/postgres-js).
    const value = await tx.transaction((savepoint) => insert(savepoint as unknown as Db));
    return { claimed: true, value };
  } catch (err) {
    if (isUniqueViolation(err, constraintName)) return { claimed: false };
    throw err;
  }
}
