/** Audit log API — the readable side of "all actions monitored with logs". Append-only table; this is read-only. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, gte, ilike, lt, lte, sql } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { auditEvents, users } from '../../db/schema.js';
import { requireRole } from '../../plugins/rbac.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { PageQuery, Uuid } from '../../lib/schemas.js';
import { audit } from '../../lib/audit.js';

const Filters = {
  action: Type.Optional(Type.String({ maxLength: 80, description: 'Prefix match, e.g. "item." or "auth."' })),
  entityType: Type.Optional(Type.String({ maxLength: 60 })), entityId: Type.Optional(Type.String({ maxLength: 80 })),
  actorUserId: Type.Optional(Uuid), includeRequests: Type.Optional(Type.Boolean({ description: 'Include the request-level safety-net rows (default false)' })),
  from: Type.Optional(Type.String({ format: 'date-time' })), to: Type.Optional(Type.String({ format: 'date-time' })),
};
const esc = (v: unknown) => { let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export async function auditRoutes(app: FastifyInstance) {
  const pre = [app.authenticate, requireRole('admin', 'supervisor')];
  const like = (s: string) => `${s.replace(/[%_\\]/g, '\\$&')}%`;
  type F = { action?: string; entityType?: string; entityId?: string; actorUserId?: string; includeRequests?: boolean; from?: string; to?: string };
  const where = (orgId: string, q: F) => and(
    eq(auditEvents.orgId, orgId), q.includeRequests ? undefined : sql`${auditEvents.entityType} <> 'request'`,
    q.action ? ilike(auditEvents.action, like(q.action)) : undefined, q.entityType ? eq(auditEvents.entityType, q.entityType) : undefined,
    q.entityId ? eq(auditEvents.entityId, q.entityId) : undefined, q.actorUserId ? eq(auditEvents.actorUserId, q.actorUserId) : undefined,
    q.from ? gte(auditEvents.createdAt, new Date(q.from)) : undefined, q.to ? lte(auditEvents.createdAt, new Date(q.to)) : undefined);
  const cols = { e: auditEvents, actorName: sql<string | null>`coalesce(${users.fullName}, split_part(${users.email}, '@', 1))`, actorEmail: users.email };
  const ser = (r: { e: typeof auditEvents.$inferSelect; actorName: string | null; actorEmail: string | null }) => ({
    id: r.e.id, at: r.e.createdAt.toISOString(), action: r.e.action, entityType: r.e.entityType, entityId: r.e.entityId,
    actor: r.e.actorUserId ? { id: r.e.actorUserId, name: r.actorName, email: r.actorEmail } : null,
    previous: r.e.previousState, next: r.e.newState, reason: r.e.reason, transactionId: r.e.transactionId, metadata: r.e.metadata, ip: r.e.ip, requestId: r.e.requestId,
  });

  app.get('/', { preHandler: pre, schema: { querystring: Type.Object({ ...PageQuery, ...Filters }) } }, async (req) => {
    const q = req.query; const limit = q.limit ?? 50;
    const rows = await req.server.db.select(cols).from(auditEvents).leftJoin(users, eq(auditEvents.actorUserId, users.id))
      .where(and(where(req.user!.orgId, q), q.cursor ? keysetWhere(auditEvents.createdAt, auditEvents.id, q.cursor) : undefined))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(limit + 1);
    const p = toPage(rows.map((r) => ({ ...r, createdAt: r.e.createdAt, id: r.e.id })), limit);
    return { items: p.items.map(ser), nextCursor: p.nextCursor };
  });

  // Everything that ever happened to one thing — the "history" tab on any entity.
  app.get('/entity/:type/:id', { preHandler: pre, schema: { params: Type.Object({ type: Type.String({ maxLength: 60 }), id: Type.String({ maxLength: 80 }) }), querystring: Type.Object(PageQuery) } }, async (req) => {
    const limit = req.query.limit ?? 50;
    const rows = await req.server.db.select(cols).from(auditEvents).leftJoin(users, eq(auditEvents.actorUserId, users.id))
      .where(and(eq(auditEvents.orgId, req.user!.orgId), eq(auditEvents.entityType, req.params.type), eq(auditEvents.entityId, req.params.id), req.query.cursor ? keysetWhere(auditEvents.createdAt, auditEvents.id, req.query.cursor) : undefined))
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(limit + 1);
    const p = toPage(rows.map((r) => ({ ...r, createdAt: r.e.createdAt, id: r.e.id })), limit);
    return { items: p.items.map(ser), nextCursor: p.nextCursor };
  });

  // Streamed CSV export (admin). The export itself is logged by the activity plugin as `data.exported`.
  app.get('/export.csv', { preHandler: [app.authenticate, requireRole('admin')], schema: { querystring: Type.Object(Filters) } }, async (req, reply) => {
    const q = req.query; const orgId = req.user!.orgId;
    async function* gen() {
      yield '\uFEFFat,action,entity_type,entity_id,actor,reason,ip,metadata\n';
      let before: { at: Date; id: string } | undefined;
      for (;;) {
        const rows = await req.server.db.select(cols).from(auditEvents).leftJoin(users, eq(auditEvents.actorUserId, users.id))
          .where(and(where(orgId, q), before ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (${before.at}, ${before.id}::uuid)` : undefined))
          .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id)).limit(1000);
        for (const r of rows) yield [r.e.createdAt, r.e.action, r.e.entityType, r.e.entityId, r.actorEmail, r.e.reason, r.e.ip, r.e.metadata].map(esc).join(',') + '\n';
        if (rows.length < 1000) return;
        before = { at: rows.at(-1)!.e.createdAt, id: rows.at(-1)!.e.id };
      }
    }
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="audit-log.csv"').header('cache-control', 'no-store');
    return reply.send(Readable.from(gen()));
  });
}
void lt; void audit;
