/** Teams and departments (Holders, PRD §8) plus membership. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { teams, teamMembers, people, custody } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { IdParams, Uuid, iso } from '../../lib/schemas.js';

const Create = Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }), kind: Type.Optional(Type.Union([Type.Literal('team'), Type.Literal('department')])) }, { additionalProperties: false });
const Update = Type.Partial(Create, { additionalProperties: false });
const Members = Type.Object({ personIds: Type.Array(Uuid, { minItems: 1, maxItems: 500 }) }, { additionalProperties: false });
const ser = (t: typeof teams.$inferSelect) => ({ id: t.id, name: t.name, kind: t.kind, archivedAt: iso(t.archivedAt), createdAt: t.createdAt.toISOString() });
const MANAGE = requireRole('admin', 'supervisor');

export async function teamRoutes(app: FastifyInstance) {
  app.post('/', { config: { idempotent: true }, preHandler: [app.authenticate, MANAGE], schema: { body: Create } }, async (req, reply) => {
    const a = req.user!;
    const [t] = await req.server.db.insert(teams).values({ orgId: a.orgId, ...req.body }).returning();
    await audit(req.server.db, { orgId: a.orgId, actorUserId: a.id, action: 'team.created', entityType: 'team', entityId: t.id, next: ser(t) });
    reply.code(201); return ser(t);
  });

  app.get('/', { preHandler: [app.authenticate, anyRole] }, async (req) => {
    const rows = await req.server.db.select({
      t: teams, members: sql<number>`(select count(*)::int from team_members tm where tm.team_id = ${teams.id})`,
    }).from(teams).where(and(eq(teams.orgId, req.user!.orgId), isNull(teams.archivedAt))).orderBy(asc(teams.name)).limit(500);
    return { items: rows.map((r) => ({ ...ser(r.t), memberCount: r.members })) };
  });

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => {
    const [t] = await req.server.db.select().from(teams).where(and(eq(teams.id, req.params.id), eq(teams.orgId, req.user!.orgId))).limit(1);
    if (!t) throw new NotFoundError('Team');
    const members = await req.server.db.select({ id: people.id, fullName: people.fullName, employeeCode: people.employeeCode })
      .from(teamMembers).innerJoin(people, eq(teamMembers.personId, people.id)).where(eq(teamMembers.teamId, t.id)).orderBy(asc(people.fullName)).limit(1000);
    return { ...ser(t), members };
  });

  app.patch('/:id', { preHandler: [app.authenticate, MANAGE], schema: { params: IdParams, body: Update } }, async (req) => {
    const [t] = await req.server.db.update(teams).set(req.body).where(and(eq(teams.id, req.params.id), eq(teams.orgId, req.user!.orgId), isNull(teams.archivedAt))).returning();
    if (!t) throw new NotFoundError('Team');
    await audit(req.server.db, { orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'team.updated', entityType: 'team', entityId: t.id, next: req.body });
    return ser(t);
  });

  app.post('/:id/members', { preHandler: [app.authenticate, MANAGE], schema: { params: IdParams, body: Members } }, async (req) => {
    const a = req.user!; const ids = [...new Set(req.body.personIds)];
    return req.server.db.transaction(async (tx) => {
      const [t] = await tx.select({ id: teams.id }).from(teams).where(and(eq(teams.id, req.params.id), eq(teams.orgId, a.orgId), isNull(teams.archivedAt))).limit(1);
      if (!t) throw new NotFoundError('Team');
      const found = await tx.select({ id: people.id }).from(people).where(and(eq(people.orgId, a.orgId), inArray(people.id, ids), isNull(people.archivedAt)));
      if (found.length !== ids.length) throw new ValidationError('One or more people do not exist or are archived');
      await tx.insert(teamMembers).values(ids.map((personId) => ({ teamId: t.id, personId }))).onConflictDoNothing();
      await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: 'team.members_added', entityType: 'team', entityId: t.id, next: ids });
      return { added: ids.length };
    });
  });

  app.delete('/:id/members/:personId', {
    preHandler: [app.authenticate, MANAGE], schema: { params: Type.Object({ id: Uuid, personId: Uuid }), response: { 204: { type: 'null' } } },
  }, async (req, reply) => {
    const a = req.user!;
    const [t] = await req.server.db.select({ id: teams.id }).from(teams).where(and(eq(teams.id, req.params.id), eq(teams.orgId, a.orgId))).limit(1);
    if (!t) throw new NotFoundError('Team');
    await req.server.db.delete(teamMembers).where(and(eq(teamMembers.teamId, t.id), eq(teamMembers.personId, req.params.personId)));
    await audit(req.server.db, { orgId: a.orgId, actorUserId: a.id, action: 'team.member_removed', entityType: 'team', entityId: t.id, next: req.params.personId });
    reply.code(204);
  });

  app.delete('/:id', { preHandler: [app.authenticate, MANAGE], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const a = req.user!;
    await req.server.db.transaction(async (tx) => {
      const [t] = await tx.select().from(teams).where(and(eq(teams.id, req.params.id), eq(teams.orgId, a.orgId), isNull(teams.archivedAt))).for('update').limit(1);
      if (!t) throw new NotFoundError('Team');
      const [o] = await tx.select({ n: sql<number>`count(*)::int` }).from(custody).where(and(eq(custody.holderTeamId, t.id), sql`${custody.quantity} > 0`));
      if (o.n > 0) throw new ConflictError('HOLDER_HAS_OUTSTANDING', 'This team still holds items', { outstandingLines: o.n });
      await tx.update(teams).set({ archivedAt: new Date() }).where(eq(teams.id, t.id));
      await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: 'team.archived', entityType: 'team', entityId: t.id, previous: ser(t) });
    });
    reply.code(204);
  });
}
