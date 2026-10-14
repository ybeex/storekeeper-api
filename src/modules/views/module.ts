import type { ApiFastifyInstance } from '../../types.js';
/** Operational views: dashboard, outstanding items, low stock (PRD §26, §27, §28; backlog OPS/DASH). */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { approvalRequests, categories, custody, items, jobs, orgSettings, people, reconciliationCounts, reconciliationSessions, stockLevels, syncConflicts, teams, transactions } from '../../db/schema.js';
import { anyRole, requireRole } from '../../plugins/rbac.js';
import type { Db } from '../../db/index.js';
import type { Principal } from '../../lib/locations.js';
import { cached, scopeKey } from '../../lib/cache.js';
import { allowedLocationIds } from '../../lib/locations.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { PageQuery, Uuid } from '../../lib/schemas.js';
import { ValidationError } from '../../lib/errors.js';

const holderName = sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`;

export async function viewRoutes(app: ApiFastifyInstance) {
  app.get('/outstanding', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({
    ...PageQuery, holderType: Type.Optional(Type.Union([Type.Literal('person'), Type.Literal('team'), Type.Literal('job')])), holderId: Type.Optional(Uuid),
    itemId: Type.Optional(Uuid), locationId: Type.Optional(Uuid), overdue: Type.Optional(Type.Boolean()), type: Type.Optional(Type.Union([Type.Literal('asset'), Type.Literal('consumable')])),
  }) } }, async (req) => {
    const a = req.user!; const q = req.query; const limit = q.limit ?? 25;
    if (!!q.holderType !== !!q.holderId) throw new ValidationError('holderType and holderId must be provided together');
    const allowed = await allowedLocationIds(req.server.db, a);
    const rows = await req.server.db.select({
      c: custody, itemName: items.name, sku: items.sku, itemType: items.type, assetTag: items.assetTag, holder: holderName, jobName: sql<string | null>`(select j.name from jobs j where j.id = ${custody.jobId})`,
    }).from(custody).innerJoin(items, eq(custody.itemId, items.id))
      .leftJoin(people, eq(custody.holderPersonId, people.id)).leftJoin(teams, eq(custody.holderTeamId, teams.id)).leftJoin(jobs, eq(custody.holderJobId, jobs.id))
      .where(and(eq(custody.orgId, a.orgId), sql`${custody.quantity} > 0`,
        q.holderType && q.holderId ? eq(custody.holderKey, `${q.holderType}:${q.holderId}`) : undefined, q.itemId ? eq(custody.itemId, q.itemId) : undefined,
        q.locationId ? eq(custody.locationId, q.locationId) : undefined, q.type ? eq(items.type, q.type) : undefined,
        q.overdue ? sql`${custody.dueAt} < now()` : undefined, allowed ? inArray(custody.locationId, allowed) : undefined,
        q.cursor ? keysetWhere(custody.checkedOutAt, custody.id, q.cursor) : undefined))
      .orderBy(desc(custody.checkedOutAt), desc(custody.id)).limit(limit + 1);
    const p = toPage(rows.map((r) => ({ ...r, createdAt: r.c.checkedOutAt, id: r.c.id })), limit);
    return { items: p.items.map((r) => ({
      id: r.c.id, itemId: r.c.itemId, itemName: r.itemName, sku: r.sku, assetTag: r.assetTag, itemType: r.itemType, quantity: r.c.quantity,
      holder: { type: r.c.holderType, id: r.c.holderPersonId ?? r.c.holderTeamId ?? r.c.holderJobId, name: r.holder }, job: r.c.jobId ? { id: r.c.jobId, name: r.jobName } : null,
      locationId: r.c.locationId, checkedOutAt: r.c.checkedOutAt.toISOString(), dueAt: r.c.dueAt?.toISOString() ?? null,
      issuedQuantity: r.c.issuedQuantity, overdue: !!(r.c.dueAt && r.c.dueAt < new Date()),
      overdueDays: r.c.dueAt && r.c.dueAt < new Date() ? Math.max(1, Math.floor((Date.now() - r.c.dueAt.getTime()) / 86_400_000)) : 0,
      // UI kit status language: "Overdue" · "On time" · "Partial return"
      state: r.c.dueAt && r.c.dueAt < new Date() ? 'overdue' : r.c.quantity < r.c.issuedQuantity ? 'partial_return' : 'on_time',
    })), nextCursor: p.nextCursor };
  });

  app.get('/low-stock', { preHandler: [app.authenticate, anyRole], schema: { querystring: Type.Object({ locationId: Type.Optional(Uuid) }) } }, async (req) => {
    const a = req.user!;
    const allowed = await allowedLocationIds(req.server.db, a);
    const locs = req.query.locationId ? [req.query.locationId] : allowed;
    const locFilter = locs ? sql` and sl.location_id in (${sql.join(locs.map((l) => sql`${l}::uuid`), sql`, `)})` : sql``;
    const stock = sql<number>`coalesce((select sum(sl.quantity) from stock_levels sl where sl.item_id = ${items.id}${locFilter}), 0)::int`;
    const thr = sql<number>`coalesce(${items.minThreshold}, ${categories.defaultMinThreshold})`;
    const rows = await req.server.db.select({ i: items, stock, thr }).from(items).leftJoin(categories, eq(items.categoryId, categories.id))
      .where(and(eq(items.orgId, a.orgId), eq(items.type, 'consumable'), isNull(items.archivedAt), sql`${thr} is not null`, sql`${stock} <= ${thr}`))
      .orderBy(sql`(${stock}::float / nullif(${thr}, 0)) asc nulls first`).limit(500);
    return { items: rows.map((r) => ({ itemId: r.i.id, name: r.i.name, sku: r.i.sku, unit: r.i.unit, quantityAvailable: r.stock, minThreshold: r.thr, reorderQuantity: r.i.reorderQuantity, outOfStock: r.stock === 0 })) };
  });

  // The dashboard is for people who run or review the store. Store staff record movements and do not get it.
  const DASH = requireRole('admin', 'supervisor', 'viewer');

  app.get('/dashboard', { preHandler: [app.authenticate, DASH], schema: { querystring: Type.Object({ locationId: Type.Optional(Uuid) }) } }, async (req) => {
    const a = req.user!;
    const allowed = await allowedLocationIds(req.server.db, a);
    const locs = req.query.locationId ? [req.query.locationId] : allowed;
    const privileged = a.role === 'admin' || a.role === 'supervisor';
    // Many people keep this open and it re-polls: share one answer across them for a few seconds.
    return cached(req.server, a.orgId, `dash:${privileged ? 'p' : 'v'}:${scopeKey(locs)}`, 15, () => dashboardData(req.server.dbRead, a, locs, privileged));
  });

  app.get('/dashboard/analytics', { preHandler: [app.authenticate, DASH], schema: { querystring: Type.Object({ days: Type.Optional(Type.Integer({ minimum: 7, maximum: 90, default: 14 })), locationId: Type.Optional(Uuid) }) } }, async (req) => {
    const a = req.user!;
    const days = req.query.days ?? 14;
    const allowed = await allowedLocationIds(req.server.db, a);
    const locs = req.query.locationId ? [req.query.locationId] : allowed;
    return cached(req.server, a.orgId, `dash-an:${days}:${scopeKey(locs)}`, 60, () => dashboardAnalytics(req.server.dbRead, a, locs, days));
  });
}

/** The tiles and the recent-activity strip. */
async function dashboardData(db: Db, a: Principal, locs: string[] | null, privileged: boolean) {
    const inLocs = (col: Parameters<typeof inArray>[0]) => (locs ? inArray(col, locs) : undefined);
    const stock = sql<number>`coalesce((select sum(sl.quantity) from stock_levels sl where sl.item_id = ${items.id}${locs ? sql` and sl.location_id in (${sql.join(locs.map((l) => sql`${l}::uuid`), sql`, `)})` : sql``}), 0)::int`;
    const thr = sql<number | null>`coalesce(${items.minThreshold}, ${categories.defaultMinThreshold})`;

    const [{ tz }] = await db.select({ tz: orgSettings.timezone }).from(orgSettings).where(eq(orgSettings.orgId, a.orgId)).limit(1);
    // "Today" is the organisation's calendar day, not the server's: midnight in the org zone, expressed as an instant.
    const startOfToday = sql`(date_trunc('day', now() at time zone ${tz}) at time zone ${tz})`;

    const [assets, consumables, lowStock, outstanding, overdue, pending, conflicts, openRecon, recent, today, discrepancies] = await Promise.all([
      db.select({ s: items.assetStatus, n: sql<number>`count(*)::int` }).from(items).where(and(eq(items.orgId, a.orgId), eq(items.type, 'asset'), isNull(items.archivedAt), inLocs(items.locationId))).groupBy(items.assetStatus),
      db.select({ n: sql<number>`count(*)::int` }).from(items).where(and(eq(items.orgId, a.orgId), eq(items.type, 'consumable'), isNull(items.archivedAt))),
      db.select({ n: sql<number>`count(*)::int`, out: sql<number>`count(*) filter (where ${stock} = 0)::int` }).from(items).leftJoin(categories, eq(items.categoryId, categories.id))
        .where(and(eq(items.orgId, a.orgId), eq(items.type, 'consumable'), isNull(items.archivedAt), sql`${thr} is not null`, sql`${stock} <= ${thr}`)),
      db.select({ lines: sql<number>`count(*)::int`, holders: sql<number>`count(distinct ${custody.holderKey})::int` }).from(custody).where(and(eq(custody.orgId, a.orgId), sql`${custody.quantity} > 0`, inLocs(custody.locationId))),
      db.select({ n: sql<number>`count(*)::int` }).from(custody).where(and(eq(custody.orgId, a.orgId), sql`${custody.quantity} > 0`, sql`${custody.dueAt} < now()`, inLocs(custody.locationId))),
      privileged ? db.select({ n: sql<number>`count(*)::int` }).from(approvalRequests).where(and(eq(approvalRequests.orgId, a.orgId), eq(approvalRequests.status, 'pending'))) : Promise.resolve([{ n: 0 }]),
      privileged ? db.select({ n: sql<number>`count(*)::int` }).from(syncConflicts).where(and(eq(syncConflicts.orgId, a.orgId), eq(syncConflicts.status, 'open'))) : Promise.resolve([{ n: 0 }]),
      db.select({ n: sql<number>`count(*)::int` }).from(reconciliationSessions).where(and(eq(reconciliationSessions.orgId, a.orgId), eq(reconciliationSessions.status, 'open'), inLocs(reconciliationSessions.locationId))),
      db.select({ t: transactions, name: items.name }).from(transactions).innerJoin(items, eq(transactions.itemId, items.id)).where(and(eq(transactions.orgId, a.orgId), inLocs(transactions.locationId))).orderBy(desc(transactions.seq)).limit(10),
      db.select({ n: sql<number>`count(*)::int` }).from(transactions).where(and(eq(transactions.orgId, a.orgId), sql`${transactions.occurredAt} >= ${startOfToday}`, inLocs(transactions.locationId))),
      // PRD §29 "Discrepancies": count variances from the last 30 days; `open` = no adjustment has been applied to them yet.
      db.select({ total: sql<number>`count(*)::int`, open: sql<number>`count(*) filter (where ${reconciliationCounts.linkedAdjustmentTransactionId} is null)::int` })
        .from(reconciliationCounts).innerJoin(reconciliationSessions, eq(reconciliationCounts.sessionId, reconciliationSessions.id))
        .where(and(eq(reconciliationSessions.orgId, a.orgId), sql`${reconciliationCounts.variance} <> 0`, sql`${reconciliationCounts.createdAt} > now() - interval '30 days'`, inLocs(reconciliationSessions.locationId))),
    ]);
    return {
      assets: Object.fromEntries(assets.map((r) => [r.s, r.n])), consumableLines: consumables[0].n,
      lowStock: lowStock[0].n, outOfStock: lowStock[0].out, outstandingLines: outstanding[0].lines, holdersWithItems: outstanding[0].holders, overdue: overdue[0].n,
      transactionsToday: today[0].n, timezone: tz, discrepancies30d: discrepancies[0].total, discrepanciesOpen: discrepancies[0].open,
      pendingApprovals: pending[0].n, openSyncConflicts: conflicts[0].n, openReconciliations: openRecon[0].n,
      recentActivity: recent.map((r) => ({ id: r.t.id, type: r.t.type, itemId: r.t.itemId, itemName: r.name, quantity: r.t.quantity, occurredAt: r.t.occurredAt.toISOString() })),
    };
}

/** Trends and breakdowns for the dashboard's analytics section. Every query is bounded by the window and by org_id. */
async function dashboardAnalytics(db: Db, a: Principal, locs: string[] | null, days: number) {
  const [{ tz }] = await db.select({ tz: orgSettings.timezone }).from(orgSettings).where(eq(orgSettings.orgId, a.orgId)).limit(1);
  const list = (col: string) => (locs ? sql` and ${sql.raw(col)} in (${sql.join(locs.map((l) => sql`${l}::uuid`), sql`, `)})` : sql``);
  const lfT = list('t.location_id'); const lfC = list('c.location_id'); const lfS = list('sl.location_id');
  // Midnight (in the org's timezone) at the start of the window, as an instant.
  const since = sql`((date_trunc('day', now() at time zone ${tz}) - ((${days}::int - 1) * interval '1 day')) at time zone ${tz})`;
  const prevSince = sql`((date_trunc('day', now() at time zone ${tz}) - ((${days}::int * 2 - 1) * interval '1 day')) at time zone ${tz})`;
  const rows = <T,>(r: unknown) => r as unknown as T[];

  const [daily, top, incidents, health, holders, summary] = await Promise.all([
    db.execute(sql`
      with d as (select generate_series(date_trunc('day', now() at time zone ${tz}) - ((${days}::int - 1) * interval '1 day'), date_trunc('day', now() at time zone ${tz}), interval '1 day') as day),
      x as (
        select date_trunc('day', t.occurred_at at time zone ${tz}) as day,
          count(*) filter (where t.type = 'checkout')::int as checkouts,
          count(*) filter (where t.type = 'checkin')::int as checkins,
          count(*) filter (where t.type = 'consume')::int as consumed,
          count(*) filter (where t.type = 'restock')::int as restocked,
          count(*) filter (where t.type in ('loss','damage'))::int as incidents,
          count(*)::int as total
        from transactions t where t.org_id = ${a.orgId}::uuid and t.occurred_at >= ${since}${lfT} group by 1)
      select to_char(d.day, 'YYYY-MM-DD') as date, coalesce(x.checkouts,0) as checkouts, coalesce(x.checkins,0) as checkins, coalesce(x.consumed,0) as consumed,
             coalesce(x.restocked,0) as restocked, coalesce(x.incidents,0) as incidents, coalesce(x.total,0) as total
      from d left join x on x.day = d.day order by d.day`),
    db.execute(sql`
      select i.id as item_id, i.name, i.unit, (-sum(t.stock_delta))::int as units
      from transactions t join items i on i.id = t.item_id
      where t.org_id = ${a.orgId}::uuid and i.type = 'consumable' and t.type in ('consume','checkout') and t.occurred_at >= ${since}${lfT}
      group by 1,2,3 having -sum(t.stock_delta) > 0 order by units desc limit 5`),
    db.execute(sql`
      select count(*) filter (where t.occurred_at >= ${since})::int as current, count(*) filter (where t.occurred_at < ${since})::int as previous,
             count(*) filter (where t.occurred_at >= ${since} and t.type = 'loss')::int as lost, count(*) filter (where t.occurred_at >= ${since} and t.type = 'damage')::int as damaged
      from transactions t where t.org_id = ${a.orgId}::uuid and t.type in ('loss','damage') and t.occurred_at >= ${prevSince}${lfT}`),
    db.execute(sql`
      with s as (
        select coalesce((select sum(sl.quantity) from stock_levels sl where sl.item_id = i.id${lfS}), 0)::int as stock, coalesce(i.min_threshold, c.default_min_threshold) as thr
        from items i join categories c on c.id = i.category_id where i.org_id = ${a.orgId}::uuid and i.type = 'consumable' and i.archived_at is null)
      select count(*) filter (where stock <= 0)::int as out,
             count(*) filter (where stock > 0 and thr is not null and stock <= thr)::int as low,
             count(*) filter (where stock > 0 and thr is not null and stock > thr and stock <= ceil(thr * 1.1))::int as near,
             count(*) filter (where stock > 0 and (thr is null or stock > ceil(thr * 1.1)))::int as ok
      from s`),
    db.execute(sql`
      select coalesce(p.full_name, tm.name, j.name) as holder, c.holder_type::text as type, count(*)::int as lines, count(*) filter (where c.due_at < now())::int as overdue
      from custody c left join people p on p.id = c.holder_person_id left join teams tm on tm.id = c.holder_team_id left join jobs j on j.id = c.holder_job_id
      where c.org_id = ${a.orgId}::uuid and c.quantity > 0${lfC} group by 1,2 order by lines desc limit 5`),
    db.execute(sql`
      select count(*) filter (where t.occurred_at >= ${since})::int as total, count(*) filter (where t.occurred_at < ${since})::int as previous_total,
             count(*) filter (where t.occurred_at >= ${since} and t.type = 'checkout')::int as checkouts,
             count(*) filter (where t.occurred_at >= ${since} and t.type = 'checkout' and t.holder_type is not null)::int as checkouts_with_holder,
             count(distinct t.actor_user_id) filter (where t.occurred_at >= ${since})::int as active_users,
             count(*) filter (where t.occurred_at >= ${since} and t.source = 'offline_sync')::int as offline
      from transactions t where t.org_id = ${a.orgId}::uuid and t.occurred_at >= ${prevSince}${lfT}`),
  ]);
  const sm = rows<{ total: number; previous_total: number; checkouts: number; checkouts_with_holder: number; active_users: number; offline: number }>(summary)[0]!;
  const inc = rows<{ current: number; previous: number; lost: number; damaged: number }>(incidents)[0]!;
  const hl = rows<{ out: number; low: number; near: number; ok: number }>(health)[0]!; // aggregate queries always return one row
  return {
    days, timezone: tz,
    daily: rows(daily),
    topConsumed: rows(top),
    incidents: { current: inc.current, previous: inc.previous, lost: inc.lost, damaged: inc.damaged },
    stockHealth: { out: hl.out, low: hl.low, near: hl.near, ok: hl.ok },
    topHolders: rows(holders),
    summary: {
      total: sm.total, previousTotal: sm.previous_total, checkouts: sm.checkouts, activeUsers: sm.active_users,
      accountableRate: sm.checkouts > 0 ? Math.round((1000 * sm.checkouts_with_holder) / sm.checkouts) / 10 : null,
      offlineShare: sm.total > 0 ? Math.round((1000 * sm.offline) / sm.total) / 10 : null,
    },
  };
}
void stockLevels;
