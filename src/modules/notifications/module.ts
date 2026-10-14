import type { ApiFastifyInstance } from '../../types.js';
/** In-app notifications (PRD §30). Visibility is by role; read state is per user. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { notificationReads, notificationRules, notifications } from '../../db/schema.js';
import { requireRole } from '../../plugins/rbac.js';
import { DEFAULT_RULES, RULE_INFO, getRule, notify, type NotificationType, type Role } from '../../lib/notify.js';
import { audit } from '../../lib/audit.js';
import { ForbiddenError } from '../../lib/errors.js';
import { anyRole } from '../../plugins/rbac.js';
import { NotFoundError } from '../../lib/errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { IdParams, PageQuery } from '../../lib/schemas.js';

export async function notificationRoutes(app: ApiFastifyInstance) {
  const visible = (orgId: string, role: string) => and(eq(notifications.orgId, orgId), sql`${role}::role = any(${notifications.audienceRoles})`);

  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({ ...PageQuery, unread: Type.Optional(Type.Boolean()), type: Type.Optional(Type.String({ maxLength: 40 })) }) } }, async (req) => {
    const a = req.user!; const q = req.query; const limit = q.limit ?? 25;
    const rows = await req.server.db.select({ n: notifications, readAt: notificationReads.readAt }).from(notifications)
      .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, a.id)))
      .where(and(visible(a.orgId, a.role), q.unread ? isNull(notificationReads.readAt) : undefined, q.type ? sql`${notifications.type}::text = ${q.type}` : undefined,
        q.cursor ? keysetWhere(notifications.createdAt, notifications.id, q.cursor) : undefined))
      .orderBy(desc(notifications.createdAt), desc(notifications.id)).limit(limit + 1);
    const p = toPage(rows.map((r) => ({ ...r, createdAt: r.n.createdAt, id: r.n.id })), limit);
    return { items: p.items.map((r) => ({ id: r.n.id, type: r.n.type, title: r.n.title, body: r.n.body, entityType: r.n.entityType, entityId: r.n.entityId, data: r.n.data, read: !!r.readAt, createdAt: r.n.createdAt.toISOString() })), nextCursor: p.nextCursor };
  });

  app.get('/unread-count', { preHandler: [app.authenticate, anyRole] }, async (req) => {
    const a = req.user!;
    const [r] = await req.server.db.select({ n: sql<number>`count(*)::int` }).from(notifications)
      .leftJoin(notificationReads, and(eq(notificationReads.notificationId, notifications.id), eq(notificationReads.userId, a.id)))
      .where(and(visible(a.orgId, a.role), isNull(notificationReads.readAt), sql`${notifications.createdAt} > now() - interval '60 days'`));
    return { unread: r.n };
  });

  app.post('/:id/read', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const a = req.user!;
    const [n] = await req.server.db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.id, req.params.id), visible(a.orgId, a.role))).limit(1);
    if (!n) throw new NotFoundError('Notification');
    await req.server.db.insert(notificationReads).values({ notificationId: n.id, userId: a.id }).onConflictDoNothing();
    reply.code(204);
  });

  app.post('/read-all', { preHandler: [app.authenticate, anyRole], schema: { response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const a = req.user!;
    await req.server.db.execute(sql`insert into notification_reads (notification_id, user_id)
      select n.id, ${a.id}::uuid from notifications n where n.org_id = ${a.orgId}::uuid and ${a.role}::role = any(n.audience_roles) and n.created_at > now() - interval '60 days'
      on conflict do nothing`);
    reply.code(204);
  });
  // ── Org-wide, role-based delivery rules (admin) ──
  const RoleLit = Type.Union(['admin', 'supervisor', 'store_staff', 'viewer'].map((r) => Type.Literal(r)) as never);
  const TypeLit = Type.Union(Object.keys(DEFAULT_RULES).map((r) => Type.Literal(r)) as never);

  app.get('/rules', { preHandler: [app.authenticate, requireRole('admin')] }, async (req) => {
    const a = req.user!;
    const types = Object.keys(DEFAULT_RULES) as NotificationType[];
    return { rules: await Promise.all(types.map(async (type) => ({ type, ...RULE_INFO[type], ...(await getRule(req.server.db, a.orgId, type)) }))) };
  });

  app.put('/rules', { preHandler: [app.authenticate, requireRole('admin')], schema: { body: Type.Object({
    rules: Type.Array(Type.Object({ type: TypeLit, roles: Type.Array(RoleLit, { uniqueItems: true, maxItems: 4 }), inApp: Type.Boolean(), email: Type.Boolean() }, { additionalProperties: false }), { minItems: 1, maxItems: 20 }),
  }, { additionalProperties: false }) } }, async (req) => {
    const a = req.user!;
    await req.server.db.transaction(async (tx) => {
      for (const r of req.body.rules as Array<{ type: NotificationType; roles: Role[]; inApp: boolean; email: boolean }>) {
        await tx.insert(notificationRules).values({ orgId: a.orgId, type: r.type, roles: r.roles, inApp: r.inApp, email: r.email })
          .onConflictDoUpdate({ target: [notificationRules.orgId, notificationRules.type], set: { roles: r.roles, inApp: r.inApp, email: r.email, updatedAt: new Date() } });
      }
      await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: 'notification_rules.updated', entityType: 'notification_rules', entityId: a.orgId, next: req.body.rules });
    });
    return { ok: true };
  });

  // ── Announcements: an admin/supervisor broadcasts to chosen roles (supervisors cannot reach admins/supervisors) ──
  app.post('/announcements', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { body: Type.Object({
    title: Type.String({ minLength: 1, maxLength: 150 }), body: Type.String({ minLength: 1, maxLength: 2000 }),
    roles: Type.Array(RoleLit, { minItems: 1, uniqueItems: true }), email: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false }) } }, async (req, reply) => {
    const a = req.user!; const roles = req.body.roles as Role[];
    if (a.role === 'supervisor' && roles.some((r) => r === 'admin' || r === 'supervisor')) throw new ForbiddenError('Supervisors can announce to store staff and viewers only');
    await req.server.db.transaction(async (tx) => {
      await notify(tx as never, { orgId: a.orgId, type: 'announcement', title: req.body.title, body: req.body.body, audienceRoles: roles, explicitAudience: true, email: req.body.email ?? false, data: { sentBy: a.id } });
      await audit(tx as never, { orgId: a.orgId, actorUserId: a.id, action: 'announcement.sent', entityType: 'announcement', entityId: a.orgId, next: { title: req.body.title, roles, email: req.body.email ?? false } });
    });
    reply.code(201); return { ok: true };
  });
}
