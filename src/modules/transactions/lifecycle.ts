/**
 * Adjustments, loss, damage, condition/status changes, transfers and corrections
 * (PRD §15, §17, §19, §50). Same contract as movement.ts: one unit of ledger work,
 * caller owns the DB transaction.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { custody, items, locations, transactions } from '../../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { assertHolder, holderColumns, holderFromRow } from '../../lib/holders.js';
import { assertLocation, assertLocationAccess, resolveLocationId } from '../../lib/locations.js';
import {
  appendTransaction, casAssetStatus, checkSnapshot, custodyAdd, custodyRemove, getActiveItem, getStock,
  stockApply, stockDecrement, stockIncrement, type AssetStatus,
} from '../../lib/ledger.js';
import { baseRow, checkLowStock, meta, replayIfExists, requireQty } from './shared.js';
import type {
  AdjustmentInput, ConditionInput, CorrectionInput, IncidentInput, OpContext, OpResult, ReplacementInput, StatusInput, TransferInput,
} from './types.js';

// ── Adjustment (PRD §15.1, §18) ─────────────────────────────────────
export async function doAdjustment(tx: Db, ctx: OpContext, input: AdjustmentInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const txType = input.reconciliationCountId ? 'reconciliation_adjustment' : 'adjustment';
  const prior = await replayIfExists(tx, ctx, txType, item.id, input.idempotencyKey);
  if (prior) return prior;
  if (item.type !== 'consumable') throw new ValidationError('Quantity adjustments apply to consumables; use status/condition changes for assets');
  if (!Number.isInteger(input.delta) || input.delta === 0) throw new ValidationError('delta must be a non-zero whole number');
  const locationId = await resolveLocationId(tx, actor, input.locationId);
  await checkSnapshot(tx, actor.orgId, 'adjustment', input.snapshotFileId);
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, locationId), type: txType, quantity: Math.abs(input.delta), stockDelta: input.delta, reason: input.reason,
    note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey,
    metadata: meta(ctx, input.reconciliationCountId ? { reconciliationCountId: input.reconciliationCountId } : undefined),
  });
  if (replayed) return { transaction: row, replayed };
  if (!(await stockApply(tx, { orgId: actor.orgId, itemId: item.id, locationId, delta: input.delta }))) {
    throw new ConflictError('INSUFFICIENT_STOCK', 'The adjustment would take stock below zero', { available: await getStock(tx, { orgId: actor.orgId, itemId: item.id, locationId }), delta: input.delta });
  }
  if (input.delta < 0) await checkLowStock(tx, actor.orgId, item.id);
  return { transaction: row, replayed: false };
}

// ── Loss & damage (PRD §17) — explicit events, never an adjustment in disguise ──
export async function doIncident(tx: Db, ctx: OpContext, kind: 'loss' | 'damage', input: IncidentInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, kind, item.id, input.idempotencyKey);
  if (prior) return prior;
  await checkSnapshot(tx, actor.orgId, kind, input.snapshotFileId);
  const note = [input.reason, input.note].filter(Boolean).join(' — ') || undefined;
  const enumReason = kind === 'loss' ? 'loss' : 'damage';

  if (item.type === 'asset') {
    const status = item.assetStatus!;
    const allowedFrom: AssetStatus[] = kind === 'loss' ? ['available', 'checked_out', 'damaged', 'under_repair'] : ['available', 'checked_out', 'under_repair'];
    if (!allowedFrom.includes(status)) throw new ConflictError('INVALID_STATE', `A ${status.replace('_', ' ')} asset cannot be recorded as ${kind === 'loss' ? 'lost' : 'damaged'}`);
    const [c] = await tx.select().from(custody).where(and(eq(custody.orgId, actor.orgId), eq(custody.itemId, item.id), sql`${custody.quantity} > 0`)).limit(1);
    const locationId = c?.locationId ?? item.locationId;
    await assertLocationAccess(tx, actor, locationId);
    const holder = c ? holderFromRow({ holderType: c.holderType, holderPersonId: c.holderPersonId, holderTeamId: c.holderTeamId, holderJobId: c.holderJobId }) : null;
    const to: AssetStatus = kind === 'loss' ? 'lost' : 'damaged';
    const { row, replayed } = await appendTransaction(tx, {
      ...baseRow(ctx, item, locationId), type: kind, quantity: 1, custodyDelta: c ? -1 : null, ...holderColumns(holder), jobId: c?.jobId,
      reason: enumReason, fromStatus: status, toStatus: to, condition: kind === 'damage' ? 'damaged' : item.condition, note,
      snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx),
    });
    if (replayed) return { transaction: row, replayed };
    if (c && holder && !(await custodyRemove(tx, { orgId: actor.orgId, itemId: item.id, holder, qty: 1 }))) throw new ConflictError('STATE_CHANGED', 'The asset changed state; retry');
    // Exact-status CAS: the row above recorded `fromStatus = status`, so only that state may transition.
    if (!(await casAssetStatus(tx, { orgId: actor.orgId, itemId: item.id, from: [status], to, condition: kind === 'damage' ? 'damaged' : undefined, actorUserId: actor.id }))) {
      throw new ConflictError('STATE_CHANGED', 'The asset changed state; retry');
    }
    return { transaction: row, replayed: false };
  }

  const qty = requireQty(input.quantity, `Recording ${kind}`);
  const locationId = await resolveLocationId(tx, actor, input.locationId);
  if (input.holder) await assertHolder(tx, actor.orgId, input.holder, false);
  // Held by someone → their custody shrinks (stock already left the shelf at checkout). On the shelf → stock shrinks.
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, locationId), type: kind, quantity: qty, stockDelta: input.holder ? null : -qty, custodyDelta: input.holder ? -qty : null,
    ...holderColumns(input.holder), reason: enumReason, note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx),
  });
  if (replayed) return { transaction: row, replayed };
  if (input.holder) {
    if (!(await custodyRemove(tx, { orgId: actor.orgId, itemId: item.id, holder: input.holder, qty }))) throw new ConflictError('INSUFFICIENT_HELD', 'This holder does not hold that many');
  } else if (!(await stockDecrement(tx, { orgId: actor.orgId, itemId: item.id, locationId, qty }))) {
    throw new ConflictError('INSUFFICIENT_STOCK', 'Not enough stock to write off', { available: await getStock(tx, { orgId: actor.orgId, itemId: item.id, locationId }), requested: qty });
  }
  if (!input.holder) await checkLowStock(tx, actor.orgId, item.id);
  return { transaction: row, replayed: false };
}

// ── Condition (PRD §15.2) ───────────────────────────────────────────
export async function doCondition(tx: Db, ctx: OpContext, input: ConditionInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'condition_update', item.id, input.idempotencyKey);
  if (prior) return prior;
  if (item.type !== 'asset') throw new ValidationError('Condition applies to tracked assets');
  if (input.condition === 'replaced') throw new ValidationError('Use the replacement flow to mark an asset as replaced');
  const from = item.assetStatus!;
  if (from === 'retired') throw new ConflictError('INVALID_STATE', 'Retired assets cannot be modified');
  await assertLocationAccess(tx, actor, item.locationId);
  await checkSnapshot(tx, actor.orgId, 'condition_update', input.snapshotFileId);
  // Sending an available asset for inspection or marking it damaged takes it out of circulation.
  let to: AssetStatus = from;
  if (from === 'available' && input.condition === 'needs_inspection') to = 'under_repair';
  if (from === 'available' && input.condition === 'damaged') to = 'damaged';
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, item.locationId), type: 'condition_update', condition: input.condition, fromStatus: from, toStatus: to,
    note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx, { previousCondition: item.condition }),
  });
  if (replayed) return { transaction: row, replayed };
  if (!(await casAssetStatus(tx, { orgId: actor.orgId, itemId: item.id, from: [from], to, condition: input.condition, actorUserId: actor.id }))) {
    throw new ConflictError('STATE_CHANGED', 'The asset changed state; retry');
  }
  return { transaction: row, replayed: false };
}

// ── Lifecycle status (PRD §12) ──────────────────────────────────────
const TRANSITIONS: Record<AssetStatus, AssetStatus[]> = {
  available: ['under_repair', 'retired'],
  under_repair: ['available', 'retired'],
  damaged: ['under_repair', 'available', 'retired'],
  lost: ['available', 'retired'], // found again / written off
  checked_out: [],                // only a check-in, loss or damage report moves a checked-out asset
  retired: [],                    // terminal
};

export async function doStatusChange(tx: Db, ctx: OpContext, input: StatusInput): Promise<OpResult> {
  const { actor } = ctx;
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'status_change', item.id, input.idempotencyKey);
  if (prior) return prior;
  if (item.type !== 'asset') throw new ValidationError('Status applies to tracked assets');
  const from = item.assetStatus!;
  if (!TRANSITIONS[from].includes(input.to)) throw new ConflictError('INVALID_TRANSITION', `An asset that is ${from.replace('_', ' ')} cannot move to ${input.to.replace('_', ' ')}`, { allowed: TRANSITIONS[from] });
  if ((input.to === 'retired' || from === 'lost' || from === 'damaged') && !input.note) throw new ValidationError('A note explaining this change is required');
  await assertLocationAccess(tx, actor, item.locationId);
  await checkSnapshot(tx, actor.orgId, 'status_change', input.snapshotFileId);
  const { row, replayed } = await appendTransaction(tx, {
    ...baseRow(ctx, item, item.locationId), type: 'status_change', fromStatus: from, toStatus: input.to, note: input.note,
    snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx),
  });
  if (replayed) return { transaction: row, replayed };
  if (!(await casAssetStatus(tx, { orgId: actor.orgId, itemId: item.id, from: [from], to: input.to, actorUserId: actor.id }))) throw new ConflictError('STATE_CHANGED', 'The asset changed state; retry');
  return { transaction: row, replayed: false };
}

// ── Replacement (PRD §11.1 REPLACEMENT, §15.2 "Replaced") ───────────
/** Retires a broken/lost asset and links the unit that takes its place. Two ledger rows, cross-referenced, one DB transaction. */
export async function doReplacement(tx: Db, ctx: OpContext, input: ReplacementInput): Promise<OpResult> {
  const { actor } = ctx;
  if (input.itemId === input.replacementItemId) throw new ValidationError('An asset cannot replace itself');
  const old = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'replacement', old.id, input.idempotencyKey);
  if (prior) return prior;
  const repl = await getActiveItem(tx, actor.orgId, input.replacementItemId);
  if (old.type !== 'asset' || repl.type !== 'asset') throw new ValidationError('Replacement applies to tracked assets');
  if (!input.note?.trim()) throw new ValidationError('A note explaining the replacement is required');
  const from = old.assetStatus!;
  if (!(['available', 'damaged', 'under_repair', 'lost'] as AssetStatus[]).includes(from)) {
    throw new ConflictError('INVALID_STATE', from === 'checked_out' ? 'Check the asset in (or report it lost) before replacing it' : `A ${from.replace('_', ' ')} asset cannot be replaced`);
  }
  if (repl.assetStatus !== 'available') throw new ConflictError('ITEM_NOT_AVAILABLE', 'The replacement asset must be available');
  await assertLocationAccess(tx, actor, old.locationId);
  await assertLocationAccess(tx, actor, repl.locationId);
  await checkSnapshot(tx, actor.orgId, 'status_change', input.snapshotFileId);

  const a = await appendTransaction(tx, {
    ...baseRow(ctx, old, old.locationId), type: 'replacement', fromStatus: from, toStatus: 'retired', condition: 'replaced', note: input.note,
    snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx, { replacementItemId: repl.id }),
  });
  if (a.replayed) return { transaction: a.row, replayed: true };
  if (!(await casAssetStatus(tx, { orgId: actor.orgId, itemId: old.id, from: [from], to: 'retired', condition: 'replaced', actorUserId: actor.id }))) throw new ConflictError('STATE_CHANGED', 'The asset changed state; retry');
  await appendTransaction(tx, {
    ...baseRow(ctx, repl, repl.locationId), type: 'replacement', relatedTransactionId: a.row.id, note: `Replaces ${old.name}${old.assetTag ? ` (${old.assetTag})` : ''}: ${input.note}`, metadata: meta(ctx, { replaces: old.id }),
  });
  return { transaction: a.row, replayed: false };
}

// ── Transfer between locations (PRD Phase 2) ────────────────────────
export async function doTransfer(tx: Db, ctx: OpContext, input: TransferInput): Promise<OpResult & { inTransaction?: typeof transactions.$inferSelect }> {
  const { actor } = ctx;
  if (input.fromLocationId === input.toLocationId) throw new ValidationError('Source and destination must differ');
  const item = await getActiveItem(tx, actor.orgId, input.itemId);
  const prior = await replayIfExists(tx, ctx, 'transfer_out', item.id, input.idempotencyKey);
  if (prior) {
    const [inRow] = await tx.select().from(transactions).where(eq(transactions.relatedTransactionId, prior.transaction.id)).limit(1);
    return { ...prior, inTransaction: inRow };
  }
  await assertLocation(tx, actor.orgId, input.fromLocationId);
  await assertLocation(tx, actor.orgId, input.toLocationId);
  await assertLocationAccess(tx, actor, input.fromLocationId);
  await assertLocationAccess(tx, actor, input.toLocationId);
  await checkSnapshot(tx, actor.orgId, 'transfer', input.snapshotFileId);
  const isAsset = item.type === 'asset';
  const qty = isAsset ? 1 : requireQty(input.quantity, 'Transferring stock');
  if (isAsset && item.locationId !== input.fromLocationId) throw new ConflictError('WRONG_LOCATION', 'This asset is not at the source location');
  if (isAsset && item.assetStatus !== 'available') throw new ConflictError('ITEM_NOT_AVAILABLE', 'Only available assets can be transferred');

  const out = await appendTransaction(tx, {
    ...baseRow(ctx, item, input.fromLocationId), type: 'transfer_out', counterpartLocationId: input.toLocationId, quantity: qty,
    stockDelta: isAsset ? null : -qty, note: input.note, snapshotFileId: input.snapshotFileId, idempotencyKey: input.idempotencyKey, metadata: meta(ctx),
  });
  if (out.replayed) return { transaction: out.row, replayed: true };
  if (isAsset) {
    if (!(await casAssetStatus(tx, { orgId: actor.orgId, itemId: item.id, from: ['available'], to: 'available', locationId: input.toLocationId, actorUserId: actor.id }))) {
      throw new ConflictError('ITEM_NOT_AVAILABLE', 'The asset is no longer available to transfer');
    }
  } else {
    if (!(await stockDecrement(tx, { orgId: actor.orgId, itemId: item.id, locationId: input.fromLocationId, qty }))) {
      throw new ConflictError('INSUFFICIENT_STOCK', 'Not enough stock at the source location', { available: await getStock(tx, { orgId: actor.orgId, itemId: item.id, locationId: input.fromLocationId }), requested: qty });
    }
    await stockIncrement(tx, { orgId: actor.orgId, itemId: item.id, locationId: input.toLocationId, qty });
  }
  const inn = await appendTransaction(tx, {
    ...baseRow(ctx, item, input.toLocationId), type: 'transfer_in', counterpartLocationId: input.fromLocationId, quantity: qty,
    stockDelta: isAsset ? null : qty, relatedTransactionId: out.row.id, note: input.note, metadata: meta(ctx),
  });
  if (!isAsset) await checkLowStock(tx, actor.orgId, item.id);
  return { transaction: out.row, replayed: false, inTransaction: inn.row };
}

// ── Corrections (PRD §50): history is never edited; a new row reverses an old one ──
const CORRECTABLE = new Set(['checkout', 'checkin', 'consume', 'restock', 'adjustment', 'loss', 'damage', 'reconciliation_adjustment']);

export async function doCorrection(tx: Db, ctx: OpContext, input: CorrectionInput): Promise<OpResult> {
  const { actor } = ctx;
  const [target] = await tx.select().from(transactions).where(and(eq(transactions.id, input.transactionId), eq(transactions.orgId, actor.orgId))).limit(1);
  if (!target) throw new NotFoundError('Transaction');
  const prior = await replayIfExists(tx, ctx, 'adjustment', target.itemId, input.idempotencyKey);
  if (prior) return prior;
  if (target.itemType !== 'consumable' || !CORRECTABLE.has(target.type) || (!target.stockDelta && !target.custodyDelta)) {
    throw new ConflictError('CORRECTION_UNSUPPORTED', 'Only stock- or custody-changing consumable transactions can be reversed; use status/condition operations for assets');
  }
  const item = await getActiveItem(tx, actor.orgId, target.itemId);
  await assertLocationAccess(tx, actor, target.locationId);
  const stockDelta = target.stockDelta ? -target.stockDelta : null;
  const custodyDelta = target.custodyDelta ? -target.custodyDelta : null;
  const holder = holderFromRow(target);
  let claimed;
  try {
    claimed = await appendTransaction(tx, {
      ...baseRow(ctx, item, target.locationId), type: 'adjustment', quantity: Math.abs(stockDelta ?? custodyDelta ?? 0), stockDelta, custodyDelta,
      ...holderColumns(holder), jobId: target.jobId, reason: 'count_correction', correctsTransactionId: target.id, note: input.note,
      idempotencyKey: input.idempotencyKey, metadata: meta(ctx, { correction: true }),
    });
  } catch (err) {
    if (isUniqueViolation(err, 'tx_corrects_unique')) throw new ConflictError('ALREADY_CORRECTED', 'This transaction has already been corrected');
    throw err;
  }
  if (claimed.replayed) return { transaction: claimed.row, replayed: true };
  if (stockDelta && !(await stockApply(tx, { orgId: actor.orgId, itemId: item.id, locationId: target.locationId, delta: stockDelta }))) {
    throw new ConflictError('CORRECTION_BLOCKED', 'Stock has since been used; reversing this transaction would take it below zero');
  }
  if (custodyDelta && holder) {
    if (custodyDelta > 0) await custodyAdd(tx, { orgId: actor.orgId, itemId: item.id, holder, locationId: target.locationId, jobId: target.jobId, qty: custodyDelta, transactionId: claimed.row.id });
    else if (!(await custodyRemove(tx, { orgId: actor.orgId, itemId: item.id, holder, qty: -custodyDelta }))) {
      throw new ConflictError('CORRECTION_BLOCKED', "The holder's balance has since changed; reversing this transaction is no longer possible");
    }
  }
  return { transaction: claimed.row, replayed: false };
}

void items; void locations;
