import { and, desc, eq, ilike, inArray, isNull, gt, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { users, userTokens, userLocations, locations, people } from '../../db/schema.js';
import { env } from '../../env.js';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { audit } from '../../lib/audit.js';
import { assertNotInAnotherOrg } from '../../lib/single-org.js';
import { newSessionToken, hashToken } from '../../lib/tokens.js';
import { queueEmail } from '../../lib/notify.js';
import { allowedLocationIds, type Principal } from '../../lib/locations.js';

const publicCols = {
  id: users.id, email: users.email, fullName: users.fullName, role: users.role, active: users.active, createdAt: users.createdAt, lockedUntil: users.lockedUntil,
};

export async function listUsers(db: Db, orgId: string, q: { cursor?: string; limit?: number; role?: string; active?: boolean; q?: string }) {
  const limit = q.limit ?? 25;
  const rows = await db.select(publicCols).from(users).where(and(
    eq(users.orgId, orgId),
    q.role ? eq(users.role, q.role as never) : undefined,
    q.active !== undefined ? eq(users.active, q.active) : undefined,
    q.q ? ilike(users.email, `%${q.q.replace(/[%_\\]/g, '\\$&')}%`) : undefined,
    q.cursor ? keysetWhere(users.createdAt, users.id, q.cursor) : undefined,
  )).orderBy(desc(users.createdAt), desc(users.id)).limit(limit + 1);
  return toPage(rows, limit);
}

export async function getUser(db: Db, orgId: string, id: string) {
  const [u] = await db.select(publicCols).from(users).where(and(eq(users.id, id), eq(users.orgId, orgId))).limit(1);
  if (!u) throw new NotFoundError('User');
  const locs = await db.select({ id: userLocations.locationId }).from(userLocations).where(eq(userLocations.userId, id));
  return { ...u, locationIds: locs.map((l) => l.id) };
}

/** Role change / (de)activation. Callers must invalidate the user's cached sessions afterwards. */
export async function updateUser(db: Db, actor: Principal, id: string, patch: { role?: Principal['role']; active?: boolean }) {
  return db.transaction(async (tx) => {
    const [target] = await tx.select().from(users).where(and(eq(users.id, id), eq(users.orgId, actor.orgId))).for('update').limit(1);
    if (!target) throw new NotFoundError('User');
    if (id === actor.id) throw new ConflictError('SELF_MODIFICATION', 'You cannot change your own role or active state');

    const losesAdmin = target.role === 'admin' && target.active && ((patch.role && patch.role !== 'admin') || patch.active === false);
    if (losesAdmin) {
      // Lock all active admins so two concurrent demotions cannot both pass the check and leave zero admins.
      const admins = await tx.select({ id: users.id }).from(users)
        .where(and(eq(users.orgId, actor.orgId), eq(users.role, 'admin'), eq(users.active, true))).orderBy(users.id).for('update');
      if (admins.filter((a) => a.id !== id).length === 0) throw new ConflictError('LAST_ADMIN', 'The organization must keep at least one active admin');
    }
    const [updated] = await tx.update(users).set({ ...patch, updatedAt: new Date() }).where(eq(users.id, id)).returning(publicCols);
    await audit(tx, {
      orgId: actor.orgId, actorUserId: actor.id, action: patch.active === false ? 'user.deactivated' : 'user.updated',
      entityType: 'user', entityId: id, previous: { role: target.role, active: target.active }, next: { role: updated.role, active: updated.active },
    });
    return updated;
  });
}

export async function setUserLocations(db: Db, actor: Principal, userId: string, locationIds: string[]) {
  return db.transaction(async (tx) => {
    const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.orgId, actor.orgId))).limit(1);
    if (!u) throw new NotFoundError('User');
    const unique = [...new Set(locationIds)];
    if (unique.length) {
      const found = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.orgId, actor.orgId), inArray(locations.id, unique), isNull(locations.archivedAt)));
      if (found.length !== unique.length) throw new ValidationError('One or more locations do not exist');
    }
    const before = await tx.select({ id: userLocations.locationId }).from(userLocations).where(eq(userLocations.userId, userId));
    await tx.delete(userLocations).where(eq(userLocations.userId, userId));
    if (unique.length) await tx.insert(userLocations).values(unique.map((locationId) => ({ userId, locationId })));
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'user.locations_set', entityType: 'user', entityId: userId, previous: before.map((b) => b.id), next: unique });
    return unique;
  });
}

// ── Invites (PRD AUTH-06) — role-based ──────────────────────────────
/** Who may invite whom. Admins: anyone. Supervisors: store staff and viewers only. Nobody else invites. */
const INVITABLE: Record<Principal['role'], Principal['role'][]> = {
  admin: ['admin', 'supervisor', 'store_staff', 'viewer'],
  supervisor: ['store_staff', 'viewer'],
  store_staff: [], viewer: [],
};

async function issueInvite(tx: Db, actor: Principal, inv: { email: string; role: Principal['role']; fullName?: string; personId?: string; locationIds?: string[] }, existingId?: string) {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + env.INVITE_TTL_HOURS * 3600_000);
  // Re-inviting / resending supersedes every earlier live invite for that address.
  await tx.update(userTokens).set({ usedAt: new Date() }).where(and(eq(userTokens.orgId, actor.orgId), eq(userTokens.purpose, 'invite'), eq(userTokens.email, inv.email), isNull(userTokens.usedAt)));
  const [row] = await tx.insert(userTokens).values({
    orgId: actor.orgId, purpose: 'invite', email: inv.email, role: inv.role, fullName: inv.fullName, personId: inv.personId, locationIds: inv.locationIds?.length ? inv.locationIds : null,
    tokenHash: hashToken(token), createdBy: actor.id, expiresAt,
  }).returning({ id: userTokens.id, email: userTokens.email, role: userTokens.role, expiresAt: userTokens.expiresAt });
  await queueEmail(tx, {
    orgId: actor.orgId, to: inv.email, subject: 'You have been invited to StoreKeeper',
    text: `${inv.fullName ? `Hi ${inv.fullName}, y` : 'Y'}ou've been invited as ${inv.role.replace('_', ' ')}.\nAccept: ${env.APP_BASE_URL}/accept-invite?token=${token}\nThis link expires ${expiresAt.toUTCString()}.`,
  });
  await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: existingId ? 'user.invite_resent' : 'user.invited', entityType: 'invite', entityId: row.id, next: { email: inv.email, role: inv.role, locationIds: inv.locationIds ?? [] } });
  return { ...row, ...(env.NODE_ENV !== 'production' ? { devToken: token } : {}) };
}

export async function createInvite(db: Db, actor: Principal, input: { email: string; role: Principal['role']; fullName?: string; personId?: string; locationIds?: string[] }) {
  if (!INVITABLE[actor.role].includes(input.role)) throw new ForbiddenError(`${actor.role === 'supervisor' ? 'Supervisors can only invite store staff and viewers' : 'You cannot invite users'}`);
  const email = input.email.trim().toLowerCase();
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [exists] = await tx.select({ id: users.id }).from(users).where(and(eq(users.orgId, actor.orgId), eq(users.email, email))).limit(1);
    if (exists) throw new ConflictError('EMAIL_TAKEN', 'A user with this email already exists');
    await assertNotInAnotherOrg(tx, actor.orgId, email);
    if (input.personId) {
      const [p] = await tx.select({ id: people.id, u: people.userId }).from(people).where(and(eq(people.id, input.personId), eq(people.orgId, actor.orgId))).limit(1);
      if (!p) throw new NotFoundError('Person');
      if (p.u) throw new ConflictError('PERSON_HAS_LOGIN', 'This person already has a login');
    }
    // A confined inviter can only hand out access they themselves have; an unconfined inviter may leave it open.
    const mine = await allowedLocationIds(tx, actor);
    let locationIds = input.locationIds;
    if (mine) {
      locationIds = locationIds?.length ? locationIds : mine;
      if (locationIds.some((l) => !mine.includes(l))) throw new ForbiddenError('You can only grant access to locations you have access to');
    }
    if (locationIds?.length) {
      const found = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.orgId, actor.orgId), inArray(locations.id, locationIds), isNull(locations.archivedAt)));
      if (found.length !== locationIds.length) throw new ValidationError('One or more locations do not exist');
    }
    return issueInvite(tx, actor, { ...input, email, locationIds });
  });
}

export async function resendInvite(db: Db, actor: Principal, id: string) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [old] = await tx.select().from(userTokens).where(and(eq(userTokens.id, id), eq(userTokens.orgId, actor.orgId), eq(userTokens.purpose, 'invite'), isNull(userTokens.usedAt))).for('update').limit(1);
    if (!old || !old.role) throw new NotFoundError('Invite');
    if (actor.role !== 'admin' && old.createdBy !== actor.id) throw new NotFoundError('Invite');
    if (!INVITABLE[actor.role].includes(old.role)) throw new ForbiddenError('You cannot resend this invite');
    return issueInvite(tx, actor, { email: old.email, role: old.role, fullName: old.fullName ?? undefined, personId: old.personId ?? undefined, locationIds: old.locationIds ?? undefined }, id);
  });
}

export async function listInvites(db: Db, actor: Principal) {
  return db.select({ id: userTokens.id, email: userTokens.email, role: userTokens.role, fullName: userTokens.fullName, expiresAt: userTokens.expiresAt, createdAt: userTokens.createdAt, createdBy: userTokens.createdBy })
    .from(userTokens).where(and(eq(userTokens.orgId, actor.orgId), eq(userTokens.purpose, 'invite'), isNull(userTokens.usedAt), gt(userTokens.expiresAt, new Date()),
      actor.role === 'admin' ? undefined : eq(userTokens.createdBy, actor.id))).orderBy(desc(userTokens.createdAt)).limit(200);
}

export async function revokeInvite(db: Db, actor: Principal, id: string) {
  const rows = await db.update(userTokens).set({ usedAt: new Date() }).where(and(
    eq(userTokens.id, id), eq(userTokens.orgId, actor.orgId), eq(userTokens.purpose, 'invite'), isNull(userTokens.usedAt),
    actor.role === 'admin' ? undefined : eq(userTokens.createdBy, actor.id))).returning({ id: userTokens.id });
  if (rows.length === 0) throw new NotFoundError('Invite');
  await audit(db, { orgId: actor.orgId, actorUserId: actor.id, action: 'user.invite_revoked', entityType: 'invite', entityId: id });
}

void sql;
