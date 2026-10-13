/** Retry a whole DB transaction on deadlock (40P01) / serialization failure (40001). Everything inside must be re-runnable — ours is (claim-first + idempotency). */
import { pgError } from './db-errors.js';

export async function withTxRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (err) {
      const code = pgError(err)?.code;
      if ((code === '40P01' || code === '40001') && i < attempts) {
        await new Promise((r) => setTimeout(r, 15 * i + Math.random() * 25)); // jittered backoff
        continue;
      }
      throw err;
    }
  }
}
