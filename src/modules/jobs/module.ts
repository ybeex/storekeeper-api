/** Jobs / projects / sites / tasks (PRD §10): optional context on a transaction, and a Holder. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { jobs, custody } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { IdParams, PageQuery, iso } from '../../lib/schemas.js';

const Kind = Type.Union([Type.Literal('job'), Type.Literal('project'), Type.Literal('site'), Type.Literal('task')]);
const Create = Type.Object({ name: Type.String({ minLength: 1, maxLength: 150 }), code: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })), kind: Type.Optional(Kind) }, { additionalProperties: false });
const Update = Type.Partial(Create, { additionalProperties: false });
const List = Type.Object({ ...PageQuery, q: Type.Optional(Type.String({ maxLength: 100 })), kind: Type.Optional(Kind) });
const ser = (j: typeof jobs.$inferSelect) => ({ id: j.id, code: j.code, name: j.name, kind: j.kind, archivedAt: iso(j.archivedAt), createdAt: j.createdAt.toISOString() });
const WRITE = requireRole('admin', 'supervisor');
const dup = (err: unknown) => { if (isUniqueViolation(err, 'jobs_org_code_unique')) throw new ConflictError('JOB_CODE_TAKEN', 'This job code is already in use'); throw err; };

export async function jobRoutes(app: FastifyInstance) {
  app.post('/', { config: { idempotent: true }, preHandler: [app.authenticate, WRITE], schema: { body: Create } }, async (req, reply) => {
    const a = req.user!;
    try {
      const [j] = await req.server.db.insert(jobs).values({ orgId: a.orgId, ...req.body }).returning();
      await audit(req.server.db, { orgId: a.orgId, actorUserId: a.id, action: 'job.created', entityType: 'job', entityId: j.id, next: ser(j) });
      reply.code(201); return ser(j);
    } catch (e) { return dup(e); }
  });
  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: List } }, async (req) => {
    const q = req.query; const limit = q.limit ?? 25; const needle = q.q ? `%${q.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rows = await req.server.db.select().from(jobs).where(and(
      eq(jobs.orgId, req.user!.orgId), isNull(jobs.archivedAt), q.kind ? eq(jobs.kind, q.kind) : undefined,
      needle ? or(ilike(jobs.name, needle), ilike(jobs.code, needle)) : undefined,
      q.cursor ? keysetWhere(jobs.createdAt, jobs.id, q.cursor) : undefined,
    )).orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(limit + 1);
    const p = toPage(rows, limit); return { items: p.items.map(ser), nextCursor: p.nextCursor };
  });
  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => {
    const [j] = await req.server.db.select().from(jobs).where(and(eq(jobs.id, req.params.id), eq(jobs.orgId, req.user!.orgId))).limit(1);
    if (!j) throw new NotFoundError('Job'); return ser(j);
  });
  app.patch('/:id', { preHandler: [app.authenticate, WRITE], schema: { params: IdParams, body: Update } }, async (req) => {
    try {
      const [j] = await req.server.db.update(jobs).set(req.body).where(and(eq(jobs.id, req.params.id), eq(jobs.orgId, req.user!.orgId), isNull(jobs.archivedAt))).returning();
      if (!j) throw new NotFoundError('Job');
      await audit(req.server.db, { orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'job.updated', entityType: 'job', entityId: j.id, next: req.body });
      return ser(j);
    } catch (e) { return dup(e); }
  });
  app.delete('/:id', { preHandler: [app.authenticate, WRITE], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const a = req.user!;
    await req.server.db.transaction(async (tx) => {
      const [j] = await tx.select().from(jobs).where(and(eq(jobs.id, req.params.id), eq(jobs.orgId, a.orgId), isNull(jobs.archivedAt))).for('update').limit(1);
      if (!j) throw new NotFoundError('Job');
      const [o] = await tx.select({ n: sql<number>`count(*)::int` }).from(custody).where(and(sql`(${custody.holderJobId} = ${j.id} or ${custody.jobId} = ${j.id})`, sql`${custody.quantity} > 0`));
      if (o.n > 0) throw new ConflictError('JOB_HAS_OUTSTANDING', 'Items issued to or for this job are still outstanding', { outstandingLines: o.n });
      await tx.update(jobs).set({ archivedAt: new Date() }).where(eq(jobs.id, j.id));
      await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: 'job.archived', entityType: 'job', entityId: j.id, previous: ser(j) });
    });
    reply.code(204);
  });
}
