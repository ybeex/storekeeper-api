import type { ApiFastifyInstance } from '../../types.js';
/**
 * Write endpoints for every ledger operation + the ledger read API.
 *
 * Every POST requires an Idempotency-Key (8–200 chars). Safe retry is the
 * contract that makes flaky Wi-Fi at a job site survivable: the same key
 * returns the original result (HTTP 200) and never applies twice.
 *
 * Gated operations (PRD §32) answer 202 { status: 'pending_approval' } when the
 * org's policy routes the caller's request to a reviewer.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gte, lte, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { items, jobs, people, teams, transactions, users } from '../../db/schema.js';
import { ownActivityOnly } from '../../lib/scope.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { requireIdempotencyKey } from '../../lib/idempotency-header.js';
import { withTxRetry } from '../../lib/retry.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { allowedLocationIds, type Principal } from '../../lib/locations.js';
import { transactionsTotal, transactionDuration } from '../../lib/metrics.js';
import { IdParams, Uuid } from '../../lib/schemas.js';
import { decide, queueApproval, type Operation } from '../approvals/engine.js';
import { doBatchCheckout } from './batch.js';
import { doCheckin, doCheckout, doConsume, doRestock } from './movement.js';
import { doAdjustment, doCondition, doCorrection, doIncident, doReplacement, doStatusChange, doTransfer } from './lifecycle.js';
import { serializeTx } from './serialize.js';
import * as S from './schema.js';
import type { OpContext, OpResult } from './types.js';
import { Type } from '@sinclair/typebox';

const MOVERS = requireRole('admin', 'store_staff', 'supervisor');

/** Runs `fn` in one DB transaction with retry + metrics. */
async function execute<T extends { replayed: boolean }>(db: Db, type: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  const end = transactionDuration.startTimer({ type });
  try {
    const r = await withTxRetry(() => db.transaction((tx) => fn(tx as unknown as Db)));
    transactionsTotal.inc({ type, outcome: r.replayed ? 'replayed' : 'committed' });
    return r;
  } catch (err) {
    transactionsTotal.inc({ type, outcome: (err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500 ? 'rejected' : 'failed' });
    throw err;
  } finally { end(); }
}

const ctxOf = (req: FastifyRequest): OpContext => ({ actor: req.user as Principal, source: 'online' });

interface GateOpts<B> {
  req: FastifyRequest; reply: FastifyReply; operation?: Operation; metricType: string; magnitude: number; itemId?: string;
  body: B; run: (tx: Db, ctx: OpContext, input: B & { idempotencyKey: string }) => Promise<OpResult>;
}

/** Run now, or queue for approval per org policy. */
async function gated<B extends Record<string, unknown>>(o: GateOpts<B>) {
  const key = requireIdempotencyKey(o.req.headers);
  const db = o.req.server.db;
  const actor = o.req.user as Principal;
  if (o.operation) {
    const d = await decide(db, actor, o.operation, o.magnitude);
    if (d.queue) {
      const ar = await db.transaction((tx) => queueApproval(tx as unknown as Db, actor, o.operation!, d.mode, o.body, o.itemId, key));
      o.reply.code(202);
      return { status: 'pending_approval' as const, approvalRequestId: ar.id };
    }
  }
  const r = await execute(db, o.metricType, (tx) => o.run(tx, ctxOf(o.req), { ...o.body, idempotencyKey: key }));
  o.reply.code(r.replayed ? 200 : 201);
  return { status: 'committed' as const, replayed: r.replayed, transaction: serializeTx(r.transaction), dueAt: r.dueAt?.toISOString() ?? null };
}

export async function transactionRoutes(app: ApiFastifyInstance) {
  app.post('/checkouts', { preHandler: [app.authenticate, MOVERS], schema: { body: S.CheckoutBody } }, (req, reply) =>
    gated({ req, reply, operation: 'checkout', metricType: 'checkout', magnitude: req.body.quantity ?? 1, itemId: req.body.itemId, body: req.body, run: doCheckout }));

  app.post('/checkouts/batch', { preHandler: [app.authenticate, MOVERS], schema: { body: S.BatchCheckoutBody } }, async (req, reply) => {
    const key = requireIdempotencyKey(req.headers);
    const actor = req.user as Principal; const db = req.server.db;
    const mag = req.body.lines.reduce((n, l) => n + (l.quantity ?? 1), 0);
    const d = await decide(db, actor, 'checkout', mag);
    if (d.queue) {
      const ar = await db.transaction((tx) => queueApproval(tx as unknown as Db, actor, 'checkout', d.mode, req.body, undefined, key));
      reply.code(202); return { status: 'pending_approval', approvalRequestId: ar.id };
    }
    const r = await execute(db, 'checkout', (tx) => doBatchCheckout(tx, ctxOf(req), { ...req.body, idempotencyKey: key }));
    reply.code(r.replayed ? 200 : 201);
    return { status: 'committed', replayed: r.replayed, transactions: r.results.map((x) => ({ ...serializeTx(x.transaction), dueAt: x.dueAt?.toISOString() ?? null })) };
  });

  app.post('/checkins', { preHandler: [app.authenticate, MOVERS], schema: { body: S.CheckinBody } }, (req, reply) =>
    gated({ req, reply, operation: 'checkin', metricType: 'checkin', magnitude: req.body.quantity ?? 1, itemId: req.body.itemId, body: req.body, run: doCheckin }));

  app.post('/consumptions', { preHandler: [app.authenticate, MOVERS], schema: { body: S.ConsumeBody } }, (req, reply) =>
    gated({ req, reply, metricType: 'consume', magnitude: req.body.quantity, body: req.body, run: doConsume }));

  app.post('/restocks', { preHandler: [app.authenticate, MOVERS], schema: { body: S.RestockBody } }, (req, reply) =>
    gated({ req, reply, metricType: 'restock', magnitude: req.body.quantity, body: req.body, run: doRestock }));

  app.post('/adjustments', { preHandler: [app.authenticate, MOVERS], schema: { body: S.AdjustmentBody } }, (req, reply) =>
    gated({ req, reply, operation: 'adjustment', metricType: 'adjustment', magnitude: Math.abs(req.body.delta), itemId: req.body.itemId, body: req.body, run: doAdjustment }));

  app.post('/losses', { preHandler: [app.authenticate, MOVERS], schema: { body: S.IncidentBody } }, (req, reply) =>
    gated({ req, reply, operation: 'loss', metricType: 'loss', magnitude: req.body.quantity ?? 1, itemId: req.body.itemId, body: req.body, run: (tx, c, i) => doIncident(tx, c, 'loss', i) }));

  app.post('/damages', { preHandler: [app.authenticate, MOVERS], schema: { body: S.IncidentBody } }, (req, reply) =>
    gated({ req, reply, operation: 'damage', metricType: 'damage', magnitude: req.body.quantity ?? 1, itemId: req.body.itemId, body: req.body, run: (tx, c, i) => doIncident(tx, c, 'damage', i) }));

  app.post('/items/:id/condition', { preHandler: [app.authenticate, MOVERS], schema: { params: IdParams, body: S.ConditionBody } }, (req, reply) =>
    gated({ req, reply, metricType: 'condition_update', magnitude: 1, body: { ...req.body, itemId: req.params.id }, run: doCondition }));

  // Retirement is gated (PRD §32); the other transitions are routine.
  app.post('/items/:id/status', { preHandler: [app.authenticate, MOVERS], schema: { params: IdParams, body: S.StatusBody } }, (req, reply) =>
    gated({ req, reply, operation: req.body.to === 'retired' ? 'retirement' : undefined, metricType: 'status_change', magnitude: 1, itemId: req.params.id,
      body: { ...req.body, itemId: req.params.id }, run: doStatusChange }));

  // Retiring an asset is a gated operation (PRD §32); a replacement retires one, so it follows the same policy.
  app.post('/items/:id/replacement', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { params: IdParams, body: S.ReplacementBody } }, (req, reply) =>
    gated({ req, reply, operation: 'retirement', metricType: 'replacement', magnitude: 1, itemId: req.params.id, body: { ...req.body, itemId: req.params.id }, run: doReplacement }));

  app.post('/transfers', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { body: S.TransferBody } }, async (req, reply) => {
    const key = requireIdempotencyKey(req.headers);
    const r = await execute(req.server.db, 'transfer', (tx) => doTransfer(tx, ctxOf(req), { ...req.body, idempotencyKey: key }));
    reply.code(r.replayed ? 200 : 201);
    return { status: 'committed', replayed: r.replayed, out: serializeTx(r.transaction), in: r.inTransaction ? serializeTx(r.inTransaction) : null };
  });

  app.post('/transactions/:id/corrections', { preHandler: [app.authenticate, MOVERS], schema: { params: IdParams, body: S.CorrectionBody } }, (req, reply) =>
    // Magnitude is unknown until the target is loaded; treat as "large" so any configured threshold applies.
    gated({ req, reply, operation: 'manual_correction', metricType: 'correction', magnitude: Number.MAX_SAFE_INTEGER, body: { transactionId: req.params.id, note: req.body.note }, run: doCorrection }));

  // ── Ledger read API (PRD §24, §25) ────────────────────────────────
  // Names are joined in here so a client never has to show a database id: item, who recorded it, who holds it.
  const named = {
    t: transactions, itemName: items.name, itemSku: items.sku, itemAssetTag: items.assetTag, itemUnit: items.unit,
    actorName: sql<string>`coalesce(${users.fullName}, split_part(${users.email}, '@', 1))`,
    holderName: sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`,
    jobName: sql<string | null>`(select j.name from jobs j where j.id = ${transactions.jobId})`,
  };
  type Named = { t: typeof transactions.$inferSelect; itemName: string; itemSku: string; itemAssetTag: string | null; itemUnit: string | null; actorName: string; holderName: string | null; jobName: string | null };
  const view = (r: Named) => {
    const base = serializeTx(r.t);
    return {
      ...base,
      holder: base.holder ? { ...base.holder, name: r.holderName } : null,
      item: { id: r.t.itemId, name: r.itemName, sku: r.itemSku, assetTag: r.itemAssetTag, unit: r.itemUnit },
      actor: { id: r.t.actorUserId, name: r.actorName },
      job: r.t.jobId ? { id: r.t.jobId, name: r.jobName } : null,
    };
  };
  const joined = (db: Db) => db.select(named).from(transactions)
    .innerJoin(items, eq(transactions.itemId, items.id)).innerJoin(users, eq(transactions.actorUserId, users.id))
    .leftJoin(people, eq(transactions.holderPersonId, people.id)).leftJoin(teams, eq(transactions.holderTeamId, teams.id)).leftJoin(jobs, eq(transactions.holderJobId, jobs.id));

  app.get('/transactions', { preHandler: [app.authenticate, anyRole], schema: { querystring: S.ListTransactionsQuery } }, async (req) => {
    const a = req.user as Principal; const q = req.query; const limit = q.limit ?? 50;
    const allowed = await allowedLocationIds(req.server.db, a);
    let cursorSeq: number | undefined;
    if (q.cursor) { cursorSeq = Number(q.cursor); if (!Number.isSafeInteger(cursorSeq)) throw new ValidationError('Malformed cursor'); }
    const holderCol = q.holderType === 'person' ? transactions.holderPersonId : q.holderType === 'team' ? transactions.holderTeamId : transactions.holderJobId;
    if ((q.holderType && !q.holderId) || (!q.holderType && q.holderId)) throw new ValidationError('holderType and holderId must be provided together');
    const actorFilter = ownActivityOnly(a) ?? q.actorUserId; // store staff only ever see what they recorded themselves
    const rows = await joined(req.server.db).where(and(
      eq(transactions.orgId, a.orgId),
      q.itemId ? eq(transactions.itemId, q.itemId) : undefined,
      q.type ? sql`${transactions.type}::text = ${q.type}` : undefined,
      actorFilter ? eq(transactions.actorUserId, actorFilter) : undefined,
      q.locationId ? eq(transactions.locationId, q.locationId) : undefined,
      q.jobId ? eq(transactions.jobId, q.jobId) : undefined,
      q.source ? eq(transactions.source, q.source) : undefined,
      q.holderType && q.holderId ? eq(holderCol, q.holderId) : undefined,
      q.from ? gte(transactions.occurredAt, new Date(q.from)) : undefined,
      q.to ? lte(transactions.occurredAt, new Date(q.to)) : undefined,
      allowed ? sql`${transactions.locationId} in (${sql.join(allowed.map((l) => sql`${l}::uuid`), sql`, `)})` : undefined,
      cursorSeq !== undefined ? lt(transactions.seq, cursorSeq) : undefined,
    )).orderBy(desc(transactions.seq)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return { items: page.map(view), nextCursor: rows.length > limit ? String(page.at(-1)!.t.seq) : null };
  });

  app.get('/transactions/:id', { preHandler: [app.authenticate, anyRole], schema: { params: Type.Object({ id: Uuid }) } }, async (req) => {
    const a = req.user as Principal;
    const own = ownActivityOnly(a);
    const [t] = await joined(req.server.db).where(and(eq(transactions.id, req.params.id), eq(transactions.orgId, a.orgId), own ? eq(transactions.actorUserId, own) : undefined)).limit(1);
    if (!t) throw new NotFoundError('Transaction'); // another person's entry looks the same as a missing one to store staff
    return view(t);
  });
}
