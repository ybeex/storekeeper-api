/**
 * Identifying Postgres errors by SQLSTATE code and constraint name.
 *
 * Two robustness points:
 *
 *  1. Match the *constraint name*, not just the generic 23505
 *     `unique_violation` code. Several different unique indexes raise
 *     the same code and need different handling (an idempotency-key
 *     collision means "replay the existing result"; a SKU collision
 *     means "tell the user the SKU is taken"). Dispatching on the
 *     constraint name keeps that explicit instead of guessing from text.
 *
 *  2. Walk the `.cause` chain. Depending on driver and Drizzle version,
 *     the Postgres error is either thrown directly (postgres.js, older
 *     Drizzle) or wrapped in a Drizzle query error with the original on
 *     `.cause` (newer Drizzle). Checking only the top-level object
 *     works on one and silently never matches on the other — the kind
 *     of bug that only shows up as "duplicate SKUs return 500 after a
 *     routine dependency bump". Unwrapping makes both shapes work.
 */

export interface PgErrorInfo {
  /** 5-character SQLSTATE, e.g. '23505' (unique_violation), '55P03' (lock_not_available). */
  code: string;
  constraint?: string;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

export function pgError(err: unknown): PgErrorInfo | null {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === 'object' && depth < 5; depth++) {
    const e = cur as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof e.code === 'string' && SQLSTATE.test(e.code)) {
      const constraint = typeof e.constraint_name === 'string' ? e.constraint_name
        : typeof e.constraint === 'string' ? e.constraint : undefined;
      return { code: e.code, constraint };
    }
    cur = e.cause;
  }
  return null;
}

export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  const info = pgError(err);
  if (!info || info.code !== '23505') return false;
  return constraintName ? info.constraint === constraintName : true;
}
