/**
 * Checkout / check-in / consume / restock (PRD §13, §14, §16).
 * Each function is ONE unit of ledger work; the caller owns the DB transaction
 * (so batch checkout, offline sync and approval execution can compose them).
 */
import type { Db } from '../../db/index.js';
import { ConflictError, ValidationError } from '../../lib/errors.js';
import { assertHolder, assertJob, holderColumns, holderKey, holderFromRow } from '../../lib/holders.js';
import { assertLocationAccess, resolveLocationId } from '../../lib/locations.js';
import {
  appendTransaction, casAssetStatus, checkSnapshot, custodyAdd, custodyRemove, getActiveItem, getCustodyQty, getStock, stockDecrement, stockIncrement,
} from '../../lib/ledger.js';
import { custody } from '../../db/schema.js';
import { and, eq, sql } from 'drizzle-orm';
import { baseRow, checkLowStock, describeAssetHolder, effectiveReturnHours, meta, replayIfExists, replayOrThrow, requireQty } from './shared.js';
import type { CheckinInput, CheckoutInput, ConsumeInput, OpContext, OpResult, RestockInput } from './types.js';

export async function doCheckout(tx: Db, ctx: OpContext, input: CheckoutInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'checkout', item.id, input.idempotencyKey);
  if (prior) return prior;
  const isAsset = item.type === 'asset';
  const locationId = isAsset ? item.locationId : await resolveLocationId(tx, actor, input.locationId);
  await assertLocationAccess(tx, actor, locationId);
  await assertHolder(tx, actor.orgId, input.holder, true);
  if (input.jobId) await assertJob(tx, actor.orgId, input.jobId);
  await checkSnapshot(tx, actor.orgId, 'checkout', input.snapshotFileId);

  if (isAsset) {
    if (input.quantity !== undefined && input.quantity !== 1) throw new ValidationError('Tracked assets are checked out one at a time');
    let dueAt: Date | null = null;
    if (input.expectedReturnAt) {
      dueAt = new Date(input.expectedReturnAt);
      if (Number.isNaN(dueAt.getTime())) throw new ValidationError('expectedReturnAt is not a valid date');
    } else {
      const hours = await effectiveReturnHours(tx, item);
      if (hours) dueAt = new Date((ctx.occurredAt ?? new Date()).getTime() + hours * 3600_000);
    }
    const { row, replayed } = await appendTransaction(tx, {
      ...baseRow(ctx, item, locationId), type: 'checkout', quantity: 1, custodyDelta: 1, ...holderColumns(input.holder),
      jobId: input.jobId, purpose: input.purpose, condition: input.condition ?? item.condition, fromStatus: 'available', toStatus: 'checked_out',
      note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx, dueAt ? { dueAt: dueAt.toISOString() } : undefined),
    });
    if (replayed) return { transaction: row, replayed, dueAt: (row.metadata as { dueAt?: string } | null)?.dueAt ? new Date((row.metadata as { dueAt: string }).dueAt) : null };

    // The CAS is the lock: only one concurrent checkout of this asset can flip available → checked_out.
    const ok = await casAssetStatus(tx, { orgId: actor.orgId, itemId: item.id, from: ['available'], to: 'checked_out', condition: input.condition, actorUserId: actor.id });
    if (!ok) {
      const [fresh] = await tx.select({ s: sql<string>`${custody.id}` }).from(custody).where(and(eq(custody.itemId, item.id), sql`${custody.quantity} > 0`)).limit(1);
      throw new ConflictError('ITEM_NOT_AVAILABLE', 'This asset is not available for checkout', { holder: fresh ? await describeAssetHolder(tx, actor.orgId, item.id) : null });
    }
    await custodyAdd(tx, { orgId: actor.orgId, itemId: item.id, holder: input.holder, locationId, jobId: input.jobId, qty: 1, dueAt, transactionId: row.id });
    return { transaction: row, replayed: false, dueAt };
  }

  const qty = requireQty(input.quantity, 'Checking out a consumable');
  // A due date for consumables only exists where the category asks for returns (e.g. "extension cables: 7 days"). The
  // org-wide default is deliberately ignored here — gloves are used up, not returned, and must never go "overdue".
  const hours = input.expectedReturnAt ? null : await effectiveReturnHours(tx, item, false);
  let dueAt: Date | null = hours ? new Date((ctx.occurredAt ?? new Date()).getTime() + hours * 3600_000) : null;
  if (input.expectedReturnAt) { dueAt = new Date(input.expectedReturnAt); if (Number.isNaN(dueAt.getTime())) throw new ValidationError('expectedReturnAt is not a valid date'); }
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, locationId), type: 'checkout', quantity: qty, stockDelta: -qty, custodyDelta: qty, ...holderColumns(input.holder),
    jobId: input.jobId, purpose: input.purpose, note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx, dueAt ? { dueAt: dueAt.toISOString() } : undefined),
  });
  if (replayed) return { transaction: row, replayed, dueAt: (row.metadata as { dueAt?: string } | null)?.dueAt ? new Date((row.metadata as { dueAt: string }).dueAt) : null };
  // PRD §13.3: never below zero, never above what is available.
  if (!(await stockDecrement(tx, { orgId: actor.orgId, itemId: item.id, locationId, qty }))) {
    throw new ConflictError('INSUFFICIENT_STOCK', 'Not enough stock available', { available: await getStock(tx, { orgId: actor.orgId, itemId: item.id, locationId }), requested: qty });
  }
  await custodyAdd(tx, { orgId: actor.orgId, itemId: item.id, holder: input.holder, locationId, jobId: input.jobId, qty, dueAt, transactionId: row.id });
  await checkLowStock(tx, actor.orgId, item.id);
  return { transaction: row, replayed: false, dueAt };
}

/** Asset status after a return, driven by the reported condition (PRD §12 + §15.2). */
const STATUS_AFTER_RETURN = { good: 'available', damaged: 'damaged', needs_inspection: 'under_repair', replaced: 'retired' } as const;

export async function doCheckin(tx: Db, ctx: OpContext, input: CheckinInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'checkin', item.id, input.idempotencyKey);
  if (prior) return prior;
  await checkSnapshot(tx, actor.orgId, 'checkin', input.snapshotFileId);

  if (item.type === 'asset') {
    const [c] = await tx.select().from(custody).where(and(eq(custody.orgId, actor.orgId), eq(custody.itemId, item.id), sql`${custody.quantity} > 0`)).limit(1);
    if (!c) return replayOrThrow(tx, ctx, 'checkin', item.id, input.idempotencyKey, new ConflictError('NOT_CHECKED_OUT', 'This asset is not currently checked out'));
    const locationId = c.locationId;
    await assertLocationAccess(tx, actor, locationId);
    const holder = holderFromRow({ holderType: c.holderType, holderPersonId: c.holderPersonId, holderTeamId: c.holderTeamId, holderJobId: c.holderJobId })!;
    if (input.holder && holderKey(input.holder) !== holderKey(holder)) {
      throw new ConflictError('HOLDER_MISMATCH', 'This asset is checked out to someone else', { holder: await describeAssetHolder(tx, actor.orgId, item.id) });
    }
    const condition = input.condition ?? item.condition ?? 'good';
    const toStatus = STATUS_AFTER_RETURN[condition];
    const { row, replayed } = await appendTransaction(tx, {
      ...baseRow(ctx, item, locationId), type: 'checkin', quantity: 1, custodyDelta: -1, ...holderColumns(holder), jobId: c.jobId, condition,
      fromStatus: 'checked_out', toStatus, note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey,
      metadata: meta(ctx, { overdue: !!(c.dueAt && c.dueAt < (ctx.occurredAt ?? new Date())) }),
    });
    if (replayed) return { transaction: row, replayed };
    if (!(await custodyRemove(tx, { orgId: actor.orgId, itemId: item.id, holder, qty: 1 }))) throw new ConflictError('NOT_CHECKED_OUT', 'This asset was returned by another request');
    if (!(await casAssetStatus(tx, { orgId: actor.orgId, itemId: item.id, from: ['checked_out'], to: toStatus, condition, locationId, actorUserId: actor.id }))) {
      throw new ConflictError('STATE_CHANGED', 'The asset changed state during the return; retry');
    }
    return { transaction: row, replayed: false };
  }

  // Consumable
  if (!input.holder) throw new ValidationError('holder is required to return a consumable');
  const qty = requireQty(input.quantity, 'Returning a consumable');
  const locationId = await resolveLocationId(tx, actor, input.locationId);
  await assertHolder(tx, actor.orgId, input.holder, false);

  // PRD §56.2: returning more than was issued is blocked unless a supervisor/admin explicitly allows it.
  // The ledger row is written BEFORE any mutation (claim-first), so decide the exact deltas now.
  const held = await getCustodyQty(tx, actor.orgId, item.id, input.holder);
  const release = Math.min(held, qty);
  const surplus = qty - release;
  if (surplus > 0) {
    const mayOverride = input.acceptOverReturn && (actor.role === 'admin' || actor.role === 'supervisor');
    if (!mayOverride) {
      return replayOrThrow(tx, ctx, 'checkin', item.id, input.idempotencyKey,
        new ConflictError('OVER_RETURN', 'This holder has fewer of these items outstanding than you are returning', { outstanding: held, returning: qty, overrideAllowedFor: ['supervisor', 'admin'] }));
    }
  }
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, locationId), type: 'checkin', quantity: qty, stockDelta: qty, custodyDelta: -release, ...holderColumns(input.holder),
    condition: input.condition, note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey,
    metadata: meta(ctx, surplus > 0 ? { overReturn: true, surplus, overriddenBy: actor.id } : undefined),
  });
  if (replayed) return { transaction: row, replayed };
  // Guarded: if the balance dropped between our read and now, fail (and roll back) rather than under-release.
  if (release > 0 && !(await custodyRemove(tx, { orgId: actor.orgId, itemId: item.id, holder: input.holder, qty: release }))) {
    throw new ConflictError('STATE_CHANGED', "The holder's outstanding balance changed; retry");
  }
  await stockIncrement(tx, { orgId: actor.orgId, itemId: item.id, locationId, qty });
  return { transaction: row, replayed: false };
}

export async function doConsume(tx: Db, ctx: OpContext, input: ConsumeInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'consume', item.id, input.idempotencyKey);
  if (prior) return prior;
  if (item.type !== 'consumable') throw new ValidationError('Only consumables can be consumed; check an asset out instead');
  const qty = requireQty(input.quantity, 'Consuming stock');
  const locationId = await resolveLocationId(tx, actor, input.locationId);
  if (input.holder) await assertHolder(tx, actor.orgId, input.holder, true);
  if (input.jobId) await assertJob(tx, actor.orgId, input.jobId);
  await checkSnapshot(tx, actor.orgId, 'consume', input.snapshotFileId);
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, locationId), type: 'consume', quantity: qty, stockDelta: -qty, ...holderColumns(input.holder), jobId: input.jobId,
    purpose: input.purpose, note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx),
  });
  if (replayed) return { transaction: row, replayed };
  if (!(await stockDecrement(tx, { orgId: actor.orgId, itemId: item.id, locationId, qty }))) {
    throw new ConflictError('INSUFFICIENT_STOCK', 'Not enough stock available', { available: await getStock(tx, { orgId: actor.orgId, itemId: item.id, locationId }), requested: qty });
  }
  await checkLowStock(tx, actor.orgId, item.id);
  return { transaction: row, replayed: false };
}

export async function doRestock(tx: Db, ctx: OpContext, input: RestockInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'restock', item.id, input.idempotencyKey);
  if (prior) return prior;
  if (item.type !== 'consumable') throw new ValidationError('Only consumables can be restocked');
  const qty = requireQty(input.quantity, 'Restocking');
  const locationId = await resolveLocationId(tx, actor, input.locationId);
  await checkSnapshot(tx, actor.orgId, 'restock', input.snapshotFileId);
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, locationId), type: 'restock', quantity: qty, stockDelta: qty, note: input.note,
    snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx),
  });
  if (replayed) return { transaction: row, replayed };
  await stockIncrement(tx, { orgId: actor.orgId, itemId: item.id, locationId, qty });
  return { transaction: row, replayed: false };
}
