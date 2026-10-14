import type { ApiFastifyInstance } from '../../types.js';
/**
 * Reports (PRD §40) with CSV export. `format=csv` streams: the transactions report
 * pages through the ledger by `seq` in batches so a year of history never has to fit in memory.
 * Cells beginning with = + - @ are prefixed with ' to defuse spreadsheet formula injection.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { Readable } from 'node:stream';
import { categories, custody, items, jobs, locations, people, reconciliationCounts, reconciliationSessions, stockLevels, teams, transactions, users } from '../../db/schema.js';
import { requireRole } from '../../plugins/rbac.js';
import { allowedLocationIds } from '../../lib/locations.js';
import { Uuid } from '../../lib/schemas.js';
import { ValidationError } from '../../lib/errors.js';

const cell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const line = (vals: unknown[]) => vals.map(cell).join(',') + '\n';

function sendCsv(reply: FastifyReply, filename: string, header: string[], rows: AsyncIterable<unknown[]> | Iterable<unknown[]>) {
  async function* gen() { yield '\uFEFF' + line(header); for await (const r of rows as AsyncIterable<unknown[]>) yield line(r); }
  reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`).header('cache-control', 'no-store');
  return reply.send(Readable.from(gen()));
}

const Range = { from: Type.Optional(Type.String({ format: 'date-time' })), to: Type.Optional(Type.String({ format: 'date-time' })), locationId: Type.Optional(Uuid), format: Type.Optional(Type.Union([Type.Literal('json'), Type.Literal('csv')])) };
const MAX_JSON_ROWS = 5000;

export async function reportRoutes(app: ApiFastifyInstance) {
  const READ = requireRole('admin', 'supervisor', 'viewer');

  app.get('/inventory', { preHandler: [app.authenticate, READ], schema: { querystring: Type.Object({ locationId: Range.locationId, format: Range.format, categoryId: Type.Optional(Uuid) }) } }, async (req, reply) => {
    const a = req.user!; const q = req.query; const allowed = await allowedLocationIds(req.server.db, a);
    const locs = q.locationId ? [q.locationId] : allowed;
    const consumables = await req.server.dbRead.select({ sku: items.sku, name: items.name, category: categories.name, unit: items.unit, location: locations.name, qty: stockLevels.quantity, min: sql<number | null>`coalesce(${items.minThreshold}, ${categories.defaultMinThreshold})` })
      .from(stockLevels).innerJoin(items, eq(stockLevels.itemId, items.id)).innerJoin(locations, eq(stockLevels.locationId, locations.id)).leftJoin(categories, eq(items.categoryId, categories.id))
      .where(and(eq(stockLevels.orgId, a.orgId), isNull(items.archivedAt), q.categoryId ? eq(items.categoryId, q.categoryId) : undefined, locs ? inArray(stockLevels.locationId, locs) : undefined)).orderBy(asc(items.name)).limit(50_000);
    const assets = await req.server.dbRead.select({ sku: items.sku, tag: items.assetTag, name: items.name, category: categories.name, location: locations.name, status: items.assetStatus, condition: items.condition })
      .from(items).innerJoin(locations, eq(items.locationId, locations.id)).leftJoin(categories, eq(items.categoryId, categories.id))
      .where(and(eq(items.orgId, a.orgId), eq(items.type, 'asset'), isNull(items.archivedAt), q.categoryId ? eq(items.categoryId, q.categoryId) : undefined, locs ? inArray(items.locationId, locs) : undefined)).orderBy(asc(items.name)).limit(50_000);
    if (q.format === 'csv') {
      return sendCsv(reply, 'inventory.csv', ['type', 'sku', 'asset_tag', 'name', 'category', 'location', 'quantity', 'unit', 'min_threshold', 'status', 'condition'], [
        ...consumables.map((c) => ['consumable', c.sku, '', c.name, c.category, c.location, c.qty, c.unit, c.min, '', '']),
        ...assets.map((s) => ['asset', s.sku, s.tag, s.name, s.category, s.location, 1, '', '', s.status, s.condition]),
      ]);
    }
    return { consumables: consumables.slice(0, MAX_JSON_ROWS), assets: assets.slice(0, MAX_JSON_ROWS), truncated: consumables.length > MAX_JSON_ROWS || assets.length > MAX_JSON_ROWS };
  });

  app.get('/outstanding', { preHandler: [app.authenticate, READ], schema: { querystring: Type.Object({ locationId: Range.locationId, format: Range.format, overdueOnly: Type.Optional(Type.Boolean()) }) } }, async (req, reply) => {
    const a = req.user!; const q = req.query; const allowed = await allowedLocationIds(req.server.db, a); const locs = q.locationId ? [q.locationId] : allowed;
    const rows = await req.server.dbRead.select({ item: items.name, sku: items.sku, qty: custody.quantity, holder: sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`, htype: custody.holderType, since: custody.checkedOutAt, due: custody.dueAt })
      .from(custody).innerJoin(items, eq(custody.itemId, items.id)).leftJoin(people, eq(custody.holderPersonId, people.id)).leftJoin(teams, eq(custody.holderTeamId, teams.id)).leftJoin(jobs, eq(custody.holderJobId, jobs.id))
      .where(and(eq(custody.orgId, a.orgId), sql`${custody.quantity} > 0`, q.overdueOnly ? sql`${custody.dueAt} < now()` : undefined, locs ? inArray(custody.locationId, locs) : undefined)).orderBy(asc(custody.dueAt), asc(custody.checkedOutAt)).limit(50_000);
    if (q.format === 'csv') return sendCsv(reply, 'outstanding.csv', ['item', 'sku', 'quantity', 'holder_type', 'holder', 'checked_out_at', 'due_at', 'overdue'], rows.map((r) => [r.item, r.sku, r.qty, r.htype, r.holder, r.since, r.due, r.due && r.due < new Date() ? 'yes' : 'no']));
    return { items: rows.slice(0, MAX_JSON_ROWS), truncated: rows.length > MAX_JSON_ROWS };
  });

  app.get('/transactions', { preHandler: [app.authenticate, READ], schema: { querystring: Type.Object({ ...Range, type: Type.Optional(Type.String({ maxLength: 40 })), itemId: Type.Optional(Uuid) }) } }, async (req, reply) => {
    const a = req.user!; const q = req.query; const allowed = await allowedLocationIds(req.server.db, a); const locs = q.locationId ? [q.locationId] : allowed;
    const where = (after?: number) => and(eq(transactions.orgId, a.orgId), q.type ? sql`${transactions.type}::text = ${q.type}` : undefined, q.itemId ? eq(transactions.itemId, q.itemId) : undefined,
      q.from ? gte(transactions.occurredAt, new Date(q.from)) : undefined, q.to ? lte(transactions.occurredAt, new Date(q.to)) : undefined, locs ? inArray(transactions.locationId, locs) : undefined,
      after !== undefined ? lt(transactions.seq, after) : undefined);
    const sel = { seq: transactions.seq, at: transactions.occurredAt, type: transactions.type, sku: items.sku, item: items.name, qty: transactions.quantity, sd: transactions.stockDelta, actor: users.email, holder: sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`, reason: transactions.reason, note: transactions.note, source: transactions.source };
    const page = (after?: number, n = 1000) => req.server.dbRead.select(sel).from(transactions).innerJoin(items, eq(transactions.itemId, items.id)).innerJoin(users, eq(transactions.actorUserId, users.id))
      .leftJoin(people, eq(transactions.holderPersonId, people.id)).leftJoin(teams, eq(transactions.holderTeamId, teams.id)).leftJoin(jobs, eq(transactions.holderJobId, jobs.id)).where(where(after)).orderBy(desc(transactions.seq)).limit(n);
    if (q.format === 'csv') {
      async function* rows() { let after: number | undefined; for (;;) { const b = await page(after); if (!b.length) return; for (const r of b) yield [r.seq, r.at, r.type, r.sku, r.item, r.qty, r.sd, r.actor, r.holder, r.reason, r.note, r.source]; after = b.at(-1)!.seq; if (b.length < 1000) return; } }
      return sendCsv(reply, 'transactions.csv', ['seq', 'occurred_at', 'type', 'sku', 'item', 'quantity', 'stock_delta', 'actor', 'holder', 'reason', 'note', 'source'], rows());
    }
    return { items: await page(undefined, 500), note: 'JSON returns the latest 500 rows; use format=csv for the full export or GET /v1/transactions to page.' };
  });

  // Reconciliation variance history (PRD §19, §40)
  app.get('/discrepancies', { preHandler: [app.authenticate, READ], schema: { querystring: Type.Object(Range) } }, async (req, reply) => {
    const a = req.user!; const q = req.query; const allowed = await allowedLocationIds(req.server.db, a); const locs = q.locationId ? [q.locationId] : allowed;
    const rows = await req.server.dbRead.select({ at: reconciliationCounts.createdAt, sku: items.sku, item: items.name, system: reconciliationCounts.systemQuantityAtCount, physical: reconciliationCounts.physicalQuantity, variance: reconciliationCounts.variance, reason: reconciliationCounts.reason, resolved: reconciliationCounts.linkedAdjustmentTransactionId })
      .from(reconciliationCounts).innerJoin(reconciliationSessions, eq(reconciliationCounts.sessionId, reconciliationSessions.id)).innerJoin(items, eq(reconciliationCounts.itemId, items.id))
      .where(and(eq(reconciliationSessions.orgId, a.orgId), sql`${reconciliationCounts.variance} <> 0`, q.from ? gte(reconciliationCounts.createdAt, new Date(q.from)) : undefined, q.to ? lte(reconciliationCounts.createdAt, new Date(q.to)) : undefined, locs ? inArray(reconciliationSessions.locationId, locs) : undefined))
      .orderBy(desc(reconciliationCounts.createdAt)).limit(50_000);
    if (q.format === 'csv') return sendCsv(reply, 'discrepancies.csv', ['counted_at', 'sku', 'item', 'system_qty', 'physical_qty', 'variance', 'reason', 'adjustment_applied'], rows.map((r) => [r.at, r.sku, r.item, r.system, r.physical, r.variance, r.reason, r.resolved ? 'yes' : 'no']));
    return { items: rows.slice(0, MAX_JSON_ROWS), truncated: rows.length > MAX_JSON_ROWS };
  });
  void ValidationError;
}
