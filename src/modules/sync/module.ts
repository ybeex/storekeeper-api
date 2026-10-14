import type { ApiFastifyInstance } from '../../types.js';
/**
 * Offline sync (PRD §21, §56.5). A device queues actions while offline and
 * replays them here. The SERVER is the source of truth:
 *
 *  - every action is executed by the same op function an online call would use,
 *    in its OWN database transaction, so one rejected action never blocks the rest;
 *  - idempotencyKey = sync:{deviceId}:{clientActionId}, so a replay after a dropped
 *    response (the normal case on flaky connections) is a no-op returning the original;
 *  - an action the current state cannot accept (asset already out, stock gone) becomes
 *    a CONFLICT record for a supervisor — never silently dropped, never silently forced;
 *  - the device clock is untrusted: occurredAt is clamped (lib/occurred-at.ts).
 *
 * Offline-eligible operations are the routine four. Adjustments, loss/damage,
 * reconciliation and retirement are online-only because approval policy (PRD §32)
 * must be evaluated against live state and a live approver.
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, custody, items, jobs, locations, people, shelves, stockLevels, syncConflicts, teams, users } from '../../db/schema.js';
import { asc, gte, inArray, isNull, sql } from 'drizzle-orm';
import { allowedLocationIds } from '../../lib/locations.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { resolveOccurredAt } from '../../lib/occurred-at.js';
import { notify } from '../../lib/notify.js';
import { audit } from '../../lib/audit.js';
import { withTxRetry } from '../../lib/retry.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { syncActions } from '../../lib/metrics.js';
import { HolderBody, IdParams, PageQuery, Uuid, iso } from '../../lib/schemas.js';
import { Condition } from '../items/schema.js';
import type { Principal } from '../../lib/locations.js';
import { doCheckin, doCheckout, doConsume, doRestock } from '../transactions/movement.js';
import type { OpContext, OpResult } from '../transactions/types.js';

const Qty = Type.Integer({ minimum: 1, maximum: 100_000_000 });
const Base = { clientActionId: Type.String({ minLength: 8, maxLength: 100 }), occurredAt: Type.String({ format: 'date-time' }), note: Type.Optional(Type.String({ maxLength: 2000 })) };
const Action = Type.Union([
  Type.Object({ ...Base, type: Type.Literal('checkout'), itemId: Uuid, holder: HolderBody, quantity: Type.Optional(Qty), jobId: Type.Optional(Uuid), purpose: Type.Optional(Type.String({ maxLength: 500 })), locationId: Type.Optional(Uuid), condition: Type.Optional(Condition) }, { additionalProperties: false }),
  Type.Object({ ...Base, type: Type.Literal('checkin'), itemId: Uuid, holder: Type.Optional(HolderBody), quantity: Type.Optional(Qty), locationId: Type.Optional(Uuid), condition: Type.Optional(Condition) }, { additionalProperties: false }),
  Type.Object({ ...Base, type: Type.Literal('consume'), itemId: Uuid, quantity: Qty, jobId: Type.Optional(Uuid), purpose: Type.Optional(Type.String({ maxLength: 500 })), locationId: Type.Optional(Uuid), holder: Type.Optional(HolderBody) }, { additionalProperties: false }),
  Type.Object({ ...Base, type: Type.Literal('restock'), itemId: Uuid, quantity: Qty, locationId: Type.Optional(Uuid) }, { additionalProperties: false }),
]);
type ActionT = typeof Action.static;

const BatchBody = Type.Object({ deviceId: Type.String({ minLength: 4, maxLength: 100 }), actions: Type.Array(Action, { minItems: 1, maxItems: 200 }) }, { additionalProperties: false });

async function execute(tx: Db, ctx: OpContext, a: ActionT): Promise<OpResult> {
  const { clientActionId: _id, occurredAt: _t, type, ...rest } = a;
  const input = { ...rest, idempotencyKey: `sync:${ctx.deviceId}:${a.clientActionId}` } as never;
  switch (type) {
    case 'checkout': return doCheckout(tx, ctx, input);
    case 'checkin': return doCheckin(tx, ctx, input);
    case 'consume': return doConsume(tx, ctx, input);
    case 'restock': return doRestock(tx, ctx, input);
  }
}

type ActionResult =
  | { clientActionId: string; status: 'applied' | 'replayed'; transactionId: string }
  | { clientActionId: string; status: 'conflict' | 'failed'; code: string; message: string; conflictId?: string };

async function processBatch(db: Db, actor: Principal, deviceId: string, actions: ActionT[]): Promise<ActionResult[]> {
  // Replay in the order things physically happened; ties keep the device's own order (stable sort).
  const ordered = actions.map((a, i) => ({ a, i })).sort((x, y) => Date.parse(x.a.occurredAt) - Date.parse(y.a.occurredAt) || x.i - y.i);
  const out: ActionResult[] = [];
  for (const { a } of ordered) {
    const t = resolveOccurredAt(a.occurredAt);
    const ctx: OpContext = { actor, source: 'offline_sync', deviceId, occurredAt: t.occurredAt, meta: t.adjusted ? { clientOccurredAt: t.clientOccurredAt, occurredAtAdjusted: true } : undefined };
    try {
      const r = await withTxRetry(() => db.transaction((tx) => execute(tx as unknown as Db, ctx, a)));
      syncActions.inc({ outcome: r.replayed ? 'replayed' : 'applied' });
      out.push({ clientActionId: a.clientActionId, status: r.replayed ? 'replayed' : 'applied', transactionId: r.transaction.id });
    } catch (err) {
      if (!(err instanceof AppError)) { syncActions.inc({ outcome: 'failed' }); throw err; } // infrastructure error: let the device retry the whole batch (all keys are idempotent)
      const kind = err.statusCode === 409 ? 'conflict' : 'failed';
      syncActions.inc({ outcome: kind });
      const conflictId = await recordConflict(db, actor, deviceId, a, err, kind);
      out.push({ clientActionId: a.clientActionId, status: kind, code: err.code, message: err.message, conflictId });
    }
  }
  return out;
}

async function recordConflict(db: Db, actor: Principal, deviceId: string, a: ActionT, err: AppError, kind: 'conflict' | 'failed'): Promise<string> {
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(syncConflicts).values({
      orgId: actor.orgId, deviceId, actorUserId: actor.id, clientGeneratedId: a.clientActionId, attemptedTransaction: a as never,
      itemId: 'itemId' in a ? a.itemId : null, conflictReason: `${err.code}: ${err.message}`, failureKind: kind,
    }).onConflictDoNothing().returning({ id: syncConflicts.id });
    if (!row) {
      const [ex] = await tx.select({ id: syncConflicts.id }).from(syncConflicts).where(and(eq(syncConflicts.orgId, actor.orgId), eq(syncConflicts.actorUserId, actor.id), eq(syncConflicts.clientGeneratedId, a.clientActionId))).limit(1);
      return ex.id;
    }
    await notify(tx, { orgId: actor.orgId, type: 'sync_failure', entityType: 'sync_conflict', entityId: row.id, dedupeKey: `sync_conflict:${row.id}`,
      title: kind === 'conflict' ? 'Offline action conflicts with current stock' : 'Offline action could not be applied',
      body: `A ${a.type} recorded offline on device ${deviceId} was not applied (${err.code}).`, data: { conflictId: row.id, deviceId } });
    return row.id;
  });
}

async function resolveConflict(db: Db, reviewer: Principal, id: string, resolution: 'keep_server' | 'apply_client', note: string) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const [c] = await tx.select().from(syncConflicts).where(and(eq(syncConflicts.id, id), eq(syncConflicts.orgId, reviewer.orgId))).for('update').limit(1);
    if (!c) throw new NotFoundError('Sync conflict');
    if (c.status !== 'open') throw new ConflictError('ALREADY_RESOLVED', 'This conflict is already resolved');
    let transactionId: string | null = null;
    if (resolution === 'apply_client') {
      const [orig] = await tx.select({ id: users.id, orgId: users.orgId, role: users.role }).from(users).where(eq(users.id, c.actorUserId)).limit(1);
      const a = c.attemptedTransaction as ActionT;
      const t = resolveOccurredAt(a.occurredAt);
      const ctx: OpContext = { actor: { id: orig.id, orgId: orig.orgId, role: orig.role }, source: 'offline_sync', deviceId: c.deviceId, occurredAt: t.occurredAt, meta: { resolvedBy: reviewer.id, conflictId: id, ...(t.adjusted ? { clientOccurredAt: t.clientOccurredAt } : {}) } };
      // Re-attempt against CURRENT state. If it still can't apply, surface that and leave the conflict open.
      const r = await tx.transaction((sp) => execute(sp as unknown as Db, ctx, a)).catch((err) => {
        if (err instanceof AppError) throw new ConflictError('STILL_CONFLICTING', `The action still cannot be applied: ${err.message}`, { underlyingCode: err.code });
        throw err;
      });
      transactionId = r.transaction.id;
    }
    await tx.update(syncConflicts).set({
      status: resolution === 'keep_server' ? 'resolved_kept_server' : 'resolved_applied_client', resolutionNote: note, resolvedAt: new Date(), resolvedBy: reviewer.id,
    }).where(eq(syncConflicts.id, id));
    await audit(tx, { orgId: reviewer.orgId, actorUserId: reviewer.id, action: `sync_conflict.${resolution}`, entityType: 'sync_conflict', entityId: id, reason: note, transactionId });
    return { id, status: resolution === 'keep_server' ? 'resolved_kept_server' : 'resolved_applied_client', transactionId };
  });
}

export async function syncRoutes(app: ApiFastifyInstance) {
  /**
   * Reference data for the device's offline cache (PRD §21: "caching recently used inventory and holder information").
   * First call (no `since`): everything. Later calls pass the previous `serverTime` and get only what changed.
   * Items page by (updatedAt, id); the small reference sets (holders, hierarchy, open custody, stock) ride on the FIRST page only.
   * Archived rows are included (with archivedAt) so devices can drop them. `serverTime` is backdated 5s so a row committed
   * mid-request is re-sent next time rather than missed — clients must treat the feed as idempotent upserts.
   */
  app.get('/bootstrap', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({
    since: Type.Optional(Type.String({ format: 'date-time' })), cursor: Type.Optional(Type.String({ maxLength: 100 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 500 })),
  }) } }, async (req) => {
    const a = req.user!; const db = req.server.db; const limit = req.query.limit ?? 500;
    const serverTime = new Date(Date.now() - 5000).toISOString();
    const allowed = await allowedLocationIds(db, a);
    const since = req.query.since ? new Date(req.query.since) : null;
    let after: ReturnType<typeof sql> | undefined;
    if (req.query.cursor) {
      const [iso, id] = Buffer.from(req.query.cursor, 'base64url').toString('utf8').split('|');
      if (!iso || !id || Number.isNaN(Date.parse(iso))) throw new ValidationError('Malformed cursor');
      after = sql`(${items.updatedAt}, ${items.id}) > (${iso}::timestamptz, ${id}::uuid)`;
    }
    const rows = await db.select({
      id: items.id, type: items.type, sku: items.sku, assetTag: items.assetTag, name: items.name, categoryId: items.categoryId, locationId: items.locationId, qrCode: items.qrCode,
      assetStatus: items.assetStatus, condition: items.condition, unit: items.unit, minThreshold: items.minThreshold, reorderQuantity: items.reorderQuantity,
      archivedAt: items.archivedAt, updatedAt: items.updatedAt,
    }).from(items).where(and(eq(items.orgId, a.orgId), since ? gte(items.updatedAt, since) : undefined, allowed ? inArray(items.locationId, allowed) : undefined, after))
      .orderBy(asc(items.updatedAt), asc(items.id)).limit(limit + 1);
    const page = rows.slice(0, limit); const last = page.at(-1);
    const out: Record<string, unknown> = {
      serverTime, items: page.map((r) => ({ ...r, archivedAt: r.archivedAt?.toISOString() ?? null, updatedAt: r.updatedAt.toISOString() })),
      nextCursor: rows.length > limit && last ? Buffer.from(`${last.updatedAt.toISOString()}|${last.id}`).toString('base64url') : null,
    };
    if (!req.query.cursor) {
      const [stock, pp, tt, jj, ll, ss, cc, open] = await Promise.all([
        db.select({ itemId: stockLevels.itemId, locationId: stockLevels.locationId, quantity: stockLevels.quantity, updatedAt: stockLevels.updatedAt }).from(stockLevels)
          .where(and(eq(stockLevels.orgId, a.orgId), since ? gte(stockLevels.updatedAt, since) : undefined, allowed ? inArray(stockLevels.locationId, allowed) : undefined)).limit(20000),
        db.select({ id: people.id, fullName: people.fullName, employeeCode: people.employeeCode }).from(people).where(and(eq(people.orgId, a.orgId), isNull(people.archivedAt), eq(people.active, true))).limit(20000),
        db.select({ id: teams.id, name: teams.name, kind: teams.kind }).from(teams).where(and(eq(teams.orgId, a.orgId), isNull(teams.archivedAt))).limit(5000),
        db.select({ id: jobs.id, name: jobs.name, code: jobs.code, kind: jobs.kind }).from(jobs).where(and(eq(jobs.orgId, a.orgId), isNull(jobs.archivedAt))).limit(5000),
        db.select({ id: locations.id, name: locations.name }).from(locations).where(and(eq(locations.orgId, a.orgId), isNull(locations.archivedAt), allowed ? inArray(locations.id, allowed) : undefined)),
        db.select({ id: shelves.id, locationId: shelves.locationId, name: shelves.name }).from(shelves).where(and(eq(shelves.orgId, a.orgId), isNull(shelves.archivedAt), allowed ? inArray(shelves.locationId, allowed) : undefined)).limit(5000),
        db.select({ id: categories.id, shelfId: categories.shelfId, name: categories.name }).from(categories).where(and(eq(categories.orgId, a.orgId), isNull(categories.archivedAt))).limit(5000),
        // Open custody lets a device record returns for items it didn't issue itself.
        db.select({ itemId: custody.itemId, holderKey: custody.holderKey, quantity: custody.quantity, issuedQuantity: custody.issuedQuantity, dueAt: custody.dueAt, locationId: custody.locationId }).from(custody)
          .where(and(eq(custody.orgId, a.orgId), sql`${custody.quantity} > 0`, allowed ? inArray(custody.locationId, allowed) : undefined)).limit(20000),
      ]);
      Object.assign(out, {
        stock: stock.map((x) => ({ ...x, updatedAt: x.updatedAt.toISOString() })), holders: { people: pp, teams: tt, jobs: jj }, locations: ll, shelves: ss, categories: cc,
        openCustody: open.map((x) => ({ ...x, dueAt: x.dueAt?.toISOString() ?? null })),
      });
    }
    return out;
  });

  app.post('/batch', { preHandler: [app.authenticate, requireRole('admin', 'store_staff', 'supervisor')], schema: { body: BatchBody } }, async (req) => {
    const results = await processBatch(req.server.db, req.user!, req.body.deviceId, req.body.actions);
    return { results, summary: { applied: results.filter((r) => r.status === 'applied').length, replayed: results.filter((r) => r.status === 'replayed').length, conflicts: results.filter((r) => r.status === 'conflict').length, failed: results.filter((r) => r.status === 'failed').length } };
  });

  app.get('/conflicts', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { querystring: Type.Object({ ...PageQuery, status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('resolved_kept_server'), Type.Literal('resolved_applied_client')])) }) } }, async (req) => {
    const q = req.query; const limit = q.limit ?? 25;
    const rows = await req.server.db.select().from(syncConflicts).where(and(
      eq(syncConflicts.orgId, req.user!.orgId), q.status ? eq(syncConflicts.status, q.status) : undefined,
      q.cursor ? keysetWhere(syncConflicts.detectedAt, syncConflicts.id, q.cursor) : undefined,
    )).orderBy(desc(syncConflicts.detectedAt), desc(syncConflicts.id)).limit(limit + 1);
    const p = toPage(rows.map((r) => ({ ...r, createdAt: r.detectedAt })), limit);
    return { items: p.items.map((c) => ({ id: c.id, deviceId: c.deviceId, actorUserId: c.actorUserId, clientActionId: c.clientGeneratedId, itemId: c.itemId, kind: c.failureKind, reason: c.conflictReason, attempted: c.attemptedTransaction, status: c.status, resolutionNote: c.resolutionNote, detectedAt: c.detectedAt.toISOString(), resolvedAt: iso(c.resolvedAt) })), nextCursor: p.nextCursor };
  });

  app.post('/conflicts/:id/resolve', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { params: IdParams, body: Type.Object({ resolution: Type.Union([Type.Literal('keep_server'), Type.Literal('apply_client')]), note: Type.String({ minLength: 3, maxLength: 1000 }) }, { additionalProperties: false }) } },
    async (req) => resolveConflict(req.server.db, req.user!, req.params.id, req.body.resolution, req.body.note));
}
void anyRole; void ValidationError;
