import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { items, categories, orgSettings, stockLevels, custody, people, teams, jobs } from '../../db/schema.js';
import { ConflictError } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import type { ItemRow, NewTransaction } from '../../lib/ledger.js';
import type { OpContext } from './types.js';

/** Fields every ledger row shares, derived from the execution context. */
export function baseRow(ctx: OpContext, item: Pick<ItemRow, 'id' | 'type'>, locationId: string): Pick<NewTransaction,
  'orgId' | 'itemId' | 'itemType' | 'locationId' | 'actorUserId' | 'source' | 'deviceId' | 'occurredAt'> {
  return {
    orgId: ctx.actor.orgId, itemId: item.id, itemType: item.type, locationId, actorUserId: ctx.actor.id,
    source: ctx.source, deviceId: ctx.deviceId, occurredAt: ctx.occurredAt ?? new Date(),
  };
}

export const meta = (ctx: OpContext, extra?: Record<string, unknown>) => (ctx.meta || extra ? { ...ctx.meta, ...extra } : null);

/** Expected-return hours: item override → category default → org default → none (PRD §27). */
export async function effectiveReturnHours(tx: Db, item: ItemRow, includeOrgDefault = true): Promise<number | null> {
  if (item.expectedReturnHours) return item.expectedReturnHours;
  if (item.categoryId) {
    const [c] = await tx.select({ h: categories.defaultExpectedReturnHours }).from(categories).where(eq(categories.id, item.categoryId)).limit(1);
    if (c?.h) return c.h;
  }
  if (!includeOrgDefault) return null;
  const [s] = await tx.select({ h: orgSettings.defaultExpectedReturnHours }).from(orgSettings).where(eq(orgSettings.orgId, item.orgId)).limit(1);
  return s?.h ?? null;
}

/** Fires at most once per item per day while at/below threshold (dedupeKey), PRD §28. */
export async function checkLowStock(tx: Db, orgId: string, itemId: string): Promise<void> {
  const [r] = await tx.select({
    name: items.name, sku: items.sku, unit: items.unit,
    thr: sql<number | null>`coalesce(${items.minThreshold}, ${categories.defaultMinThreshold})`,
    stock: sql<number>`coalesce((select sum(${stockLevels.quantity}) from ${stockLevels} where ${stockLevels.itemId} = ${items.id}), 0)::int`,
  }).from(items).leftJoin(categories, eq(items.categoryId, categories.id)).where(and(eq(items.id, itemId), eq(items.orgId, orgId))).limit(1);
  if (!r || r.thr === null || r.stock > r.thr) return;
  const day = new Date().toISOString().slice(0, 10);
  await notify(tx, {
    orgId, type: 'low_stock', entityType: 'item', entityId: itemId, dedupeKey: `low_stock:${itemId}:${day}`,
    title: `Low stock: ${r.name}`, body: `${r.name} (${r.sku}) is at ${r.stock} ${r.unit ?? 'units'}, at or below its minimum of ${r.thr}.`,
    data: { itemId, stock: r.stock, threshold: r.thr },
  });
}

/** Describes who currently holds an asset, for 409 bodies that help the storekeeper act. */
export async function describeAssetHolder(tx: Db, orgId: string, itemId: string) {
  const [r] = await tx.select({
    type: custody.holderType, since: custody.checkedOutAt, dueAt: custody.dueAt,
    name: sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`,
  }).from(custody).leftJoin(people, eq(custody.holderPersonId, people.id)).leftJoin(teams, eq(custody.holderTeamId, teams.id)).leftJoin(jobs, eq(custody.holderJobId, jobs.id))
    .where(and(eq(custody.orgId, orgId), eq(custody.itemId, itemId), sql`${custody.quantity} > 0`)).limit(1);
  return r ? { holderType: r.type, holderName: r.name, since: r.since.toISOString(), dueAt: r.dueAt?.toISOString() ?? null } : null;
}

export const requireQty = (q: number | undefined, what: string): number => {
  if (!Number.isInteger(q) || (q as number) < 1) throw new ConflictError('INVALID_QUANTITY', `${what} requires a positive whole-number quantity`);
  return q as number;
};

import { findTransactionByKey, type TransactionRow } from '../../lib/ledger.js';

/** If this Idempotency-Key already produced a transaction, return it (and verify it was the same operation). */
export async function replayIfExists(tx: Db, ctx: OpContext, type: TransactionRow['type'], itemId: string, key?: string): Promise<{ transaction: TransactionRow; replayed: true } | null> {
  if (!key) return null;
  const ex = await findTransactionByKey(tx, ctx.actor.orgId, ctx.actor.id, key);
  if (!ex) return null;
  if (ex.itemId !== itemId || ex.type !== type) throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different operation');
  return { transaction: ex, replayed: true };
}

/** A state check failed *before* we claimed the key. A duplicate whose original just committed lands here: answer it as a replay, not an error. */
export async function replayOrThrow(tx: Db, ctx: OpContext, type: TransactionRow['type'], itemId: string, key: string | undefined, err: Error): Promise<{ transaction: TransactionRow; replayed: true }> {
  const r = await replayIfExists(tx, ctx, type, itemId, key);
  if (r) return r;
  throw err;
}
