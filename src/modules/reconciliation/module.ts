/**
 * Stock reconciliation (PRD §19, §56.4).
 *
 * A count never edits stock directly. It records (system quantity at count time,
 * physical quantity, variance) permanently, and any variance becomes an
 * adjustment that flows through the SAME approval policy as manual adjustments.
 * The original system quantity is preserved on the count row even after the
 * adjustment lands, so "what did we think we had" is never lost.
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, asc, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import {
  items, categories, reconciliationCounts, reconciliationSchedules, reconciliationSessions, stockLevels, orgSettings, users,
} from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { requireIdempotencyKey } from '../../lib/idempotency-header.js';
import { claimUnique } from '../../lib/claim.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../../lib/notify.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { IdParams, PageQuery, Uuid, iso } from '../../lib/schemas.js';
import { assertLocationAccess, resolveLocationId, type Principal } from '../../lib/locations.js';
import { checkSnapshot, getActiveItem, getStock } from '../../lib/ledger.js';
import { withTxRetry } from '../../lib/retry.js';
import { decide, queueApproval } from '../approvals/engine.js';
import { doAdjustment } from '../transactions/lifecycle.js';

const Scope = Type.Union([Type.Literal('item'), Type.Literal('category'), Type.Literal('shelf'), Type.Literal('location')]);
const StartBody = Type.Object({ scope: Scope, scopeId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), dueAt: Type.Optional(Type.String({ format: 'date-time' })) }, { additionalProperties: false });
const CountBody = Type.Object({
  itemId: Uuid, physicalQuantity: Type.Integer({ minimum: 0, maximum: 100_000_000 }),
  reason: Type.Optional(Type.String({ maxLength: 500 })), note: Type.Optional(Type.String({ maxLength: 2000 })), snapshotFileId: Type.Optional(Uuid),
}, { additionalProperties: false });
const ScheduleBody = Type.Object({ scope: Scope, scopeId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), intervalDays: Type.Integer({ minimum: 1, maximum: 366 }), firstDueAt: Type.String({ format: 'date-time' }) }, { additionalProperties: false });
const SchedulePatch = Type.Partial(Type.Object({ intervalDays: Type.Integer({ minimum: 1, maximum: 366 }), nextDueAt: Type.String({ format: 'date-time' }), active: Type.Boolean() }), { additionalProperties: false });

function validateScope(scope: string, scopeId?: string) {
  if ((scope === 'item' || scope === 'category' || scope === 'shelf') && !scopeId) throw new ValidationError(`scopeId is required when scope is ${scope}`);
  if (scope === 'location' && scopeId) throw new ValidationError('scopeId must be omitted when scope is location');
}

const serSession = (s: typeof reconciliationSessions.$inferSelect) => ({
  id: s.id, locationId: s.locationId, scope: s.scope, scopeId: s.scopeId, scheduleId: s.scheduleId, status: s.status,
  startedBy: s.startedBy, startedAt: s.startedAt.toISOString(), dueAt: iso(s.dueAt), closedAt: iso(s.closedAt),
});
const serCount = (c: typeof reconciliationCounts.$inferSelect) => ({
  id: c.id, sessionId: c.sessionId, itemId: c.itemId, systemQuantityAtCount: c.systemQuantityAtCount, physicalQuantity: c.physicalQuantity, variance: c.variance,
  reason: c.reason, note: c.note, countedBy: c.countedBy, linkedAdjustmentTransactionId: c.linkedAdjustmentTransactionId,
  linkedApprovalRequestId: c.linkedApprovalRequestId, createdAt: c.createdAt.toISOString(),
});

async function startSession(db: Db, actor: Principal, b: typeof StartBody.static) {
  validateScope(b.scope, b.scopeId);
  return db.transaction(async (tx) => {
    const locationId = await resolveLocationId(tx, actor, b.locationId);
    const [s] = await tx.insert(reconciliationSessions).values({
      orgId: actor.orgId, locationId, scope: b.scope, scopeId: b.scopeId, startedBy: actor.id, dueAt: b.dueAt ? new Date(b.dueAt) : null,
    }).returning();
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'reconciliation.started', entityType: 'reconciliation_session', entityId: s.id, next: serSession(s) });
    return s;
  });
}

async function submitCount(db: Db, actor: Principal, sessionId: string, b: typeof CountBody.static, key: string) {
  return withTxRetry(() => db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [session] = await tx.select().from(reconciliationSessions).where(and(eq(reconciliationSessions.id, sessionId), eq(reconciliationSessions.orgId, actor.orgId))).limit(1);
    if (!session) throw new NotFoundError('Reconciliation session');
    if (session.status !== 'open') throw new ConflictError('SESSION_CLOSED', 'This reconciliation session is closed');
    await assertLocationAccess(tx, actor, session.locationId);

    const [dup] = await tx.select().from(reconciliationCounts).where(and(eq(reconciliationCounts.sessionId, sessionId), eq(reconciliationCounts.idempotencyKey, key))).limit(1);
    if (dup) return { count: dup, replayed: true, adjustment: 'existing' as const };

    const item = await getActiveItem(tx, actor.orgId, b.itemId);
    if (item.type !== 'consumable') throw new ValidationError('Stock counts apply to consumables; report missing or damaged assets with a loss/damage report');
    const inScope = session.scope === 'location' || (session.scope === 'item' && item.id === session.scopeId) || (session.scope === 'category' && item.categoryId === session.scopeId) ||
      (session.scope === 'shelf' && (await tx.select({ id: categories.id }).from(categories).where(and(eq(categories.id, item.categoryId), eq(categories.shelfId, session.scopeId!))).limit(1)).length > 0);
    if (!inScope) throw new ValidationError('This item is outside the scope of the reconciliation session');
    await checkSnapshot(tx, actor.orgId, 'reconciliation_adjustment', b.snapshotFileId);

    const system = await getStock(tx, { orgId: actor.orgId, itemId: item.id, locationId: session.locationId });
    const variance = b.physicalQuantity - system;
    if (variance !== 0) {
      const [st] = await tx.select({ req: orgSettings.requireReconciliationReason }).from(orgSettings).where(eq(orgSettings.orgId, actor.orgId)).limit(1);
      if (st?.req && !b.reason?.trim()) throw new ValidationError('A reason is required to record a variance');
    }
    // Claim-first, same pattern as the ledger: a concurrent duplicate of this count blocks, then replays.
    const claim = await claimUnique(tx, 'recon_counts_session_idempotency_unique', (sp) => sp.insert(reconciliationCounts).values({
      sessionId, itemId: item.id, systemQuantityAtCount: system, physicalQuantity: b.physicalQuantity, variance, reason: b.reason, note: b.note,
      snapshotFileId: b.snapshotFileId, countedBy: actor.id, idempotencyKey: key,
    }).returning());
    if (!claim.claimed) {
      const [w] = await tx.select().from(reconciliationCounts).where(and(eq(reconciliationCounts.sessionId, sessionId), eq(reconciliationCounts.idempotencyKey, key))).limit(1);
      return { count: w, replayed: true, adjustment: 'existing' as const };
    }
    let count = claim.value[0];
    if (variance === 0) return { count, replayed: false, adjustment: 'none' as const };

    await notify(tx, {
      orgId: actor.orgId, type: 'reconciliation_discrepancy', entityType: 'reconciliation_count', entityId: count.id, dedupeKey: `recon_count:${count.id}`,
      title: `Stock variance: ${item.name}`, body: `${item.name} (${item.sku}): system ${system}, counted ${b.physicalQuantity} (${variance > 0 ? '+' : ''}${variance}).`,
      data: { itemId: item.id, sessionId, variance },
    });
    const payload = {
      itemId: item.id, delta: variance, reason: 'count_correction' as const, locationId: session.locationId, snapshotFileId: b.snapshotFileId,
      note: `Reconciliation ${sessionId}${b.reason ? `: ${b.reason}` : ''}`, reconciliationCountId: count.id,
    };
    const d = await decide(tx, actor, 'adjustment', Math.abs(variance));
    if (d.queue) {
      const ar = await queueApproval(tx, actor, 'adjustment', d.mode, payload, item.id, `recon:${count.id}`);
      [count] = await tx.update(reconciliationCounts).set({ linkedApprovalRequestId: ar.id }).where(eq(reconciliationCounts.id, count.id)).returning();
      return { count, replayed: false, adjustment: 'pending_approval' as const, approvalRequestId: ar.id };
    }
    const r = await doAdjustment(tx, { actor, source: 'online' }, { ...payload, idempotencyKey: `recon:${count.id}` });
    [count] = await tx.update(reconciliationCounts).set({ linkedAdjustmentTransactionId: r.transaction.id, resolvedBy: actor.id }).where(eq(reconciliationCounts.id, count.id)).returning();
    return { count, replayed: false, adjustment: 'applied' as const };
  }));
}

async function sessionDetail(db: Db, actor: Principal, id: string) {
  const [s] = await db.select().from(reconciliationSessions).where(and(eq(reconciliationSessions.id, id), eq(reconciliationSessions.orgId, actor.orgId))).limit(1);
  if (!s) throw new NotFoundError('Reconciliation session');
  await assertLocationAccess(db, actor, s.locationId);
  const counts = await db.select({ c: reconciliationCounts, name: items.name, sku: items.sku }).from(reconciliationCounts)
    .innerJoin(items, eq(reconciliationCounts.itemId, items.id)).where(eq(reconciliationCounts.sessionId, id)).orderBy(asc(reconciliationCounts.createdAt)).limit(2000);
  const scopeCond = s.scope === 'item' ? eq(items.id, s.scopeId!) : s.scope === 'category' ? eq(items.categoryId, s.scopeId!) : s.scope === 'shelf' ? sql`${items.categoryId} in (select c.id from categories c where c.shelf_id = ${s.scopeId}::uuid)` : sql`exists (select 1 from ${stockLevels} sl where sl.item_id = ${items.id} and sl.location_id = ${s.locationId})`;
  const [unc] = await db.select({ n: sql<number>`count(*)::int` }).from(items).where(and(
    eq(items.orgId, actor.orgId), eq(items.type, 'consumable'), isNull(items.archivedAt), scopeCond,
    sql`not exists (select 1 from ${reconciliationCounts} rc where rc.session_id = ${id} and rc.item_id = ${items.id})`));
  const withVariance = counts.filter((x) => x.c.variance !== 0);
  return {
    ...serSession(s), counts: counts.map((x) => ({ ...serCount(x.c), itemName: x.name, sku: x.sku })),
    summary: { counted: counts.length, withVariance: withVariance.length, netVariance: withVariance.reduce((n, x) => n + x.c.variance, 0), uncounted: unc.n,
      pendingApproval: counts.filter((x) => x.c.linkedApprovalRequestId && !x.c.linkedAdjustmentTransactionId).length },
  };
}

async function closeSession(db: Db, actor: Principal, id: string) {
  await db.transaction(async (tx) => {
    const [s] = await tx.select().from(reconciliationSessions).where(and(eq(reconciliationSessions.id, id), eq(reconciliationSessions.orgId, actor.orgId))).for('update').limit(1);
    if (!s) throw new NotFoundError('Reconciliation session');
    if (s.status === 'closed') return;
    await assertLocationAccess(tx, actor, s.locationId);
    await tx.update(reconciliationSessions).set({ status: 'closed', closedAt: new Date() }).where(eq(reconciliationSessions.id, id));
    if (s.scheduleId) {
      // Advance the schedule from its previous due date (not from "now") so cadence doesn't drift.
      await tx.update(reconciliationSchedules).set({
        nextDueAt: sql`greatest(${reconciliationSchedules.nextDueAt} + (${reconciliationSchedules.intervalDays} * interval '1 day'), now())`,
      }).where(eq(reconciliationSchedules.id, s.scheduleId));
    }
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'reconciliation.closed', entityType: 'reconciliation_session', entityId: id });
  });
}

/** Worker job: open a session (and tell supervisors) for every schedule that has come due. */
export async function runScheduleScan(db: Db): Promise<number> {
  const due = await db.select().from(reconciliationSchedules).where(and(eq(reconciliationSchedules.active, true), lte(reconciliationSchedules.nextDueAt, new Date()))).limit(200);
  let opened = 0;
  for (const sch of due) {
    await db.transaction(async (tx) => {
      const [open] = await tx.select({ id: reconciliationSessions.id }).from(reconciliationSessions)
        .where(and(eq(reconciliationSessions.scheduleId, sch.id), eq(reconciliationSessions.status, 'open'))).limit(1);
      if (open) return; // previous cycle still open: don't stack sessions
      const [s] = await tx.insert(reconciliationSessions).values({ orgId: sch.orgId, locationId: sch.locationId, scope: sch.scope, scopeId: sch.scopeId, scheduleId: sch.id, startedBy: sch.createdBy, dueAt: sch.nextDueAt }).returning();
      await notify(tx, { orgId: sch.orgId, type: 'reconciliation_due', entityType: 'reconciliation_session', entityId: s.id, dedupeKey: `recon_due:${sch.id}:${sch.nextDueAt.toISOString()}`,
        title: 'Stock count due', body: `A scheduled ${sch.scope} stock count is due.`, data: { sessionId: s.id } });
      opened++;
    });
  }
  return opened;
}

export async function reconciliationRoutes(app: FastifyInstance) {
  const SUP = requireRole('admin', 'supervisor');
  const COUNTERS = requireRole('admin', 'supervisor', 'store_staff');

  app.post('/', { preHandler: [app.authenticate, COUNTERS], schema: { body: StartBody } }, async (req, reply) => { reply.code(201); return serSession(await startSession(req.server.db, req.user!, req.body)); });

  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({ ...PageQuery, status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('closed')])) }) } }, async (req) => {
    const q = req.query; const limit = q.limit ?? 25;
    const rows = await req.server.db.select().from(reconciliationSessions).where(and(
      eq(reconciliationSessions.orgId, req.user!.orgId), q.status ? eq(reconciliationSessions.status, q.status) : undefined,
      q.cursor ? keysetWhere(reconciliationSessions.startedAt, reconciliationSessions.id, q.cursor) : undefined,
    )).orderBy(desc(reconciliationSessions.startedAt), desc(reconciliationSessions.id)).limit(limit + 1);
    const p = toPage(rows.map((r) => ({ ...r, createdAt: r.startedAt })), limit);
    return { items: p.items.map(serSession), nextCursor: p.nextCursor };
  });

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => sessionDetail(req.server.db, req.user!, req.params.id));

  app.post('/:id/counts', { preHandler: [app.authenticate, COUNTERS], schema: { params: IdParams, body: CountBody } }, async (req, reply) => {
    const r = await submitCount(req.server.db, req.user!, req.params.id, req.body, requireIdempotencyKey(req.headers));
    reply.code(r.replayed ? 200 : 201);
    return { count: serCount(r.count), replayed: r.replayed, adjustment: r.adjustment, approvalRequestId: 'approvalRequestId' in r ? r.approvalRequestId : undefined };
  });

  app.post('/:id/close', { preHandler: [app.authenticate, SUP], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => { await closeSession(req.server.db, req.user!, req.params.id); reply.code(204); });

  // ── Schedules ──
  app.post('/schedules', { preHandler: [app.authenticate, SUP], schema: { body: ScheduleBody } }, async (req, reply) => {
    validateScope(req.body.scope, req.body.scopeId);
    const a = req.user!;
    const row = await req.server.db.transaction(async (tx) => {
      const locationId = await resolveLocationId(tx, a, req.body.locationId);
      const [r] = await tx.insert(reconciliationSchedules).values({ orgId: a.orgId, locationId, scope: req.body.scope, scopeId: req.body.scopeId, intervalDays: req.body.intervalDays, nextDueAt: new Date(req.body.firstDueAt), createdBy: a.id }).returning();
      await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: 'reconciliation_schedule.created', entityType: 'reconciliation_schedule', entityId: r.id, next: req.body });
      return r;
    });
    reply.code(201); return { ...row, nextDueAt: row.nextDueAt.toISOString(), createdAt: row.createdAt.toISOString() };
  });
  app.get('/schedules', { preHandler: [app.authenticate, SUP] }, async (req) => {
    const rows = await req.server.db.select().from(reconciliationSchedules).where(eq(reconciliationSchedules.orgId, req.user!.orgId)).orderBy(asc(reconciliationSchedules.nextDueAt)).limit(200);
    return { items: rows.map((r) => ({ ...r, nextDueAt: r.nextDueAt.toISOString(), createdAt: r.createdAt.toISOString() })) };
  });
  app.patch('/schedules/:id', { preHandler: [app.authenticate, SUP], schema: { params: IdParams, body: SchedulePatch } }, async (req) => {
    const { nextDueAt, ...rest } = req.body;
    const [r] = await req.server.db.update(reconciliationSchedules).set({ ...rest, ...(nextDueAt ? { nextDueAt: new Date(nextDueAt) } : {}) })
      .where(and(eq(reconciliationSchedules.id, req.params.id), eq(reconciliationSchedules.orgId, req.user!.orgId))).returning();
    if (!r) throw new NotFoundError('Schedule');
    return { ...r, nextDueAt: r.nextDueAt.toISOString(), createdAt: r.createdAt.toISOString() };
  });
}
void users;
