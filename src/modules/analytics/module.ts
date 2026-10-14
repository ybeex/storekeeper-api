import type { ApiFastifyInstance } from '../../types.js';
/**
 * Analytics (PRD Phase 2/3 — pulled forward at the product owner's direction) and the
 * §41 success metrics that can be derived from backend data. All read-only, all
 * org-scoped, all bounded by a date range (default 90 days, max 366) so a query's
 * cost is a function of the window, not of the org's lifetime.
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { sql } from 'drizzle-orm';
import { requireRole } from '../../plugins/rbac.js';
import { allowedLocationIds } from '../../lib/locations.js';
import { ValidationError } from '../../lib/errors.js';
import { Uuid } from '../../lib/schemas.js';

const Q = Type.Object({ from: Type.Optional(Type.String({ format: 'date-time' })), to: Type.Optional(Type.String({ format: 'date-time' })), locationId: Type.Optional(Uuid) });

function window(q: { from?: string; to?: string }, defaultDays = 90) {
  const to = q.to ? new Date(q.to) : new Date();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaultDays * 86_400_000);
  if (from >= to) throw new ValidationError('from must be before to');
  if (to.getTime() - from.getTime() > 366 * 86_400_000) throw new ValidationError('The range may not exceed 366 days');
  return { from, to, days: Math.max(1, (to.getTime() - from.getTime()) / 86_400_000) };
}

const rowsOf = <T,>(r: unknown) => r as unknown as T[];

export async function analyticsRoutes(app: ApiFastifyInstance) {
  const pre = [app.authenticate, requireRole('admin', 'supervisor', 'viewer')];

  async function locFilter(req: { user?: { id: string; orgId: string; role: 'admin' | 'store_staff' | 'supervisor' | 'viewer' }; server: FastifyInstance }, locationId?: string, col = sql.raw('t.location_id')) {
    const allowed = await allowedLocationIds(req.server.db, req.user!);
    const locs = locationId ? [locationId] : allowed;
    return locs ? sql` and ${col} in (${sql.join(locs.map((l) => sql`${l}::uuid`), sql`, `)})` : sql``;
  }

  // Loss & damage trends (PRD Phase 3 "loss/damage trend analysis")
  app.get('/loss-damage', { preHandler: pre, schema: { querystring: Type.Object({ ...Q.properties, bucket: Type.Optional(Type.Union([Type.Literal('day'), Type.Literal('week'), Type.Literal('month')])) }) } }, async (req) => {
    const a = req.user!; const w = window(req.query); const bucket = req.query.bucket ?? 'week'; const lf = await locFilter(req, req.query.locationId);
    const series = await req.server.dbRead.execute(sql`
      select date_trunc(${sql.raw(`'${bucket}'`)}, t.occurred_at) as bucket, t.type::text as type, count(*)::int as events, coalesce(sum(t.quantity),0)::int as units
      from transactions t where t.org_id = ${a.orgId}::uuid and t.type in ('loss','damage') and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to}${lf}
      group by 1,2 order by 1`);
    const topItems = await req.server.dbRead.execute(sql`
      select i.id as item_id, i.name, i.sku, t.type::text as type, count(*)::int as events, coalesce(sum(t.quantity),0)::int as units
      from transactions t join items i on i.id = t.item_id where t.org_id = ${a.orgId}::uuid and t.type in ('loss','damage') and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to}${lf}
      group by 1,2,3,4 order by units desc, events desc limit 10`);
    const byHolder = await req.server.dbRead.execute(sql`
      select coalesce(p.full_name, tm.name, j.name) as holder, count(*)::int as events
      from transactions t left join people p on p.id = t.holder_person_id left join teams tm on tm.id = t.holder_team_id left join jobs j on j.id = t.holder_job_id
      where t.org_id = ${a.orgId}::uuid and t.type in ('loss','damage') and t.holder_type is not null and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to}${lf}
      group by 1 order by events desc limit 10`);
    return { range: { from: w.from.toISOString(), to: w.to.toISOString(), bucket }, series: rowsOf(series), topItems: rowsOf(topItems), topHolders: rowsOf(byHolder) };
  });

  // Consumption velocity & top movers
  app.get('/consumption', { preHandler: pre, schema: { querystring: Q } }, async (req) => {
    const a = req.user!; const w = window(req.query, 30); const lf = await locFilter(req, req.query.locationId);
    const rows = await req.server.dbRead.execute(sql`
      select i.id as item_id, i.name, i.sku, i.unit, -sum(t.stock_delta) filter (where t.type in ('consume','checkout'))::int as units_out,
             round((-sum(t.stock_delta) filter (where t.type in ('consume','checkout')))::numeric / ${w.days}, 2) as avg_per_day, count(*)::int as events
      from transactions t join items i on i.id = t.item_id
      where t.org_id = ${a.orgId}::uuid and i.type = 'consumable' and t.type in ('consume','checkout') and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to}${lf}
      group by 1,2,3,4 order by units_out desc limit 25`);
    return { range: { from: w.from.toISOString(), to: w.to.toISOString() }, items: rowsOf(rows) };
  });

  // Asset utilisation: how often and how long each asset is out
  app.get('/asset-utilization', { preHandler: pre, schema: { querystring: Q } }, async (req) => {
    const a = req.user!; const w = window(req.query); const lf = await locFilter(req, req.query.locationId);
    const rows = await req.server.dbRead.execute(sql`
      with ev as (
        select t.item_id, t.type, t.occurred_at,
               lag(t.type) over (partition by t.item_id order by t.occurred_at, t.seq) as prev_type,
               lag(t.occurred_at) over (partition by t.item_id order by t.occurred_at, t.seq) as prev_at
        from transactions t where t.org_id = ${a.orgId}::uuid and t.item_type = 'asset' and t.type in ('checkout','checkin') and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to}${lf})
      select i.id as item_id, i.name, i.asset_tag, count(*) filter (where ev.type = 'checkout')::int as checkouts,
             round((sum(extract(epoch from (ev.occurred_at - ev.prev_at))) filter (where ev.type = 'checkin' and ev.prev_type = 'checkout') / 3600.0)::numeric, 1) as hours_out,
             round((100.0 * sum(extract(epoch from (ev.occurred_at - ev.prev_at))) filter (where ev.type = 'checkin' and ev.prev_type = 'checkout') / (${w.days} * 86400.0))::numeric, 1) as utilization_pct
      from ev join items i on i.id = ev.item_id group by 1,2,3 order by checkouts desc limit 50`);
    return { range: { from: w.from.toISOString(), to: w.to.toISOString() }, items: rowsOf(rows) };
  });

  // Automated reorder recommendations (PRD Phase 3)
  app.get('/reorder-recommendations', { preHandler: pre, schema: { querystring: Type.Object({ locationId: Q.properties.locationId, leadTimeDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 120, default: 14 })), lookbackDays: Type.Optional(Type.Integer({ minimum: 7, maximum: 180, default: 30 })) }) } }, async (req) => {
    const a = req.user!; const lead = req.query.leadTimeDays ?? 14; const look = req.query.lookbackDays ?? 30; const lf = await locFilter(req, req.query.locationId);
    const slf = await locFilter(req, req.query.locationId, sql.raw('sl.location_id'));
    const rows = await req.server.dbRead.execute(sql`
      with usage as (
        select t.item_id, -sum(t.stock_delta)::numeric / ${look} as per_day from transactions t
        where t.org_id = ${a.orgId}::uuid and t.type in ('consume','checkout') and t.occurred_at >= now() - (${look} * interval '1 day')${lf} group by 1),
      stock as (select sl.item_id, sum(sl.quantity)::int as qty from stock_levels sl where sl.org_id = ${a.orgId}::uuid${slf} group by 1)
      select i.id as item_id, i.name, i.sku, i.unit, coalesce(s.qty,0) as on_hand, coalesce(c.default_min_threshold, 0) as category_min, i.min_threshold, round(coalesce(u.per_day,0),2) as avg_daily_use,
             case when coalesce(u.per_day,0) > 0 then floor(coalesce(s.qty,0) / u.per_day)::int end as days_of_cover,
             greatest(0, ceil(coalesce(u.per_day,0) * ${lead} + coalesce(i.min_threshold, c.default_min_threshold, 0) - coalesce(s.qty,0)))::int as suggested_order_qty
      from items i left join stock s on s.item_id = i.id left join usage u on u.item_id = i.id left join categories c on c.id = i.category_id
      where i.org_id = ${a.orgId}::uuid and i.type = 'consumable' and i.archived_at is null
        and (coalesce(s.qty,0) <= coalesce(i.min_threshold, c.default_min_threshold, -1) or (coalesce(u.per_day,0) > 0 and coalesce(s.qty,0) / u.per_day < ${lead}))
      order by days_of_cover asc nulls first limit 100`);
    return { leadTimeDays: lead, lookbackDays: look, items: rowsOf(rows).filter((r: any) => r.suggested_order_qty > 0) };
  });

  // PRD §41 success metrics derivable from backend data
  app.get('/accountability', { preHandler: pre, schema: { querystring: Q } }, async (req) => {
    const a = req.user!; const w = window(req.query, 30); const lf = await locFilter(req, req.query.locationId);
    const [mv] = rowsOf<any>(await req.server.dbRead.execute(sql`
      select count(*) filter (where t.type = 'checkout')::int as checkouts,
             count(*) filter (where t.type = 'checkout' and t.holder_type is not null)::int as checkouts_with_holder,
             count(*) filter (where t.source = 'offline_sync')::int as offline_transactions, count(*)::int as transactions,
             count(*) filter (where t.type in ('loss','damage'))::int as loss_damage_events,
             count(distinct t.actor_user_id)::int as active_users
      from transactions t where t.org_id = ${a.orgId}::uuid and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to}${lf}`));
    const [rc] = rowsOf<any>(await req.server.dbRead.execute(sql`
      select count(*)::int as counted, count(*) filter (where c.variance = 0)::int as exact,
             coalesce(sum(c.variance) filter (where c.variance < 0), 0)::int as shrinkage_units, coalesce(sum(abs(c.variance)),0)::int as abs_variance
      from reconciliation_counts c join reconciliation_sessions s on s.id = c.session_id
      where s.org_id = ${a.orgId}::uuid and c.created_at >= ${w.from} and c.created_at < ${w.to}`));
    const [sess] = rowsOf<any>(await req.server.dbRead.execute(sql`
      select count(*) filter (where due_at is not null)::int as scheduled, count(*) filter (where due_at is not null and status = 'closed' and closed_at <= due_at)::int as on_time
      from reconciliation_sessions where org_id = ${a.orgId}::uuid and due_at >= ${w.from} and due_at < ${w.to}`));
    const [od] = rowsOf<any>(await req.server.dbRead.execute(sql`
      select count(*) filter (where t.type = 'checkin' and (t.metadata->>'overdue')::boolean is true)::int as late_returns, count(*) filter (where t.type = 'checkin' and t.item_type = 'asset')::int as asset_returns
      from transactions t where t.org_id = ${a.orgId}::uuid and t.occurred_at >= ${w.from} and t.occurred_at < ${w.to}${lf}`));
    const pct = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);
    return {
      range: { from: w.from.toISOString(), to: w.to.toISOString() },
      accountableMovementRate: pct(mv.checkouts_with_holder, mv.checkouts), // the north-star metric
      inventoryAccuracyPct: pct(rc.exact, rc.counted), itemsCounted: rc.counted, shrinkageUnits: Math.abs(rc.shrinkage_units), absoluteVarianceUnits: rc.abs_variance,
      scheduledCountsOnTimePct: pct(sess.on_time, sess.scheduled), lateReturnPct: pct(od.late_returns, od.asset_returns),
      offlineTransactionSharePct: pct(mv.offline_transactions, mv.transactions), lossDamageEvents: mv.loss_damage_events, activeUsers: mv.active_users, transactions: mv.transactions,
    };
  });
}
