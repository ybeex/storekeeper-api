import type { ApiFastifyInstance } from '../../types.js';
/** Locations (PRD §9). One active location per org at launch is an entitlement (org_settings.location_limit). */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { locations, orgSettings, stockLevels, items, custody } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { IdParams, Uuid, iso } from '../../lib/schemas.js';
import { allowedLocationIds, type Principal } from '../../lib/locations.js';

const Kind = Type.Union([Type.Literal('store'), Type.Literal('site'), Type.Literal('warehouse'), Type.Literal('area')]);
const Create = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }), code: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  kind: Type.Optional(Kind), parentId: Type.Optional(Uuid), address: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });
const Update = Type.Partial(Create, { additionalProperties: false });

const ser = (l: typeof locations.$inferSelect) => ({ id: l.id, name: l.name, code: l.code, kind: l.kind, parentId: l.parentId, address: l.address, archivedAt: iso(l.archivedAt), createdAt: l.createdAt.toISOString() });

async function create(db: Db, actor: Principal, input: typeof Create.static) {
  return db.transaction(async (tx) => {
    // Lock the settings row so two concurrent creates cannot both slip under the limit.
    const [s] = await tx.select({ lim: orgSettings.locationLimit }).from(orgSettings).where(eq(orgSettings.orgId, actor.orgId)).for('update').limit(1);
    const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(locations).where(and(eq(locations.orgId, actor.orgId), isNull(locations.archivedAt)));
    if (n >= (s?.lim ?? 1)) throw new ConflictError('LOCATION_LIMIT_REACHED', `Your plan allows ${s?.lim ?? 1} active location(s)`, { limit: s?.lim ?? 1 });
    if (input.parentId) {
      const [p] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.id, input.parentId), eq(locations.orgId, actor.orgId))).limit(1);
      if (!p) throw new ValidationError('parentId does not exist');
    }
    try {
      const [loc] = await tx.insert(locations).values({ orgId: actor.orgId, ...input }).returning();
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'location.created', entityType: 'location', entityId: loc.id, next: ser(loc) });
      return loc;
    } catch (err) {
      if (isUniqueViolation(err, 'locations_org_code_unique')) throw new ConflictError('LOCATION_CODE_TAKEN', 'A location with this code already exists');
      throw err;
    }
  });
}

async function archive(db: Db, actor: Principal, id: string) {
  await db.transaction(async (tx) => {
    const [loc] = await tx.select().from(locations).where(and(eq(locations.id, id), eq(locations.orgId, actor.orgId), isNull(locations.archivedAt))).for('update').limit(1);
    if (!loc) throw new NotFoundError('Location');
    const [stock] = await tx.select({ n: sql<number>`coalesce(sum(${stockLevels.quantity}),0)::int` }).from(stockLevels).where(eq(stockLevels.locationId, id));
    const [assets] = await tx.select({ n: sql<number>`count(*)::int` }).from(items).where(and(eq(items.locationId, id), eq(items.type, 'asset'), isNull(items.archivedAt)));
    const [out] = await tx.select({ n: sql<number>`count(*)::int` }).from(custody).where(and(eq(custody.locationId, id), sql`${custody.quantity} > 0`));
    if (stock.n > 0 || assets.n > 0 || out.n > 0) {
      throw new ConflictError('LOCATION_NOT_EMPTY', 'Move or retire stock, assets and outstanding checkouts before archiving this location', { stock: stock.n, assets: assets.n, outstanding: out.n });
    }
    await tx.update(locations).set({ archivedAt: new Date() }).where(eq(locations.id, id));
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'location.archived', entityType: 'location', entityId: id, previous: ser(loc) });
  });
}

export async function locationRoutes(app: ApiFastifyInstance) {
  app.get('/', { preHandler: [app.authenticate, anyRole] }, async (req) => {
    const allowed = await allowedLocationIds(req.server.db, req.user!);
    const rows = await req.server.db.select().from(locations).where(and(eq(locations.orgId, req.user!.orgId), isNull(locations.archivedAt))).orderBy(asc(locations.createdAt));
    return { items: rows.filter((r) => !allowed || allowed.includes(r.id)).map(ser) };
  });
  app.post('/', { config: { idempotent: true }, preHandler: [app.authenticate, requireRole('admin')], schema: { body: Create } }, async (req, reply) => {
    reply.code(201); return ser(await create(req.server.db, req.user!, req.body));
  });
  app.patch('/:id', { preHandler: [app.authenticate, requireRole('admin')], schema: { params: IdParams, body: Update } }, async (req) => {
    const [loc] = await req.server.db.update(locations).set(req.body).where(and(eq(locations.id, req.params.id), eq(locations.orgId, req.user!.orgId), isNull(locations.archivedAt))).returning();
    if (!loc) throw new NotFoundError('Location');
    await audit(req.server.db, { orgId: req.user!.orgId, actorUserId: req.user!.id, action: 'location.updated', entityType: 'location', entityId: loc.id, next: req.body });
    return ser(loc);
  });
  app.delete('/:id', { preHandler: [app.authenticate, requireRole('admin')], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    await archive(req.server.db, req.user!, req.params.id); reply.code(204);
  });
}
