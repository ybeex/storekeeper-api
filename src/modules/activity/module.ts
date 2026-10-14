import type { ApiFastifyInstance } from '../../types.js';
/**
 * Activity feed + holder search — the two read APIs the UI kit's home screen leans on.
 *  - GET /activity : "Ben checked out Angle grinder 12 to Electrical team · 09:12" (ledger, enriched, human-ready)
 *  - GET /holders  : one search box for "John Okafor | Electrical team | Project Alpha" (people + teams + jobs)
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, gte, ilike, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { categories, custody, items, jobs, people, shelves, teams, transactions, users } from '../../db/schema.js';
import { anyRole } from '../../plugins/rbac.js';
import { allowedLocationIds } from '../../lib/locations.js';
import { ValidationError } from '../../lib/errors.js';
import { Uuid } from '../../lib/schemas.js';
import { ownActivityOnly } from '../../lib/scope.js';

const Q = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })), cursor: Type.Optional(Type.String({ maxLength: 40 })),
  type: Type.Optional(Type.String({ maxLength: 40 })), actorUserId: Type.Optional(Uuid), itemId: Type.Optional(Uuid), categoryId: Type.Optional(Uuid), shelfId: Type.Optional(Uuid),
  locationId: Type.Optional(Uuid), holderType: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('team'), Type.Literal('job')])), holderId: Type.Optional(Uuid),
  jobId: Type.Optional(Uuid), from: Type.Optional(Type.String({ format: 'date-time' })), to: Type.Optional(Type.String({ format: 'date-time' })),
});

export async function activityRoutes(app: ApiFastifyInstance) {
  app.get('/activity', { preHandler: [app.authenticate, anyRole], schema: { querystring: Q } }, async (req) => {
    const a = req.user!; const q = req.query; const limit = q.limit ?? 30;
    const actorFilter = ownActivityOnly(a) ?? q.actorUserId; // store staff are pinned to their own actions
    if (!!q.holderType !== !!q.holderId) throw new ValidationError('holderType and holderId must be provided together');
    const allowed = await allowedLocationIds(req.server.db, a);
    let after: number | undefined;
    if (q.cursor) { after = Number(q.cursor); if (!Number.isSafeInteger(after)) throw new ValidationError('Malformed cursor'); }
    const holderCol = q.holderType === 'person' ? transactions.holderPersonId : q.holderType === 'team' ? transactions.holderTeamId : transactions.holderJobId;
    const rows = await req.server.db.select({
      t: transactions, itemName: items.name, sku: items.sku, assetTag: items.assetTag, unit: items.unit,
      categoryName: categories.name, shelfName: shelves.name,
      actorName: sql<string>`coalesce(${users.fullName}, split_part(${users.email}, '@', 1))`,
      holderName: sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`,
      jobName: sql<string | null>`(select j.name from jobs j where j.id = ${transactions.jobId})`,
    }).from(transactions).innerJoin(items, eq(transactions.itemId, items.id)).innerJoin(categories, eq(items.categoryId, categories.id)).innerJoin(shelves, eq(categories.shelfId, shelves.id))
      .innerJoin(users, eq(transactions.actorUserId, users.id))
      .leftJoin(people, eq(transactions.holderPersonId, people.id)).leftJoin(teams, eq(transactions.holderTeamId, teams.id)).leftJoin(jobs, eq(transactions.holderJobId, jobs.id))
      .where(and(eq(transactions.orgId, a.orgId),
        q.type ? sql`${transactions.type}::text = ${q.type}` : undefined, actorFilter ? eq(transactions.actorUserId, actorFilter) : undefined, q.itemId ? eq(transactions.itemId, q.itemId) : undefined,
        q.categoryId ? eq(items.categoryId, q.categoryId) : undefined, q.shelfId ? eq(categories.shelfId, q.shelfId) : undefined, q.locationId ? eq(transactions.locationId, q.locationId) : undefined,
        q.holderType && q.holderId ? eq(holderCol, q.holderId) : undefined, q.jobId ? eq(transactions.jobId, q.jobId) : undefined,
        q.from ? gte(transactions.occurredAt, new Date(q.from)) : undefined, q.to ? lte(transactions.occurredAt, new Date(q.to)) : undefined,
        allowed ? inArray(transactions.locationId, allowed) : undefined, after !== undefined ? lt(transactions.seq, after) : undefined))
      .orderBy(desc(transactions.seq)).limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        id: r.t.id, seq: r.t.seq, type: r.t.type, occurredAt: r.t.occurredAt.toISOString(), recordedAt: r.t.createdAt.toISOString(),
        actor: { id: r.t.actorUserId, name: r.actorName },
        item: { id: r.t.itemId, name: r.itemName, sku: r.sku, assetTag: r.assetTag, type: r.t.itemType, category: r.categoryName, shelf: r.shelfName },
        quantity: r.t.quantity, unit: r.unit, holder: r.t.holderType ? { type: r.t.holderType, id: r.t.holderPersonId ?? r.t.holderTeamId ?? r.t.holderJobId, name: r.holderName } : null,
        job: r.t.jobId ? { id: r.t.jobId, name: r.jobName } : null, condition: r.t.condition, fromStatus: r.t.fromStatus, toStatus: r.t.toStatus, reason: r.t.reason, note: r.t.note,
        savedOffline: r.t.source === 'offline_sync', needsAttention: r.t.type === 'loss' || r.t.type === 'damage' || r.t.condition === 'damaged',
      })),
      nextCursor: rows.length > limit ? String(page.at(-1)!.t.seq) : null,
    };
  });

  // One box → people, teams/departments and jobs, each with what they currently hold.
  app.get('/holders', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({
    q: Type.Optional(Type.String({ maxLength: 100 })), type: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('team'), Type.Literal('job')])), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 10 })),
  }) } }, async (req) => {
    const a = req.user!; const db = req.server.db; const lim = req.query.limit ?? 10; const t = req.query.type;
    const needle = req.query.q ? `%${req.query.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    const [pp, tt, jj] = await Promise.all([
      t && t !== 'person' ? [] : db.select({ id: people.id, name: people.fullName, code: people.employeeCode }).from(people)
        .where(and(eq(people.orgId, a.orgId), isNull(people.archivedAt), eq(people.active, true), needle ? or(ilike(people.fullName, needle), ilike(people.employeeCode, needle)) : undefined)).orderBy(people.fullName).limit(lim),
      t && t !== 'team' ? [] : db.select({ id: teams.id, name: teams.name, kind: teams.kind }).from(teams)
        .where(and(eq(teams.orgId, a.orgId), isNull(teams.archivedAt), needle ? ilike(teams.name, needle) : undefined)).orderBy(teams.name).limit(lim),
      t && t !== 'job' ? [] : db.select({ id: jobs.id, name: jobs.name, code: jobs.code, kind: jobs.kind }).from(jobs)
        .where(and(eq(jobs.orgId, a.orgId), isNull(jobs.archivedAt), needle ? or(ilike(jobs.name, needle), ilike(jobs.code, needle)) : undefined)).orderBy(jobs.name).limit(lim),
    ]);
    const keys = [...pp.map((p) => `person:${p.id}`), ...tt.map((x) => `team:${x.id}`), ...jj.map((j) => `job:${j.id}`)];
    const counts = keys.length ? await db.select({ k: custody.holderKey, lines: sql<number>`count(*)::int`, overdue: sql<number>`count(*) filter (where ${custody.dueAt} < now())::int` })
      .from(custody).where(and(eq(custody.orgId, a.orgId), sql`${custody.quantity} > 0`, inArray(custody.holderKey, keys))).groupBy(custody.holderKey) : [];
    const by = new Map(counts.map((c) => [c.k, c]));
    const decorate = <T extends { id: string }>(type: string, r: T) => ({ type, ...r, outstandingLines: by.get(`${type}:${r.id}`)?.lines ?? 0, overdueLines: by.get(`${type}:${r.id}`)?.overdue ?? 0 });
    return { items: [...pp.map((p) => decorate('person', p)), ...tt.map((x) => decorate('team', x)), ...jj.map((j) => decorate('job', j))] };
  });
}
