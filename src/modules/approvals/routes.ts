import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq } from 'drizzle-orm';
import { approvalRequests, users } from '../../db/schema.js';
import { anyRole, requireRole } from '../../plugins/rbac.js';
import { AppError } from '../../lib/errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { IdParams, PageQuery, iso } from '../../lib/schemas.js';
import { NotFoundError } from '../../lib/errors.js';
import { review, cancel } from './engine.js';

const ListQuery = Type.Object({ ...PageQuery, status: Type.Optional(Type.Union(['pending', 'approved', 'rejected', 'failed'].map((s) => Type.Literal(s)) as never)), mine: Type.Optional(Type.Boolean()) });
const ReviewBody = Type.Object({ note: Type.Optional(Type.String({ maxLength: 1000 })) }, { additionalProperties: false });

const ser = (r: typeof approvalRequests.$inferSelect, requesterEmail?: string) => ({
  id: r.id, operation: r.operation, status: r.status, itemId: r.itemId, payload: r.payload, requestedBy: r.requestedBy, requesterEmail,
  reviewedBy: r.reviewedBy, reviewedAt: iso(r.reviewedAt), reviewNote: r.reviewNote, resultingTransactionId: r.resultingTransactionId,
  failureReason: r.failureReason, createdAt: r.createdAt.toISOString(),
});

export async function approvalRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: ListQuery } }, async (req) => {
    const a = req.user!; const q = req.query; const limit = q.limit ?? 25;
    const privileged = a.role === 'admin' || a.role === 'supervisor';
    const rows = await req.server.db.select({ r: approvalRequests, email: users.email }).from(approvalRequests).innerJoin(users, eq(approvalRequests.requestedBy, users.id)).where(and(
      eq(approvalRequests.orgId, a.orgId), q.status ? eq(approvalRequests.status, q.status as never) : undefined,
      !privileged || q.mine ? eq(approvalRequests.requestedBy, a.id) : undefined, // staff see only their own
      q.cursor ? keysetWhere(approvalRequests.createdAt, approvalRequests.id, q.cursor) : undefined,
    )).orderBy(desc(approvalRequests.createdAt), desc(approvalRequests.id)).limit(limit + 1);
    const p = toPage(rows.map((x) => ({ ...x, createdAt: x.r.createdAt, id: x.r.id })), limit);
    return { items: p.items.map((x) => ser(x.r, x.email)), nextCursor: p.nextCursor };
  });

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => {
    const a = req.user!;
    const [row] = await req.server.db.select({ r: approvalRequests, email: users.email }).from(approvalRequests).innerJoin(users, eq(approvalRequests.requestedBy, users.id))
      .where(and(eq(approvalRequests.id, req.params.id), eq(approvalRequests.orgId, a.orgId))).limit(1);
    if (!row || (a.role !== 'admin' && a.role !== 'supervisor' && row.r.requestedBy !== a.id)) throw new NotFoundError('Approval request');
    return ser(row.r, row.email);
  });

  app.post('/:id/approve', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { params: IdParams, body: ReviewBody } }, async (req) => {
    const r = await review(req.server.db, req.user!, req.params.id, 'approve', req.body.note);
    if (r.status === 'failed') throw new AppError(409, 'APPROVAL_EXECUTION_FAILED', `The request could not be applied: ${r.failure!.message}`, { underlyingCode: r.failure!.code });
    return r;
  });

  app.post('/:id/reject', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { params: IdParams, body: ReviewBody } }, async (req) => review(req.server.db, req.user!, req.params.id, 'reject', req.body.note));

  app.post('/:id/cancel', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    await cancel(req.server.db, req.user!, req.params.id); reply.code(204);
  });
}
