import { randomUUID } from 'node:crypto';
import { and, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { items, categories, shelves, custody, people, teams, jobs, stockLevels, locations, transactions, users, files, orgSettings } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { keysetWhere, toPage } from '../../lib/pagination.js';
import { audit } from '../../lib/audit.js';
import { allowedLocationIds, assertLocationAccess, type Principal } from '../../lib/locations.js';
import { appendTransaction, stockApply, type ItemRow } from '../../lib/ledger.js';
import { signedGetUrl } from '../../lib/storage.js';
import { ownActivityOnly } from '../../lib/scope.js';
import type { CreateItemBody, UpdateItemBody, ListItemsQuery } from './schema.js';

// ── Views ───────────────────────────────────────────────────────────
const holderName = sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`;

function itemColumns(allowed: string[] | null) {
  const locFilter = allowed ? sql` and sl.location_id in (${sql.join(allowed.map((l) => sql`${l}::uuid`), sql`, `)})` : sql``;
  const stock = sql<number>`coalesce((select sum(sl.quantity) from stock_levels sl where sl.item_id = ${items.id}${locFilter}), 0)::int`;
  const threshold = sql<number | null>`coalesce(${items.minThreshold}, ${categories.defaultMinThreshold})`;
  return { stock, threshold };
}

/** UI kit status language: ok · near_minimum ("52 of 50, close to minimum") · low · out. */
export function stockState(stock: number, threshold: number | null): 'ok' | 'near_minimum' | 'low' | 'out' {
  if (stock <= 0) return 'out';
  if (threshold === null) return 'ok';
  if (stock <= threshold) return 'low';
  return stock <= Math.ceil(threshold * 1.1) ? 'near_minimum' : 'ok';
}

async function view(r: {
  item: ItemRow; stock: number; threshold: number | null;
  c: typeof custody.$inferSelect | null; holderName: string | null; photoKey: string | null;
  categoryName: string | null; categoryColor: string | null; categoryIcon: string | null;
  shelfId: string | null; shelfName: string | null; shelfColor: string | null; shelfIcon: string | null;
}) {
  const i = r.item;
  const overdue = !!(r.c?.dueAt && r.c.dueAt < new Date());
  return {
    id: i.id, type: i.type, sku: i.sku, assetTag: i.assetTag, name: i.name, description: i.description,
    categoryId: i.categoryId, categoryName: r.categoryName, categoryColor: r.categoryColor, categoryIcon: r.categoryIcon,
    shelfId: r.shelfId, shelfName: r.shelfName, shelfColor: r.shelfColor, shelfIcon: r.shelfIcon, color: i.color, icon: i.icon, locationId: i.locationId, qrCode: i.qrCode,
    photoUrl: r.photoKey ? await signedGetUrl(r.photoKey) : null,
    assetStatus: i.assetStatus, condition: i.condition, expectedReturnHours: i.expectedReturnHours,
    unit: i.unit, minThreshold: i.minThreshold, reorderQuantity: i.reorderQuantity,
    quantityAvailable: i.type === 'consumable' ? r.stock : null,
    effectiveMinThreshold: i.type === 'consumable' ? r.threshold : null,
    lowStock: i.type === 'consumable' && r.threshold !== null && r.stock <= r.threshold,
    stockState: i.type === 'consumable' ? stockState(r.stock, r.threshold) : null,
    holder: r.c ? { type: r.c.holderType, id: r.c.holderPersonId ?? r.c.holderTeamId ?? r.c.holderJobId, name: r.holderName, since: r.c.checkedOutAt.toISOString(), dueAt: r.c.dueAt?.toISOString() ?? null, overdue, overdueDays: overdue ? Math.max(1, Math.floor((Date.now() - r.c!.dueAt!.getTime()) / 86_400_000)) : 0 } : null,
    archivedAt: i.archivedAt?.toISOString() ?? null,
    createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(),
  };
}

function baseSelect(db: Db, allowed: string[] | null) {
  const { stock, threshold } = itemColumns(allowed);
  return db.select({ item: items, stock, threshold, c: custody, holderName, photoKey: files.storageKey, categoryName: categories.name, categoryColor: categories.color, categoryIcon: categories.icon, shelfId: shelves.id, shelfName: shelves.name, shelfColor: shelves.color, shelfIcon: shelves.icon })
    .from(items)
    .innerJoin(categories, eq(items.categoryId, categories.id))
    .innerJoin(shelves, eq(categories.shelfId, shelves.id))
    .leftJoin(custody, and(eq(custody.itemId, items.id), eq(items.type, 'asset'), sql`${custody.quantity} > 0`))
    .leftJoin(people, eq(custody.holderPersonId, people.id))
    .leftJoin(teams, eq(custody.holderTeamId, teams.id))
    .leftJoin(jobs, eq(custody.holderJobId, jobs.id))
    .leftJoin(files, eq(items.photoFileId, files.id));
}

export async function listItems(db: Db, user: Principal, q: ListItemsQuery) {
  const limit = q.limit ?? 25;
  if (!!q.holderType !== !!q.holderId) throw new ValidationError('holderType and holderId must be provided together');
  const allowed = await allowedLocationIds(db, user);
  const { stock, threshold } = itemColumns(allowed);
  const needle = q.q ? `%${q.q.replace(/[%_\\]/g, '\\$&')}%` : null;
  const conds: (SQL | undefined)[] = [
    eq(items.orgId, user.orgId),
    q.includeArchived ? undefined : isNull(items.archivedAt),
    q.type ? eq(items.type, q.type) : undefined,
    q.categoryId ? eq(items.categoryId, q.categoryId) : undefined,
    q.shelfId ? eq(categories.shelfId, q.shelfId) : undefined,
    q.holderType && q.holderId ? sql`exists (select 1 from custody hc where hc.item_id = ${items.id} and hc.quantity > 0 and hc.holder_key = ${`${q.holderType}:${q.holderId}`})` : undefined,
    q.status ? eq(items.assetStatus, q.status) : undefined,
    q.locationId ? or(eq(items.locationId, q.locationId), sql`exists (select 1 from stock_levels s where s.item_id = ${items.id} and s.location_id = ${q.locationId} and s.quantity > 0)`) : undefined,
    allowed ? or(eq(items.type, 'consumable'), inArray(items.locationId, allowed)) : undefined,
    q.lowStock ? and(eq(items.type, 'consumable'), sql`${threshold} is not null`, sql`${stock} <= ${threshold}`) : undefined,
    needle ? or(ilike(items.name, needle), ilike(items.sku, needle), ilike(items.assetTag, needle)) : undefined,
    q.cursor ? keysetWhere(items.createdAt, items.id, q.cursor) : undefined,
  ];
  const rows = await baseSelect(db, allowed).where(and(...conds.filter((condition): condition is SQL => condition !== undefined))).orderBy(desc(items.createdAt), desc(items.id)).limit(limit + 1);
  const page = toPage(rows.map((r) => ({ ...r, createdAt: r.item.createdAt, id: r.item.id })), limit);
  return { items: await Promise.all(page.items.map(view)), nextCursor: page.nextCursor };
}

export async function getItem(db: Db, user: Principal, itemId: string) {
  const allowed = await allowedLocationIds(db, user);
  const [r] = await baseSelect(db, allowed).where(and(eq(items.id, itemId), eq(items.orgId, user.orgId))).limit(1);
  if (!r) throw new NotFoundError('Item');
  const base = await view(r);
  if (r.item.type === 'consumable') {
    const byLoc = await db.select({ locationId: stockLevels.locationId, name: locations.name, quantity: stockLevels.quantity })
      .from(stockLevels).innerJoin(locations, eq(stockLevels.locationId, locations.id)).where(eq(stockLevels.itemId, itemId));
    const holders = await db.select({ c: custody, name: holderName }).from(custody)
      .leftJoin(people, eq(custody.holderPersonId, people.id)).leftJoin(teams, eq(custody.holderTeamId, teams.id)).leftJoin(jobs, eq(custody.holderJobId, jobs.id))
      .where(and(eq(custody.itemId, itemId), sql`${custody.quantity} > 0`)).limit(200);
    return { ...base, stockByLocation: allowed ? byLoc.filter((b) => allowed.includes(b.locationId)) : byLoc,
      outstanding: holders.map((h) => ({ holderType: h.c.holderType, holderId: h.c.holderPersonId ?? h.c.holderTeamId ?? h.c.holderJobId, holderName: h.name, quantity: h.c.quantity, since: h.c.checkedOutAt.toISOString() })) };
  }
  return base;
}

/** Scan / manual code entry: QR value, asset tag or SKU (PRD §6 "scan lookup"). */
export async function lookupByCode(db: Db, user: Principal, code: string) {
  const c = code.trim();
  const rows = await db.select({ id: items.id }).from(items).where(and(
    eq(items.orgId, user.orgId), isNull(items.archivedAt),
    or(eq(items.qrCode, c), sql`lower(${items.assetTag}) = lower(${c})`, sql`lower(${items.sku}) = lower(${c})`),
  )).limit(3);
  if (rows.length === 0) throw new NotFoundError('Item');
  if (rows.length > 1) throw new ConflictError('AMBIGUOUS_CODE', 'This code matches more than one item; search by name instead');
  return getItem(db, user, rows[0].id);
}

// ── Writes ──────────────────────────────────────────────────────────
/** Resolves the item's category → shelf → home location. The shelf decides the location; callers don't pick one. */
async function resolveHome(tx: Db, actor: Principal, categoryId: string): Promise<{ locationId: string }> {
  const [r] = await tx.select({ locationId: shelves.locationId }).from(categories).innerJoin(shelves, eq(categories.shelfId, shelves.id))
    .where(and(eq(categories.id, categoryId), eq(categories.orgId, actor.orgId), isNull(categories.archivedAt), isNull(shelves.archivedAt))).limit(1);
  if (!r) throw new ValidationError('categoryId does not exist (create a shelf and category first)');
  await assertLocationAccess(tx, actor, r.locationId);
  return r;
}

async function assertPhoto(tx: Db, orgId: string, photoFileId?: string | null) {
  if (photoFileId) {
    const [f] = await tx.select({ k: files.kind }).from(files).where(and(eq(files.id, photoFileId), eq(files.orgId, orgId))).limit(1);
    if (!f || f.k !== 'item_photo') throw new ValidationError('photoFileId must reference an uploaded item photo');
  }
}

function mapUnique(err: unknown): never {
  if (isUniqueViolation(err, 'items_org_sku_unique')) throw new ConflictError('SKU_TAKEN', 'An active item with this SKU already exists');
  if (isUniqueViolation(err, 'items_org_qr_unique')) throw new ConflictError('QR_TAKEN', 'This QR code is already assigned to another item');
  if (isUniqueViolation(err, 'items_org_asset_tag_unique')) throw new ConflictError('ASSET_TAG_TAKEN', 'This asset tag is already assigned to another item');
  throw err;
}

export async function createItem(db: Db, actor: Principal, input: CreateItemBody) {
  const id = await db.transaction((tx) => createItemInTx(tx as unknown as Db, actor, input));
  return getItem(db, actor, id);
}

/** Composable core (used by CSV import with one savepoint per row). Returns the new item id. */
export async function createItemInTx(tx: Db, actor: Principal, input: CreateItemBody, opts: { source?: 'online' | 'import'; importJobId?: string } = {}): Promise<string> {
  const isAsset = input.type === 'asset';
  if (isAsset && (input.openingQuantity !== undefined || input.unit || input.minThreshold != null || input.reorderQuantity != null)) {
    throw new ValidationError('Quantity, unit and threshold fields apply to consumables only');
  }
  if (!isAsset && (input.assetTag || input.condition || input.expectedReturnHours != null)) {
    throw new ValidationError('Asset tag, condition and expected return apply to tracked assets only');
  }
  {
    const { locationId } = await resolveHome(tx, actor, input.categoryId);
    await assertPhoto(tx, actor.orgId, input.photoFileId);
    const itemId = randomUUID();
    const opening = isAsset ? null : (input.openingQuantity ?? 0);
    try {
      await tx.insert(items).values({
        id: itemId, orgId: actor.orgId, type: input.type, sku: input.sku.trim(), assetTag: input.assetTag?.trim(), name: input.name.trim(),
        description: input.description, categoryId: input.categoryId, photoFileId: input.photoFileId, color: input.color ?? null, icon: input.icon ?? null, qrCode: input.qrCode?.trim() ?? `sk:${itemId}`,
        locationId, assetStatus: isAsset ? 'available' : null, condition: isAsset ? (input.condition ?? 'good') : null,
        expectedReturnHours: input.expectedReturnHours ?? null, unit: isAsset ? null : (input.unit ?? 'units'),
        minThreshold: input.minThreshold ?? null, reorderQuantity: input.reorderQuantity ?? null, createdBy: actor.id, updatedBy: actor.id,
      });
    } catch (err) { mapUnique(err); }
    // PRD §12: balance = opening balance + ledger. The opening balance IS the CREATE row.
    const { row } = await appendTransaction(tx, {
      orgId: actor.orgId, type: 'create', itemId, itemType: input.type, locationId, actorUserId: actor.id,
      quantity: opening, stockDelta: opening, condition: isAsset ? (input.condition ?? 'good') : null, toStatus: isAsset ? 'available' : null,
      note: 'Item created', source: opts.source ?? 'online', metadata: opts.importJobId ? { importJobId: opts.importJobId } : null,
    });
    if (!isAsset) await stockApply(tx, { orgId: actor.orgId, itemId, locationId, delta: opening ?? 0 });
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'item.created', entityType: 'item', entityId: itemId, next: { sku: input.sku, type: input.type, name: input.name, openingQuantity: opening }, transactionId: row.id });
    return itemId;
  }
}

export async function updateItem(db: Db, actor: Principal, itemId: string, patch: UpdateItemBody) {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.orgId, actor.orgId))).for('update').limit(1);
    if (!cur) throw new NotFoundError('Item');
    if (cur.archivedAt) throw new ConflictError('ITEM_ARCHIVED', 'Restore the item before editing it');
    await assertLocationAccess(tx, actor, cur.locationId);
    if (cur.type === 'consumable' && (patch.assetTag || patch.expectedReturnHours != null)) throw new ValidationError('Asset tag and expected return apply to tracked assets only');
    if (cur.type === 'asset' && (patch.unit || patch.minThreshold != null || patch.reorderQuantity != null)) throw new ValidationError('Unit and thresholds apply to consumables only');
    await assertPhoto(tx, actor.orgId, patch.photoFileId);
    if (patch.categoryId && patch.categoryId !== cur.categoryId) {
      const home = await resolveHome(tx, actor, patch.categoryId);
      if (home.locationId !== cur.locationId) throw new ConflictError('CROSS_LOCATION_MOVE', 'An item can only move to a category on a shelf in its own location');
    }
    try {
      await tx.update(items).set({ ...patch, sku: patch.sku?.trim(), updatedAt: new Date(), updatedBy: actor.id }).where(eq(items.id, itemId));
    } catch (err) { mapUnique(err); }
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'item.updated', entityType: 'item', entityId: itemId,
      previous: Object.fromEntries(Object.keys(patch).map((k) => [k, (cur as Record<string, unknown>)[k]])), next: patch });
  });
  return getItem(db, actor, itemId);
}

export async function archiveItem(db: Db, actor: Principal, itemId: string, reason?: string) {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.orgId, actor.orgId))).for('update').limit(1);
    if (!cur) throw new NotFoundError('Item');
    if (cur.archivedAt) return; // already archived: idempotent
    await assertLocationAccess(tx, actor, cur.locationId);
    const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(custody).where(and(eq(custody.itemId, itemId), sql`${custody.quantity} > 0`));
    if (held.n > 0) throw new ConflictError('ITEM_HAS_OUTSTANDING', 'Record returns before archiving this item');
    const [stock] = await tx.select({ n: sql<number>`coalesce(sum(${stockLevels.quantity}),0)::int` }).from(stockLevels).where(eq(stockLevels.itemId, itemId));
    if (stock.n > 0) throw new ConflictError('ITEM_HAS_STOCK', 'Adjust or consume remaining stock to zero before archiving this item', { quantity: stock.n });
    await tx.update(items).set({ archivedAt: new Date(), updatedAt: new Date(), updatedBy: actor.id }).where(eq(items.id, itemId));
    const { row } = await appendTransaction(tx, { orgId: actor.orgId, type: 'archive', itemId, itemType: cur.type, locationId: cur.locationId, actorUserId: actor.id, note: reason ?? 'Item archived', source: 'online' });
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'item.archived', entityType: 'item', entityId: itemId, reason, transactionId: row.id });
  });
}

export async function restoreItem(db: Db, actor: Principal, itemId: string) {
  await db.transaction(async (tx) => {
    const [cur] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.orgId, actor.orgId))).for('update').limit(1);
    if (!cur) throw new NotFoundError('Item');
    if (!cur.archivedAt) return;
    try { await tx.update(items).set({ archivedAt: null, updatedAt: new Date(), updatedBy: actor.id }).where(eq(items.id, itemId)); } catch (err) { mapUnique(err); }
    const { row } = await appendTransaction(tx, { orgId: actor.orgId, type: 'restore', itemId, itemType: cur.type, locationId: cur.locationId, actorUserId: actor.id, note: 'Item restored', source: 'online' });
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'item.restored', entityType: 'item', entityId: itemId, transactionId: row.id });
  });
  return getItem(db, actor, itemId);
}

/** Move many items to another category in one transaction (all-or-nothing). Same location only. */
export async function bulkMoveItems(db: Db, actor: Principal, itemIds: string[], categoryId: string) {
  return db.transaction(async (tx0) => {
    const tx = tx0 as unknown as Db;
    const dest = await resolveHome(tx, actor, categoryId);
    const rows = await tx.select().from(items).where(and(eq(items.orgId, actor.orgId), inArray(items.id, itemIds))).orderBy(items.id).for('update');
    if (rows.length !== itemIds.length) throw new NotFoundError('Item');
    for (const it of rows) {
      if (it.archivedAt) throw new ConflictError('ITEM_ARCHIVED', `${it.name} is archived`);
      if (it.locationId !== dest.locationId) throw new ConflictError('CROSS_LOCATION_MOVE', `${it.name} is in a different location than the destination shelf`, { itemId: it.id });
    }
    await tx.update(items).set({ categoryId, updatedAt: new Date(), updatedBy: actor.id }).where(inArray(items.id, itemIds));
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'items.bulk_moved', entityType: 'category', entityId: categoryId,
      previous: rows.map((r) => ({ id: r.id, categoryId: r.categoryId })), next: { categoryId, count: itemIds.length } });
    return { moved: itemIds.length };
  });
}

// ── Timeline (PRD §25) ──────────────────────────────────────────────
export async function itemTimeline(db: Db, user: Principal, itemId: string, q: { cursor?: string; limit?: number; type?: string }) {
  const [it] = await db.select({ id: items.id, locationId: items.locationId }).from(items).where(and(eq(items.id, itemId), eq(items.orgId, user.orgId))).limit(1);
  if (!it) throw new NotFoundError('Item');
  const limit = q.limit ?? 25;
  let after: SQL | undefined;
  if (q.cursor) {
    const [iso, seq] = Buffer.from(q.cursor, 'base64url').toString('utf8').split('|');
    if (!iso || !seq || Number.isNaN(Number(seq)) || Number.isNaN(Date.parse(iso))) throw new ValidationError('Malformed cursor');
    after = sql`(${transactions.occurredAt}, ${transactions.seq}) < (${iso}::timestamptz, ${Number(seq)})`;
  }
  const allowed = await allowedLocationIds(db, user);
  const ownOnly = ownActivityOnly(user);
  const rows = await db.select({
    t: transactions, actorEmail: users.email, actorName: sql<string>`coalesce(${users.fullName}, split_part(${users.email}, '@', 1))`, pName: people.fullName, tName: teams.name, hjName: jobs.name, snap: files.storageKey,
    ctxJob: sql<string | null>`(select j.name from jobs j where j.id = ${transactions.jobId})`,
  }).from(transactions)
    .innerJoin(users, eq(transactions.actorUserId, users.id))
    .leftJoin(people, eq(transactions.holderPersonId, people.id))
    .leftJoin(teams, eq(transactions.holderTeamId, teams.id))
    .leftJoin(jobs, eq(transactions.holderJobId, jobs.id))
    .leftJoin(files, eq(transactions.snapshotFileId, files.id))
    .where(and(eq(transactions.itemId, itemId), eq(transactions.orgId, user.orgId), q.type ? sql`${transactions.type}::text = ${q.type}` : undefined,
      ownOnly ? eq(transactions.actorUserId, ownOnly) : undefined,
      allowed ? inArray(transactions.locationId, allowed) : undefined, after))
    .orderBy(desc(transactions.occurredAt), desc(transactions.seq)).limit(limit + 1);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  return {
    items: await Promise.all(page.map(async (r) => ({
      id: r.t.id, seq: r.t.seq, type: r.t.type, occurredAt: r.t.occurredAt.toISOString(), recordedAt: r.t.createdAt.toISOString(),
      quantity: r.t.quantity, stockDelta: r.t.stockDelta, custodyDelta: r.t.custodyDelta, locationId: r.t.locationId,
      actor: { id: r.t.actorUserId, name: r.actorName, email: r.actorEmail },
      holder: r.t.holderType ? { type: r.t.holderType, id: r.t.holderPersonId ?? r.t.holderTeamId ?? r.t.holderJobId, name: r.pName ?? r.tName ?? r.hjName } : null,
      job: r.t.jobId ? { id: r.t.jobId, name: r.ctxJob } : null,
      purpose: r.t.purpose, condition: r.t.condition, fromStatus: r.t.fromStatus, toStatus: r.t.toStatus, reason: r.t.reason, note: r.t.note,
      snapshotUrl: r.snap ? await signedGetUrl(r.snap) : null, source: r.t.source, deviceId: r.t.deviceId,
      correctsTransactionId: r.t.correctsTransactionId, relatedTransactionId: r.t.relatedTransactionId, metadata: r.t.metadata,
    }))),
    nextCursor: hasMore && last ? Buffer.from(`${last.t.occurredAt.toISOString()}|${last.t.seq}`).toString('base64url') : null,
  };
}

void orgSettings;
