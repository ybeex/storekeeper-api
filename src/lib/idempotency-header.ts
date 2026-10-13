import { ValidationError } from './errors.js';

/**
 * Used by the routes that implement their own ledger-backed idempotency
 * (checkout, check-in, consume, restock — see
 * references/idempotency-and-concurrency.md) rather than the general
 * `config: { idempotent: true }` plugin. Same bounds as that plugin
 * (plugins/idempotency.ts) so the client-facing contract — "send an
 * 8-200 character Idempotency-Key on any mutating request" — is
 * identical regardless of which mechanism handles it underneath.
 */
export function requireIdempotencyKey(headers: Record<string, unknown>): string {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    throw new ValidationError('An Idempotency-Key header (8-200 characters) is required for this endpoint');
  }
  return key;
}
