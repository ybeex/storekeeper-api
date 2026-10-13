import { randomBytes, createHash } from 'node:crypto';

/** 256 bits of CSPRNG output, URL-safe. This is the bearer token the client holds. */
export function newSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Only this hash is ever persisted (Postgres `sessions.token_hash`,
 * Redis cache keys). SHA-256 without a salt or a slow KDF is correct
 * *here* — unlike a password, the input is 256 bits of randomness, so
 * there's nothing to brute-force or precompute a dictionary for; the
 * hash exists purely so a leaked database/cache dump can't be replayed
 * as credentials.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
