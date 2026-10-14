import type { ApiFastifyInstance } from '../../types.js';
/** Categories: sit under exactly one shelf; every item sits under exactly one category. Created separately from shelves. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { categories, items, shelves } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { allowedLocationIds, assertLocationAccess } from '../../lib/locations.js';
import { IdParams, Uuid, iso } from '../../lib/schemas.js';
import { ColorField, IconField } from '../../lib/appearance.js';
import { categoryStats, EMPTY_STATS } from '../shelves/stats.js';

const NullableInt = (min: number, max: number) => Type.Optional(Type.Union([Type.Integer({ minimum: min, maximum: max }), Type.Null()]));
const Create = Type.Object({
  shelfId: Uuid, name: Type.String({ minLength: 1, maxLength: 100 }),
  defaultMinThreshold: NullableInt(0, 1_000_000), defaultExpectedReturnHours: NullableInt(1, 24 * 365), color: ColorField, icon: IconField,
}, { additionalProperties: false });
const Update = Type.Partial(Create, { additionalProperties: false, minProperties: 1 });

const ser = (c: typeof categories.$inferSelect) => ({ id: c.id, shelfId: c.shelfId, name: c.name, color: c.color, icon: c.icon, defaultMinThreshold: c.defaultMinThreshold, defaultExpectedReturnHours: c.defaultExpectedReturnHours, archivedAt: iso(c.archivedAt) });
const taken = (e: unknown): never => { if (isUniqueViolation(e, 'categories_shelf_name_unique')) throw new ConflictError('CATEGORY_EXISTS', 'This shelf already has a category with that name'); throw e; };

async function activeShelf(tx: Db, orgId: string, shelfId: string) {
  const [s] = await tx.select().from(shelves).where(and(eq(shelves.id, shelfId), eq(shelves.orgId, orgId), isNull(shelves.archivedAt))).limit(1);
  if (!s) throw new ValidationError('shelfId does not exist (create the shelf first)');
  return s;
}

export async function categoryRoutes(app: ApiFastifyInstance) {
  const ADMIN = requireRole('admin');

  app.post('/', { config: { idempotent: true }, preHandler: [app.authenticate, ADMIN], schema: { body: Create } }, async (req, reply) => {
    const a = req.user!;
    try {
      const c = await req.server.db.transaction(async (tx) => {
        const shelf = await activeShelf(tx as never, a.orgId, req.body.shelfId);
        await assertLocationAccess(tx as never, a, shelf.locationId);
        const [row] = await tx.insert(categories).values({ orgId: a.orgId, ...req.body, name: req.body.name.trim() }).returning();
        await audit(tx as never, { orgId: a.orgId, actorUserId: a.id, action: 'category.created', entityType: 'category', entityId: row.id, next: ser(row) });
        return row;
      });
      reply.code(201); return { ...ser(c), stats: EMPTY_STATS };
    } catch (e) { return taken(e); }
  });

  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({ shelfId: Type.Optional(Uuid) }) } }, async (req) => {
    const a = req.user!; const allowed = await allowedLocationIds(req.server.db, a);
    const rows = await req.server.db.select({ c: categories, shelfName: shelves.name, shelfColor: shelves.color, shelfIcon: shelves.icon, locationId: shelves.locationId }).from(categories).innerJoin(shelves, eq(categories.shelfId, shelves.id))
      .where(and(eq(categories.orgId, a.orgId), isNull(categories.archivedAt), req.query.shelfId ? eq(categories.shelfId, req.query.shelfId) : undefined, allowed ? inArray(shelves.locationId, allowed) : undefined))
      .orderBy(asc(shelves.sortOrder), asc(categories.name)).limit(1000);
    const stats = await categoryStats(req.server.db, a.orgId, { shelfId: req.query.shelfId });
    return { items: rows.map((r) => ({ ...ser(r.c), shelfName: r.shelfName, shelfColor: r.shelfColor, shelfIcon: r.shelfIcon, locationId: r.locationId, stats: stats.get(r.c.id) ?? EMPTY_STATS })) };
  });

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => {
    const a = req.user!;
    const [r] = await req.server.db.select({ c: categories, shelfName: shelves.name, shelfColor: shelves.color, shelfIcon: shelves.icon, locationId: shelves.locationId }).from(categories).innerJoin(shelves, eq(categories.shelfId, shelves.id))
      .where(and(eq(categories.id, req.params.id), eq(categories.orgId, a.orgId))).limit(1);
    if (!r) throw new NotFoundError('Category');
    await assertLocationAccess(req.server.db, a, r.locationId);
    const stats = await categoryStats(req.server.db, a.orgId, { categoryId: r.c.id });
    return { ...ser(r.c), shelfName: r.shelfName, shelfColor: r.shelfColor, shelfIcon: r.shelfIcon, locationId: r.locationId, stats: stats.get(r.c.id) ?? EMPTY_STATS };
  });

  // Includes MOVING a category to another shelf — allowed only within the same location, because its items'
  // home location comes from the shelf they sit on.
  app.patch('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, body: Update } }, async (req) => {
    const a = req.user!;
    try {
      return await req.server.db.transaction(async (tx0) => {
        const tx = tx0 as unknown as Db;
        const [cur] = await tx.select({ c: categories, locationId: shelves.locationId }).from(categories).innerJoin(shelves, eq(categories.shelfId, shelves.id))
          .where(and(eq(categories.id, req.params.id), eq(categories.orgId, a.orgId), isNull(categories.archivedAt))).for('update', { of: categories }).limit(1);
        if (!cur) throw new NotFoundError('Category');
        if (req.body.shelfId && req.body.shelfId !== cur.c.shelfId) {
          const dest = await activeShelf(tx, a.orgId, req.body.shelfId);
          if (dest.locationId !== cur.locationId) throw new ConflictError('CROSS_LOCATION_MOVE', 'A category can only move between shelves in the same location');
        }
        const [row] = await tx.update(categories).set({ ...req.body, name: req.body.name?.trim() }).where(eq(categories.id, cur.c.id)).returning();
        await audit(tx, { orgId: a.orgId, actorUserId: a.id, action: req.body.shelfId && req.body.shelfId !== cur.c.shelfId ? 'category.moved' : 'category.updated', entityType: 'category', entityId: row.id, previous: ser(cur.c), next: ser(row) });
        return ser(row);
      });
    } catch (e) { return taken(e); }
  });

  app.delete('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const a = req.user!;
    await req.server.db.transaction(async (tx) => {
      const [c] = await tx.select().from(categories).where(and(eq(categories.id, req.params.id), eq(categories.orgId, a.orgId), isNull(categories.archivedAt))).for('update').limit(1);
      if (!c) throw new NotFoundError('Category');
      const [u] = await tx.select({ n: sql<number>`count(*)::int` }).from(items).where(and(eq(items.categoryId, c.id), isNull(items.archivedAt)));
      if (u.n > 0) throw new ConflictError('CATEGORY_IN_USE', 'Move or archive the items in this category first', { items: u.n });
      await tx.update(categories).set({ archivedAt: new Date() }).where(eq(categories.id, c.id));
      await audit(tx as never, { orgId: a.orgId, actorUserId: a.id, action: 'category.archived', entityType: 'category', entityId: c.id, previous: ser(c) });
    });
    reply.code(204);
  });
}
