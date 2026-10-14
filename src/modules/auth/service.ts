import { and, eq, desc, gt, inArray, isNull, sql, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import {
  organizations, orgSettings, locations, users, sessions, userTokens, approvalPolicies, people, userLocations,
} from '../../db/schema.js';
import { env } from '../../env.js';
import { hashPassword, verifyPassword, passwordProblems } from '../../lib/password.js';
import { newSessionToken, hashToken } from '../../lib/tokens.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '../../lib/errors.js';
import { assertNotInAnotherOrg } from '../../lib/single-org.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { audit } from '../../lib/audit.js';
import { queueEmail } from '../../lib/notify.js';
import { authFailures } from '../../lib/metrics.js';
import { randomBytes, randomUUID } from 'node:crypto';

// Verified against when the account doesn't exist, so "no such user" and "wrong password"
// cost the same CPU time and can't be told apart by response latency.
let dummyHash: Promise<string> | null = null;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password-for-timing-only'));

function slugify(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
  return base;
}

export interface SessionInfo { ip?: string; userAgent?: string }
export interface IssuedSession { token: string; expiresAt: Date; evictedTokenHashes: string[] }

/** Creates a session and trims the user to MAX_SESSIONS_PER_USER (oldest evicted). */
export async function issueSession(tx: Db, userId: string, info: SessionInfo = {}): Promise<IssuedSession> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_SECONDS * 1000);
  const [row] = await tx.insert(sessions).values({
    userId, tokenHash: hashToken(token), expiresAt, ip: info.ip?.slice(0, 64), userAgent: info.userAgent?.slice(0, 300),
  }).returning({ id: sessions.id });
  const keep = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt)).limit(env.MAX_SESSIONS_PER_USER);
  const keepIds = keep.map((k) => k.id);
  if (!keepIds.includes(row.id)) keepIds.push(row.id);
  const evicted = await tx.delete(sessions).where(and(eq(sessions.userId, userId), notInArray(sessions.id, keepIds)))
    .returning({ h: sessions.tokenHash });
  return { token, expiresAt, evictedTokenHashes: evicted.map((e) => e.h) };
}

const DEFAULT_POLICIES: Array<{ operation: typeof approvalPolicies.$inferInsert['operation']; mode: 'direct' | 'request' | 'approval' }> = [
  { operation: 'adjustment', mode: 'request' },
  { operation: 'loss', mode: 'request' },
  { operation: 'damage', mode: 'direct' },
  { operation: 'retirement', mode: 'approval' },
  { operation: 'manual_correction', mode: 'request' },
  { operation: 'checkout', mode: 'direct' }, // PRD §32: routine ops are never gated unless the org opts in
  { operation: 'checkin', mode: 'direct' },
];

export async function registerOrganization(db: Db, input: { organizationName: string; fullName?: string; email: string; password: string; firstLocationName?: string }, info: SessionInfo) {
  const email = input.email.trim().toLowerCase();
  const problems = passwordProblems(input.password, email);
  if (problems.length) throw new ValidationError(`Password ${problems.join(', ')}`);
  const passwordHash = await hashPassword(input.password);

  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? slugify(input.organizationName) : `${slugify(input.organizationName)}-${randomBytes(2).toString('hex')}`;
    try {
      return await db.transaction(async (tx) => {
        const [org] = await tx.insert(organizations).values({ name: input.organizationName.trim(), slug }).returning();
        await tx.insert(orgSettings).values({ orgId: org.id });
        await tx.insert(approvalPolicies).values(DEFAULT_POLICIES.map((p) => ({ orgId: org.id, ...p })));
        const [loc] = await tx.insert(locations).values({ orgId: org.id, name: input.firstLocationName?.trim() || 'Main Store', kind: 'store' }).returning();
        const [user] = await tx.insert(users).values({ orgId: org.id, email, fullName: input.fullName?.trim(), passwordHash, role: 'admin' }).returning();
        await tx.insert(people).values({ orgId: org.id, fullName: input.fullName?.trim() || email.split('@')[0], email, userId: user.id });
        const session = await issueSession(tx, user.id, info);
        await audit(tx, { orgId: org.id, actorUserId: user.id, action: 'organization.registered', entityType: 'organization', entityId: org.id });
        return { org, user, location: loc, session };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'organizations_slug_unique')) continue;
      throw err;
    }
  }
  throw new ConflictError('SLUG_TAKEN', 'Could not allocate a unique organization identifier; try a different name');
}

export async function login(db: Db, input: { organization: string; email: string; password: string }, info: SessionInfo) {
  const email = input.email.trim().toLowerCase();
  const [row] = await db.select({
    id: users.id, orgId: users.orgId, role: users.role, active: users.active, hash: users.passwordHash,
    lockedUntil: users.lockedUntil,
  }).from(users).innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(and(eq(organizations.slug, input.organization.trim().toLowerCase()), eq(users.email, email))).limit(1);

  const deny = (reason: string): never => { authFailures.inc({ reason }); throw new UnauthorizedError('Invalid credentials'); };

  if (!row) { await verifyPassword(await getDummyHash(), input.password); return deny('unknown_user'); }
  const locked = row.lockedUntil && row.lockedUntil > new Date();
  const ok = await verifyPassword(row.hash, input.password); // always verify, even if locked: uniform timing
  if (locked) return deny('locked');
  if (!ok) {
    // Atomic increment; lock when the threshold is reached.
    await db.update(users).set({
      failedLoginCount: sql`${users.failedLoginCount} + 1`,
      lockedUntil: sql`case when ${users.failedLoginCount} + 1 >= ${env.LOGIN_MAX_FAILED_ATTEMPTS}
        then now() + (${env.LOGIN_LOCK_MINUTES} * interval '1 minute') else ${users.lockedUntil} end`,
    }).where(eq(users.id, row.id));
    await audit(db, { orgId: row.orgId, actorUserId: row.id, action: 'auth.login_failed', entityType: 'user', entityId: row.id, metadata: { ip: info.ip } });
    return deny('bad_password');
  }
  if (!row.active) return deny('inactive');

  return db.transaction(async (tx) => {
    await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, row.id));
    const session = await issueSession(tx, row.id, info);
    await audit(tx, { orgId: row.orgId, actorUserId: row.id, action: 'auth.login', entityType: 'user', entityId: row.id, metadata: { ip: info.ip } });
    return { userId: row.id, orgId: row.orgId, role: row.role, session };
  });
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

export async function changePassword(db: Db, userId: string, current: string, next: string): Promise<{ session: IssuedSession; revokedHashes: string[] }> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !(await verifyPassword(u.passwordHash, current))) { authFailures.inc({ reason: 'change_password' }); throw new UnauthorizedError('Current password is incorrect'); }
  const problems = passwordProblems(next, u.email);
  if (problems.length) throw new ValidationError(`Password ${problems.join(', ')}`);
  const hash = await hashPassword(next);
  return db.transaction(async (tx) => {
    // An admin who runs several organisations has one password for all of them: change it everywhere, sign out everywhere.
    const group = await accountGroup(tx, u);
    await tx.update(users).set({ passwordHash: hash, passwordChangedAt: new Date(), updatedAt: new Date() }).where(inArray(users.id, group));
    const old = await tx.delete(sessions).where(inArray(sessions.userId, group)).returning({ h: sessions.tokenHash });
    const session = await issueSession(tx, userId);
    await audit(tx, { orgId: u.orgId, actorUserId: userId, action: 'auth.password_changed', entityType: 'user', entityId: userId });
    return { session, revokedHashes: old.map((o) => o.h) };
  });
}

/** Always succeeds from the caller's perspective (no account enumeration). */
export async function requestPasswordReset(db: Db, input: { organization: string; email: string }): Promise<void> {
  const email = input.email.trim().toLowerCase();
  const [u] = await db.select({ id: users.id, orgId: users.orgId, active: users.active }).from(users)
    .innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(and(eq(organizations.slug, input.organization.trim().toLowerCase()), eq(users.email, email))).limit(1);
  if (!u || !u.active) return;
  const token = newSessionToken();
  await db.transaction(async (tx) => {
    // One live reset token per user: invalidate earlier ones.
    await tx.update(userTokens).set({ usedAt: new Date() }).where(and(eq(userTokens.userId, u.id), eq(userTokens.purpose, 'password_reset'), isNull(userTokens.usedAt)));
    await tx.insert(userTokens).values({
      orgId: u.orgId, purpose: 'password_reset', email, userId: u.id, tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + env.PASSWORD_RESET_TTL_MINUTES * 60_000),
    });
    await queueEmail(tx, {
      orgId: u.orgId, to: email, subject: 'Reset your StoreKeeper password',
      text: `Use this link to choose a new password (valid ${env.PASSWORD_RESET_TTL_MINUTES} minutes):\n${env.APP_BASE_URL}/reset-password?token=${token}\n\nIf you didn't request this, ignore this email.`,
    });
  });
}

/** Atomically consumes a single-use token; returns the row or throws. */
async function consumeToken(tx: Db, token: string, purpose: 'invite' | 'password_reset') {
  const [row] = await tx.update(userTokens).set({ usedAt: new Date() }).where(and(
    eq(userTokens.tokenHash, hashToken(token)), eq(userTokens.purpose, purpose),
    isNull(userTokens.usedAt), gt(userTokens.expiresAt, new Date()),
  )).returning();
  if (!row) throw new AppError(400, 'TOKEN_INVALID', 'This link is invalid or has expired');
  return row;
}

export async function resetPassword(db: Db, token: string, password: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const t = await consumeToken(tx, token, 'password_reset');
    const problems = passwordProblems(password, t.email);
    if (problems.length) throw new ValidationError(`Password ${problems.join(', ')}`);
    const hash = await hashPassword(password);
    const [target] = await tx.select().from(users).where(eq(users.id, t.userId!)).limit(1);
    const group = target ? await accountGroup(tx, target) : [t.userId!];
    await tx.update(users).set({ passwordHash: hash, passwordChangedAt: new Date(), failedLoginCount: 0, lockedUntil: null, updatedAt: new Date() }).where(inArray(users.id, group));
    const old = await tx.delete(sessions).where(inArray(sessions.userId, group)).returning({ h: sessions.tokenHash });
    await audit(tx, { orgId: t.orgId, actorUserId: t.userId, action: 'auth.password_reset', entityType: 'user', entityId: t.userId! });
    return old.map((o) => o.h);
  });
}

export async function acceptInvite(db: Db, token: string, password: string, info: SessionInfo) {
  const hash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const t = await consumeToken(tx, token, 'invite');
    const problems = passwordProblems(password, t.email);
    if (problems.length) throw new ValidationError(`Password ${problems.join(', ')}`);
    await assertNotInAnotherOrg(tx, t.orgId, t.email); // they may have joined elsewhere since the invite was sent
    let user;
    try {
      [user] = await tx.insert(users).values({ orgId: t.orgId, email: t.email, fullName: t.fullName, passwordHash: hash, role: t.role ?? 'store_staff' }).returning();
    } catch (err) {
      if (isUniqueViolation(err, 'users_org_email_unique')) throw new ConflictError('EMAIL_TAKEN', 'An account with this email already exists');
      throw err;
    }
    if (t.personId) await tx.update(people).set({ userId: user.id }).where(and(eq(people.id, t.personId), eq(people.orgId, t.orgId), isNull(people.userId)));
    else await tx.insert(people).values({ orgId: t.orgId, fullName: t.fullName || t.email.split('@')[0], email: t.email, userId: user.id });
    if (t.locationIds?.length) await tx.insert(userLocations).values(t.locationIds.map((locationId) => ({ userId: user.id, locationId }))).onConflictDoNothing();
    const session = await issueSession(tx, user.id, info);
    await audit(tx, { orgId: t.orgId, actorUserId: user.id, action: 'user.invite_accepted', entityType: 'user', entityId: user.id, next: { role: user.role } });
    return { user, session };
  });
}


/** Every user row that shares this person's login: just themselves unless they run several organisations. */
async function accountGroup(tx: Db, u: { id: string; accountId: string | null }): Promise<string[]> {
  if (!u.accountId) return [u.id];
  const rows = await tx.select({ id: users.id }).from(users).where(eq(users.accountId, u.accountId));
  return rows.map((r) => r.id);
}

const MAX_ORGS_PER_ACCOUNT = 20;

/**
 * An admin starts another organisation under the same login. It gets its own users row (admin, same email and password
 * hash) so every foreign key that points at users keeps meaning "this person, in this organisation", and the two rows
 * are tied together by account_id. Only an authenticated admin can do this; nothing links rows by email.
 */
export async function createOrganizationForAdmin(db: Db, actorUserId: string, input: { organizationName: string; firstLocationName?: string }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const slug = attempt === 0 ? slugify(input.organizationName) : `${slugify(input.organizationName)}-${randomBytes(2).toString('hex')}`;
    try {
      return await db.transaction(async (tx0) => {
        const tx = tx0 as unknown as Db;
        const [me] = await tx.select().from(users).where(eq(users.id, actorUserId)).for('update').limit(1); // serialises two quick creations
        if (!me || !me.active || me.role !== 'admin') throw new ForbiddenError('Only an administrator can create an organisation');
        const accountId = me.accountId ?? randomUUID();
        if (me.accountId) {
          const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.accountId, me.accountId));
          if (n >= MAX_ORGS_PER_ACCOUNT) throw new ValidationError(`An account can run up to ${MAX_ORGS_PER_ACCOUNT} organisations`);
        } else {
          await tx.update(users).set({ accountId }).where(eq(users.id, me.id));
        }
        const [org] = await tx.insert(organizations).values({ name: input.organizationName.trim(), slug }).returning();
        await tx.insert(orgSettings).values({ orgId: org.id });
        await tx.insert(approvalPolicies).values(DEFAULT_POLICIES.map((p) => ({ orgId: org.id, ...p })));
        const [loc] = await tx.insert(locations).values({ orgId: org.id, name: input.firstLocationName?.trim() || 'Main Store', kind: 'store' }).returning();
        const [user] = await tx.insert(users).values({ orgId: org.id, email: me.email, fullName: me.fullName, passwordHash: me.passwordHash, role: 'admin', accountId }).returning();
        await tx.insert(people).values({ orgId: org.id, fullName: me.fullName?.trim() || me.email.split('@')[0], email: me.email, userId: user.id });
        await audit(tx, { orgId: org.id, actorUserId: user.id, action: 'organization.created_by_admin', entityType: 'organization', entityId: org.id, next: { fromOrgId: me.orgId } });
        return { org, user, location: loc };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'organizations_slug_unique')) continue;
      throw err;
    }
  }
  throw new ConflictError('SLUG_TAKEN', 'Could not allocate a unique organization identifier; try a different name');
}

/** Moves an admin into another of their organisations: a fresh session for that organisation's row. */
export async function switchOrganization(db: Db, actorUserId: string, orgId: string, info: SessionInfo) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [me] = await tx.select().from(users).where(eq(users.id, actorUserId)).limit(1);
    if (!me || !me.active || me.role !== 'admin') throw new ForbiddenError('Only an administrator can switch organisations');
    const [target] = me.accountId
      ? await tx.select().from(users).where(and(eq(users.accountId, me.accountId), eq(users.orgId, orgId), eq(users.role, 'admin'), eq(users.active, true))).limit(1)
      : [me.orgId === orgId ? me : undefined];
    if (!target) throw new NotFoundError('Organization'); // someone else's organisation looks exactly like one that does not exist
    const session = await issueSession(tx, target.id, info);
    await audit(tx, { orgId: target.orgId, actorUserId: target.id, action: 'auth.org_switched', entityType: 'user', entityId: target.id, next: { fromOrgId: me.orgId } });
    return { session, user: target, previousUserId: me.id };
  });
}
