/**
 * Approval engine (PRD §18, §32). One mechanism for every gated operation:
 *   policy(op) + actor role + magnitude  →  run now, or queue a request
 * and executing an approved request calls the SAME op function a direct call
 * would, with the requester as Actor — so approved work is indistinguishable
 * from direct work in the ledger except for `metadata.approvedBy`.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { approvalPolicies, approvalRequests, reconciliationCounts, users } from '../../db/schema.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { audit } from '../../lib/audit.js';
import type { Principal } from '../../lib/locations.js';
import { doAdjustment, doCondition, doCorrection, doIncident, doReplacement, doStatusChange, doTransfer } from '../transactions/lifecycle.js';
import { doCheckin, doCheckout } from '../transactions/movement.js';
import { doBatchCheckout, type BatchInput } from '../transactions/batch.js';
import type { OpContext, OpResult } from '../transactions/types.js';

export type Operation = typeof approvalRequests.$inferInsert['operation'];
type Mode = 'direct' | 'request' | 'approval';

export async function policyFor(db: Db, orgId: string, op: Operation): Promise<{ mode: Mode; largeThreshold: number | null }> {
  const [p] = await db.select().from(approvalPolicies).where(and(eq(approvalPolicies.orgId, orgId), eq(approvalPolicies.operation, op))).limit(1);
  return { mode: p?.mode ?? 'direct', largeThreshold: p?.largeThreshold ?? null };
}

/** `request`: staff queue, supervisors+admins commit. `approval`: everyone but admins queue. */
export async function decide(db: Db, actor: Principal, op: Operation, magnitude: number): Promise<{ queue: boolean; mode: Mode }> {
  const p = await policyFor(db, actor.orgId, op);
  if (p.mode === 'direct') return { queue: false, mode: p.mode };
  if (p.largeThreshold !== null && magnitude < p.largeThreshold) return { queue: false, mode: p.mode };
  const selfCommits = p.mode === 'approval' ? actor.role === 'admin' : actor.role === 'admin' || actor.role === 'supervisor';
  return { queue: !selfCommits, mode: p.mode };
}

export async function queueApproval(tx: Db, actor: Principal, op: Operation, mode: Mode, payload: Record<string, unknown>, itemId: string | undefined, idempotencyKey: string) {
  try {
    const [row] = await tx.transaction((sp) => sp.insert(approvalRequests).values({
      orgId: actor.orgId, operation: op, payload: payload as never, itemId, requestedBy: actor.id, idempotencyKey,
    }).returning());
    await notify(tx, {
      orgId: actor.orgId, type: 'approval_pending', entityType: 'approval_request', entityId: row.id, dedupeKey: `approval:${row.id}`,
      audienceRoles: mode === 'approval' ? ['admin'] : ['admin', 'supervisor'],
      title: `Approval needed: ${op.replace('_', ' ')}`, body: `A ${op.replace('_', ' ')} request is waiting for review.`, data: { approvalRequestId: row.id, operation: op },
    });
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'approval.requested', entityType: 'approval_request', entityId: row.id, next: { operation: op } });
    return row;
  } catch (err) {
    if (isUniqueViolation(err, 'approval_requests_idempotency_unique')) {
      const [existing] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.orgId, actor.orgId), eq(approvalRequests.requestedBy, actor.id), eq(approvalRequests.idempotencyKey, idempotencyKey))).limit(1);
      if (existing) return existing;
    }
    throw err;
  }
}

type Executor = (tx: Db, ctx: OpContext, payload: any) => Promise<OpResult | { results: OpResult[] }>;
const EXECUTORS: Record<Operation, Executor> = {
  adjustment: (tx, ctx, p) => doAdjustment(tx, ctx, p),
  loss: (tx, ctx, p) => doIncident(tx, ctx, 'loss', p),
  damage: (tx, ctx, p) => doIncident(tx, ctx, 'damage', p),
  retirement: (tx, ctx, p) => (p.replacementItemId ? doReplacement(tx, ctx, p) : doStatusChange(tx, ctx, { ...p, to: 'retired' })),
  manual_correction: (tx, ctx, p) => doCorrection(tx, ctx, p),
  checkout: (tx, ctx, p) => (p.lines ? doBatchCheckout(tx, ctx, p as BatchInput) : doCheckout(tx, ctx, p)),
  checkin: (tx, ctx, p) => doCheckin(tx, ctx, p),
};
void doCondition; void doTransfer;

export async function review(db: Db, reviewer: Principal, id: string, decision: 'approve' | 'reject', note?: string) {
  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.id, id), eq(approvalRequests.orgId, reviewer.orgId))).for('update').limit(1);
    if (!req) throw new NotFoundError('Approval request');
    if (req.status !== 'pending') throw new ConflictError('ALREADY_REVIEWED', `This request is already ${req.status}`);
    if (req.requestedBy === reviewer.id) throw new ConflictError('SELF_APPROVAL', 'You cannot review your own request');
    const { mode } = await policyFor(tx, reviewer.orgId, req.operation);
    const mayReview = mode === 'approval' ? reviewer.role === 'admin' : reviewer.role === 'admin' || reviewer.role === 'supervisor';
    if (!mayReview) throw new ForbiddenError(mode === 'approval' ? 'Only an admin can review this request' : 'Only a supervisor or admin can review this request');

    if (decision === 'reject') {
      await tx.update(approvalRequests).set({ status: 'rejected', reviewedBy: reviewer.id, reviewedAt: new Date(), reviewNote: note }).where(eq(approvalRequests.id, id));
      await audit(tx, { orgId: reviewer.orgId, actorUserId: reviewer.id, action: 'approval.rejected', entityType: 'approval_request', entityId: id, reason: note });
      return { status: 'rejected' as const, transactionId: null };
    }

    const [requester] = await tx.select({ id: users.id, orgId: users.orgId, role: users.role, active: users.active }).from(users).where(eq(users.id, req.requestedBy)).limit(1);
    const ctx: OpContext = { actor: { id: requester.id, orgId: requester.orgId, role: requester.role }, source: 'online', meta: { approvedBy: reviewer.id, approvalRequestId: id } };
    const payload = { ...(req.payload as Record<string, unknown>), idempotencyKey: `approval:${id}` };
    try {
      if (!requester.active) throw new ConflictError('REQUESTER_INACTIVE', 'The requesting user is no longer active');
      // Savepoint: if the world changed since the request was made, the failed attempt rolls back cleanly...
      const result = await tx.transaction((sp) => EXECUTORS[req.operation](sp as unknown as Db, ctx, payload));
      const first = 'transaction' in result ? result.transaction : result.results[0]?.transaction;
      await tx.update(approvalRequests).set({ status: 'approved', reviewedBy: reviewer.id, reviewedAt: new Date(), reviewNote: note, resultingTransactionId: first?.id }).where(eq(approvalRequests.id, id));
      const countId = (req.payload as { reconciliationCountId?: string }).reconciliationCountId;
      if (countId && first) await tx.update(reconciliationCounts).set({ linkedAdjustmentTransactionId: first.id, resolvedBy: reviewer.id }).where(eq(reconciliationCounts.id, countId));
      await audit(tx, { orgId: reviewer.orgId, actorUserId: reviewer.id, action: 'approval.approved', entityType: 'approval_request', entityId: id, transactionId: first?.id, reason: note });
      return { status: 'approved' as const, transactionId: first?.id ?? null };
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      // ...and we record WHY it failed, so the request doesn't sit pending forever with no explanation.
      await tx.update(approvalRequests).set({ status: 'failed', reviewedBy: reviewer.id, reviewedAt: new Date(), reviewNote: note, failureReason: `${err.code}: ${err.message}` }).where(eq(approvalRequests.id, id));
      await audit(tx, { orgId: reviewer.orgId, actorUserId: reviewer.id, action: 'approval.failed', entityType: 'approval_request', entityId: id, reason: err.message });
      return { status: 'failed' as const, transactionId: null, failure: { code: err.code, message: err.message } };
    }
  });
}

export async function cancel(db: Db, actor: Principal, id: string) {
  const rows = await db.update(approvalRequests).set({ status: 'rejected', reviewedAt: new Date(), reviewNote: 'Cancelled by requester' })
    .where(and(eq(approvalRequests.id, id), eq(approvalRequests.orgId, actor.orgId), eq(approvalRequests.requestedBy, actor.id), eq(approvalRequests.status, 'pending'))).returning({ id: approvalRequests.id });
  if (rows.length === 0) throw new NotFoundError('Pending request');
}
