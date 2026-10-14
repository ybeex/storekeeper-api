import type { ApiFastifyInstance } from '../../types.js';
/** People — the Holders who are individuals (PRD §8). Most never log in; `userId` links an optional account. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm';
import { people, custody, teamMembers, users } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { IdParams, PageQuery, Uuid, iso } from '../../lib/schemas.js';

const Create = Type.Object({
  fullName: Type.String({ minLength: 1, maxLength: 150 }),
  employeeCode: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  phone: Type.Optional(Type.String({ maxLength: 40 })),
  email: Type.Optional(Type.String({ format: 'email', maxLength: 254 })),
  userId: Type.Optional(Uuid),
}, { additionalProperties: false });
const Update = Type.Partial(Type.Intersect([Type.Omit(Create, ['userId']), Type.Object({ active: Type.Boolean() })]), { additionalProperties: false });
const List = Type.Object({ ...PageQuery, q: Type.Optional(Type.String({ maxLength: 100 })), active: Type.Optional(Type.Boolean()), includeArchived: Type.Optional(Type.Boolean()) });

const ser = (p: typeof people.$inferSelect) => ({
  id: p.id, fullName: p.fullName, employeeCode: p.employeeCode, phone: p.phone, email: p.email, userId: p.userId,
  active: p.active, archivedAt: iso(p.archivedAt), createdAt: p.createdAt.toISOString(),
});

const WRITERS = ['admin', 'supervisor', 'store_staff'] as const; // the storekeeper adds a worker at the counter

export async function peopleRoutes(app: ApiFastifyInstance) {
  app.post('/', { config: { idempotent: true }, preHandler: [app.authenticate, requireRole(...WRITERS)], schema: { body: Create } }, async (req, reply) => {
    const a = req.user!;
    try {
      const p = await req.server.db.transaction(async (tx) => {
        if (req.body.userId) {
          if (a.role !== 'admin') throw new ConflictError('FORBIDDEN_LINK', 'Only admins can link a person to a login account');
          const [u] = await tx.select({ id: users.id }).from(users).where(and(eq(users.id, req.body.userId), eq(users.orgId, a.orgId))).limit(1);
          if (!u) throw new NotFoundError('User');
        }
        const [row] = await tx.insert(people).values({ orgId: a.orgId, ...req.body }).returning();
        await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: 'person.created', entityType: 'person', entityId: row.id, next: ser(row) });
        return row;
      });
      reply.code(201); return ser(p);
    } catch (err) {
      if (isUniqueViolation(err, 'people_org_code_unique')) throw new ConflictError('EMPLOYEE_CODE_TAKEN', 'This employee code is already in use');
      if (isUniqueViolation(err, 'people_user_unique')) throw new ConflictError('USER_ALREADY_LINKED', 'This login is already linked to a person');
      throw err;
    }
  });

  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: List } }, async (req) => {
    const q = req.query; const limit = q.limit ?? 25;
    const needle = q.q ? `%${q.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    const rows = await req.server.db.select().from(people).where(and(
      eq(people.orgId, req.user!.orgId),
      q.includeArchived ? undefined : isNull(people.archivedAt),
      q.active !== undefined ? eq(people.active, q.active) : undefined,
      needle ? or(ilike(people.fullName, needle), ilike(people.employeeCode, needle), ilike(people.phone, needle)) : undefined,
      q.cursor ? keysetWhere(people.createdAt, people.id, q.cursor) : undefined,
    )).orderBy(desc(people.createdAt), desc(people.id)).limit(limit + 1);
    const page = toPage(rows, limit);
    return { items: page.items.map(ser), nextCursor: page.nextCursor };
  });

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => {
    const [p] = await req.server.db.select().from(people).where(and(eq(people.id, req.params.id), eq(people.orgId, req.user!.orgId))).limit(1);
    if (!p) throw new NotFoundError('Person');
    const [o] = await req.server.db.select({ n: sql<number>`count(*)::int` }).from(custody).where(and(eq(custody.holderPersonId, p.id), sql`${custody.quantity} > 0`));
    return { ...ser(p), outstandingLines: o.n };
  });

  app.patch('/:id', { preHandler: [app.authenticate, requireRole(...WRITERS)], schema: { params: IdParams, body: Update } }, async (req) => {
    const a = req.user!;
    try {
      const [p] = await req.server.db.update(people).set(req.body).where(and(eq(people.id, req.params.id), eq(people.orgId, a.orgId), isNull(people.archivedAt))).returning();
      if (!p) throw new NotFoundError('Person');
      await audit(req.server.db, { orgId: a.orgId, actorUserId: a.id, action: 'person.updated', entityType: 'person', entityId: p.id, next: req.body });
      return ser(p);
    } catch (err) {
      if (isUniqueViolation(err, 'people_org_code_unique')) throw new ConflictError('EMPLOYEE_CODE_TAKEN', 'This employee code is already in use');
      throw err;
    }
  });

  // Archiving a worker who still holds items would orphan accountability — refuse (PRD §2: every movement attributable).
  app.delete('/:id', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const a = req.user!;
    await req.server.db.transaction(async (tx) => {
      const [p] = await tx.select().from(people).where(and(eq(people.id, req.params.id), eq(people.orgId, a.orgId), isNull(people.archivedAt))).for('update').limit(1);
      if (!p) throw new NotFoundError('Person');
      const [o] = await tx.select({ n: sql<number>`count(*)::int` }).from(custody).where(and(eq(custody.holderPersonId, p.id), sql`${custody.quantity} > 0`));
      if (o.n > 0) throw new ConflictError('HOLDER_HAS_OUTSTANDING', 'This person still holds items; record their returns first', { outstandingLines: o.n });
      await tx.update(people).set({ archivedAt: new Date(), active: false }).where(eq(people.id, p.id));
      await tx.delete(teamMembers).where(eq(teamMembers.personId, p.id));
      await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: 'person.archived', entityType: 'person', entityId: p.id, previous: ser(p) });
    });
    reply.code(204);
  });
}
