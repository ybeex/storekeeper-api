/** Shelves: the top of the browse hierarchy (shelf → category → item). Created separately from categories. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { categories, shelves } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { allowedLocationIds, assertLocationAccess, resolveLocationId } from '../../lib/locations.js';
import { IdParams, Uuid, iso } from '../../lib/schemas.js';
import { ColorField, IconField } from '../../lib/appearance.js';
import { addStats, categoryStats, EMPTY_STATS } from './stats.js';

const Create = Type.Object({
  locationId: Type.Optional(Uuid), name: Type.String({ minLength: 1, maxLength: 100 }), code: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  description: Type.Optional(Type.String({ maxLength: 500 })), color: ColorField, icon: IconField, sortOrder: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
}, { additionalProperties: false });
// The location is deliberately not patchable: items inherit their home location from their shelf.
const Update = Type.Partial(Type.Omit(Create, ['locationId']), { additionalProperties: false, minProperties: 1 });

type Shelf = typeof shelves.$inferSelect;
const ser = (s: Shelf) => ({ id: s.id, locationId: s.locationId, name: s.name, code: s.code, description: s.description, color: s.color, icon: s.icon, sortOrder: s.sortOrder, archivedAt: iso(s.archivedAt), createdAt: s.createdAt.toISOString() });
const dup = (e: unknown): never => {
  if (isUniqueViolation(e, 'shelves_location_name_unique')) throw new ConflictError('SHELF_EXISTS', 'A shelf with this name already exists in this location');
  if (isUniqueViolation(e, 'shelves_org_code_unique')) throw new ConflictError('SHELF_CODE_TAKEN', 'This shelf code is already in use');
  throw e;
};

export async function shelfRoutes(app: FastifyInstance) {
  const ADMIN = requireRole('admin');

  app.post('/', { config: { idempotent: true }, preHandler: [app.authenticate, ADMIN], schema: { body: Create } }, async (req, reply) => {
    const a = req.user!;
    try {
      const s = await req.server.db.transaction(async (tx) => {
        const locationId = await resolveLocationId(tx as never, a, req.body.locationId);
        const [row] = await tx.insert(shelves).values({ orgId: a.orgId, locationId, name: req.body.name.trim(), code: req.body.code, description: req.body.description, color: req.body.color ?? null, icon: req.body.icon ?? null, sortOrder: req.body.sortOrder ?? 0 }).returning();
        await audit(tx as never, { orgId: a.orgId, actorUserId: a.id, action: 'shelf.created', entityType: 'shelf', entityId: row.id, next: ser(row) });
        return row;
      });
      reply.code(201); return { ...ser(s), categoryCount: 0, stats: EMPTY_STATS };
    } catch (e) { return dup(e); }
  });

  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({ locationId: Type.Optional(Uuid) }) } }, async (req) => {
    const a = req.user!; const allowed = await allowedLocationIds(req.server.db, a);
    const rows = await req.server.db.select().from(shelves).where(and(
      eq(shelves.orgId, a.orgId), isNull(shelves.archivedAt), req.query.locationId ? eq(shelves.locationId, req.query.locationId) : undefined,
      allowed ? inArray(shelves.locationId, allowed) : undefined)).orderBy(asc(shelves.sortOrder), asc(shelves.name)).limit(500);
    const cats = rows.length ? await req.server.db.select({ id: categories.id, shelfId: categories.shelfId }).from(categories).where(and(eq(categories.orgId, a.orgId), isNull(categories.archivedAt), inArray(categories.shelfId, rows.map((r) => r.id)))) : [];
    const stats = await categoryStats(req.server.db, a.orgId);
    return { items: rows.map((s) => {
      const mine = cats.filter((c) => c.shelfId === s.id);
      return { ...ser(s), categoryCount: mine.length, stats: mine.reduce((acc, c) => addStats(acc, stats.get(c.id) ?? EMPTY_STATS), EMPTY_STATS) };
    }) };
  });

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => {
    const a = req.user!;
    const [s] = await req.server.db.select().from(shelves).where(and(eq(shelves.id, req.params.id), eq(shelves.orgId, a.orgId))).limit(1);
    if (!s) throw new NotFoundError('Shelf');
    await assertLocationAccess(req.server.db, a, s.locationId);
    const cats = await req.server.db.select().from(categories).where(and(eq(categories.shelfId, s.id), isNull(categories.archivedAt))).orderBy(asc(categories.name));
    const stats = await categoryStats(req.server.db, a.orgId, { shelfId: s.id });
    return { ...ser(s), categories: cats.map((c) => ({ id: c.id, name: c.name, color: c.color, icon: c.icon, defaultMinThreshold: c.defaultMinThreshold, defaultExpectedReturnHours: c.defaultExpectedReturnHours, stats: stats.get(c.id) ?? EMPTY_STATS })),
      stats: cats.reduce((acc, c) => addStats(acc, stats.get(c.id) ?? EMPTY_STATS), EMPTY_STATS) };
  });

  app.patch('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, body: Update } }, async (req) => {
    const a = req.user!;
    try {
      const [s] = await req.server.db.update(shelves).set(req.body).where(and(eq(shelves.id, req.params.id), eq(shelves.orgId, a.orgId), isNull(shelves.archivedAt))).returning();
      if (!s) throw new NotFoundError('Shelf');
      await audit(req.server.db, { orgId: a.orgId, actorUserId: a.id, action: 'shelf.updated', entityType: 'shelf', entityId: s.id, next: req.body });
      return ser(s);
    } catch (e) { return dup(e); }
  });

  app.delete('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const a = req.user!;
    await req.server.db.transaction(async (tx) => {
      const [s] = await tx.select().from(shelves).where(and(eq(shelves.id, req.params.id), eq(shelves.orgId, a.orgId), isNull(shelves.archivedAt))).for('update').limit(1);
      if (!s) throw new NotFoundError('Shelf');
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(categories).where(and(eq(categories.shelfId, s.id), isNull(categories.archivedAt)));
      if (n.n > 0) throw new ConflictError('SHELF_NOT_EMPTY', 'Move or archive this shelf\'s categories first', { categories: n.n });
      await tx.update(shelves).set({ archivedAt: new Date() }).where(eq(shelves.id, s.id));
      await audit(tx as never, { orgId: a.orgId, actorUserId: a.id, action: 'shelf.archived', entityType: 'shelf', entityId: s.id, previous: ser(s) });
    });
    reply.code(204);
  });
}
