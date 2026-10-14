/**
 * The organisations page (/app) for an admin who runs one or more organisations.
 *
 * Admin only, everywhere. A person's organisations are the admin rows tied together by users.account_id; an admin who has
 * only ever had one organisation simply has one entry. Invited users are never part of this: they work in exactly one
 * organisation and have no account link.
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { organizations, userTokens, users } from '../../db/schema.js';
import type { Db } from '../../db/index.js';
import { requireRole } from '../../plugins/rbac.js';
import { createOrganizationForAdmin } from '../auth/service.js';

/** The admin rows this person can open: their own plus any they created under the same account. */
async function myOrganizations(db: Db, userId: string) {
  const [me] = await db.select({ id: users.id, orgId: users.orgId, accountId: users.accountId }).from(users).where(eq(users.id, userId)).limit(1);
  const rows = await db.select({ userId: users.id, orgId: organizations.id, name: organizations.name, slug: organizations.slug, createdAt: organizations.createdAt })
    .from(users).innerJoin(organizations, eq(users.orgId, organizations.id))
    .where(and(me?.accountId ? eq(users.accountId, me.accountId) : eq(users.id, userId), eq(users.role, 'admin'), eq(users.active, true)))
    .orderBy(organizations.createdAt);
  return { currentOrgId: me?.orgId, rows };
}

export async function accountRoutes(app: FastifyInstance) {
  const ADMIN = requireRole('admin');

  app.get('/organizations', { preHandler: [app.authenticate, ADMIN] }, async (req) => {
    const { currentOrgId, rows } = await myOrganizations(req.server.db, req.user!.id);
    return { items: rows.map((r) => ({ id: r.orgId, name: r.name, slug: r.slug, current: r.orgId === currentOrgId })) };
  });

  app.post('/organizations', { preHandler: [app.authenticate, ADMIN], schema: { body: Type.Object({ organizationName: Type.String({ minLength: 2, maxLength: 120 }), firstLocationName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })) }, { additionalProperties: false }) } }, async (req, reply) => {
    const r = await createOrganizationForAdmin(req.server.db, req.user!.id, req.body);
    reply.code(201);
    return { id: r.org.id, name: r.org.name, slug: r.org.slug };
  });

  // Everything the page needs in one read: your organisations, invitations still waiting, and the latest alerts across all of them.
  app.get('/overview', { preHandler: [app.authenticate, ADMIN] }, async (req) => {
    const db = req.server.db;
    const { currentOrgId, rows } = await myOrganizations(db, req.user!.id);
    const orgIds = rows.map((r) => r.orgId); const userIds = rows.map((r) => r.userId);
    if (orgIds.length === 0) return { organizations: [], pendingInvites: [], notifications: [] };
    const uuids = (ids: string[]) => sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
    const rowsOf = <T,>(r: unknown) => r as unknown as T[];

    const [members, unread, invites, recent] = await Promise.all([
      db.select({ orgId: users.orgId, n: sql<number>`count(*)::int` }).from(users).where(and(inArray(users.orgId, orgIds), eq(users.active, true))).groupBy(users.orgId),
      db.execute(sql`
        select u.org_id, count(*)::int as n
        from notifications n join users u on u.org_id = n.org_id and u.id in (${uuids(userIds)})
        left join notification_reads r on r.notification_id = n.id and r.user_id = u.id
        where 'admin'::role = any(n.audience_roles) and r.read_at is null and n.created_at > now() - interval '60 days' group by u.org_id`),
      db.select({ id: userTokens.id, orgId: userTokens.orgId, orgName: organizations.name, email: userTokens.email, role: userTokens.role, createdAt: userTokens.createdAt, expiresAt: userTokens.expiresAt })
        .from(userTokens).innerJoin(organizations, eq(userTokens.orgId, organizations.id))
        .where(and(inArray(userTokens.orgId, orgIds), eq(userTokens.purpose, 'invite'), isNull(userTokens.usedAt), gt(userTokens.expiresAt, new Date())))
        .orderBy(desc(userTokens.createdAt)).limit(50),
      db.execute(sql`
        select n.id, n.org_id, o.name as org_name, n.type::text as type, n.title, n.body, n.created_at, (r.read_at is not null) as read
        from notifications n join users u on u.org_id = n.org_id and u.id in (${uuids(userIds)}) join organizations o on o.id = n.org_id
        left join notification_reads r on r.notification_id = n.id and r.user_id = u.id
        where 'admin'::role = any(n.audience_roles) and n.created_at > now() - interval '60 days'
        order by n.created_at desc limit 8`),
    ]);
    const memberOf = new Map(members.map((m) => [m.orgId, m.n])); const unreadOf = new Map(rowsOf<{ org_id: string; n: number }>(unread).map((u) => [u.org_id, u.n]));
    return {
      organizations: rows.map((r) => ({ id: r.orgId, name: r.name, slug: r.slug, current: r.orgId === currentOrgId, members: memberOf.get(r.orgId) ?? 0, unread: unreadOf.get(r.orgId) ?? 0, createdAt: r.createdAt.toISOString() })),
      pendingInvites: invites.map((i) => ({ id: i.id, orgId: i.orgId, orgName: i.orgName, email: i.email, role: i.role, createdAt: i.createdAt.toISOString(), expiresAt: i.expiresAt.toISOString() })),
      notifications: rowsOf<{ id: string; org_id: string; org_name: string; type: string; title: string; body: string; created_at: Date | string; read: boolean }>(recent)
        .map((n) => ({ id: n.id, orgId: n.org_id, orgName: n.org_name, type: n.type, title: n.title, body: n.body, read: n.read, createdAt: new Date(n.created_at).toISOString() })),
    };
  });
}
