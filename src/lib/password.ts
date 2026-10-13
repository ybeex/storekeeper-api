/**
 * argon2id — the current OWASP recommendation for new systems, and
 * deliberately memory-hard (unlike bcrypt) to stay expensive against
 * GPU/ASIC cracking attempts even as hardware improves. Parameters
 * below follow OWASP's 2024 minimums; re-check that guidance
 * periodically rather than treating these as permanent.
 */
import argon2 from 'argon2';

const HASH_OPTS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, HASH_OPTS);
}

export function verifyPassword(hash: string, plain: string): Promise<boolean> {
  return argon2.verify(hash, plain).catch(() => false);
}

// ── Password policy (NIST 800-63B style: length over composition rules) ──
const COMMON = new Set([
  'password1234', 'passw0rd1234', 'qwertyuiop12', '123456789012', 'letmein12345', 'welcome12345',
  'administrator', 'storekeeper1', 'iloveyou1234', 'changeme1234',
]);

export function passwordProblems(plain: string, email?: string): string[] {
  const problems: string[] = [];
  if (plain.length < 12) problems.push('must be at least 12 characters');
  if (plain.length > 128) problems.push('must be at most 128 characters');
  if (COMMON.has(plain.toLowerCase())) problems.push('is too common');
  if (/^(.)\1+$/.test(plain)) problems.push('must not be a single repeated character');
  const local = email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && plain.toLowerCase().includes(local)) problems.push('must not contain your email name');
  return problems;
}
