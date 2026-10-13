/**
 * The ledger write path: every state change in StoreKeeper goes through the
 * primitives in this file, inside ONE database transaction, in this order:
 *
 *   1. validate (reads)                   — cheap rejections first
 *   2. appendTransaction(...)             — CLAIMS the idempotency key (see claim.ts)
 *   3. guarded mutation of the read model — stock_levels / custody / items.asset_status
 *   4. audit + notify
 *
 * A duplicate request is turned away at step 2, before it can touch
 * anything. A request that loses a race at step 3 throws, rolling back the
 * claim too, so its retry is judged on current state, not poisoned.
 *
 * The read-model mutations are single-statement *guarded* writes
 * (`... WHERE quantity >= n`). The WHERE clause is the lock: two concurrent
 * decrements serialise on the row, the second re-evaluates the predicate, and
 * stock can never go negative — no SELECT-then-UPDATE gap, no explicit locks.
 * The CHECK constraints in the schema are the backstop if code here is ever
 * wrong.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { transactions, stockLevels, custody, items, orgSettings, files } from '../db/schema.js';
import { claimUnique } from './claim.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { holderKey, type HolderRef } from './holders.js';

export const LEDGER_IDEMPOTENCY_CONSTRAINT = 'tx_org_actor_idempotency_unique';

export type NewTransaction = typeof transactions.$inferInsert;
export type TransactionRow = typeof transactions.$inferSelect;
export type ItemRow = typeof items.$inferSelect;
export type AssetStatus = NonNullable<ItemRow['assetStatus']>;

export async function findTransactionByKey(tx: Db, orgId: string, actorUserId: string, key: string): Promise<TransactionRow | undefined> {
  const [row] = await tx.select().from(transactions).where(and(
    eq(transactions.orgId, orgId), eq(transactions.actorUserId, actorUserId), eq(transactions.idempotencyKey, key),
  )).limit(1);
  return row;
}

/**
 * Inserts the ledger row, claiming the idempotency key. Returns `replayed: true`
 * (with the ORIGINAL row) when this key already produced a transaction — the
 * caller must then skip every mutation and return the original result.
 * A key reused for a *different* operation is a client bug and is rejected loudly.
 */
export async function appendTransaction(tx: Db, v: NewTransaction): Promise<{ row: TransactionRow; replayed: boolean }> {
  const sameOperation = (r: TransactionRow) => {
    if (r.itemId !== v.itemId || r.type !== v.type) {
      throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different operation');
    }
  };

  if (!v.idempotencyKey) {
    const [row] = await tx.insert(transactions).values(v).returning();
    return { row, replayed: false };
  }
  const existing = await findTransactionByKey(tx, v.orgId, v.actorUserId, v.idempotencyKey);
  if (existing) { sameOperation(existing); return { row: existing, replayed: true }; }

  const claim = await claimUnique(tx, LEDGER_IDEMPOTENCY_CONSTRAINT, (sp) => sp.insert(transactions).values(v).returning());
  if (claim.claimed) return { row: claim.value[0], replayed: false };

  const winner = await findTransactionByKey(tx, v.orgId, v.actorUserId, v.idempotencyKey);
  if (!winner) throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Concurrent request with the same Idempotency-Key; retry');
  sameOperation(winner);
  return { row: winner, replayed: true };
}

// ── Items ───────────────────────────────────────────────────────────
export async function getActiveItem(tx: Db, orgId: string, itemId: string): Promise<ItemRow> {
  const [item] = await tx.select().from(items).where(and(eq(items.id, itemId), eq(items.orgId, orgId))).limit(1);
  if (!item) throw new NotFoundError('Item');
  if (item.archivedAt) throw new ConflictError('ITEM_ARCHIVED', 'Item is archived');
  return item;
}

/** Compare-and-swap on asset status: succeeds only if the asset is currently in one of `from`. */
export async function casAssetStatus(
  tx: Db, p: { orgId: string; itemId: string; from: AssetStatus[]; to: AssetStatus; locationId?: string; condition?: ItemRow['condition']; actorUserId: string },
): Promise<boolean> {
  const set: Partial<typeof items.$inferInsert> = { assetStatus: p.to, updatedAt: new Date(), updatedBy: p.actorUserId };
  if (p.locationId) set.locationId = p.locationId;
  if (p.condition) set.condition = p.condition;
  const rows = await tx.update(items).set(set).where(and(
    eq(items.id, p.itemId), eq(items.orgId, p.orgId),
    sql`${items.assetStatus} in (${sql.join(p.from.map((s) => sql`${s}::asset_status`), sql`, `)})`,
  )).returning({ id: items.id });
  return rows.length > 0;
}

// ── Stock (consumables) ─────────────────────────────────────────────
type StockKey = { orgId: string; itemId: string; locationId: string };

/** Guarded decrement. false => insufficient stock (nothing changed). */
export async function stockDecrement(tx: Db, p: StockKey & { qty: number }): Promise<boolean> {
  const rows = await tx.update(stockLevels).set({ quantity: sql`${stockLevels.quantity} - ${p.qty}`, updatedAt: new Date() })
    .where(and(
      eq(stockLevels.orgId, p.orgId), eq(stockLevels.itemId, p.itemId), eq(stockLevels.locationId, p.locationId),
      sql`${stockLevels.quantity} >= ${p.qty}`,
    )).returning({ q: stockLevels.quantity });
  return rows.length > 0;
}

export async function stockIncrement(tx: Db, p: StockKey & { qty: number }): Promise<void> {
  await tx.insert(stockLevels).values({ orgId: p.orgId, itemId: p.itemId, locationId: p.locationId, quantity: p.qty })
    .onConflictDoUpdate({
      target: [stockLevels.itemId, stockLevels.locationId],
      set: { quantity: sql`${stockLevels.quantity} + ${p.qty}`, updatedAt: new Date() },
    });
}

/** Signed delta. Negative deltas are guarded; returns false if they would go below zero. */
export async function stockApply(tx: Db, p: StockKey & { delta: number }): Promise<boolean> {
  if (p.delta >= 0) { if (p.delta > 0) await stockIncrement(tx, { ...p, qty: p.delta }); else await ensureStockRow(tx, p); return true; }
  return stockDecrement(tx, { ...p, qty: -p.delta });
}

async function ensureStockRow(tx: Db, p: StockKey) {
  await tx.insert(stockLevels).values({ orgId: p.orgId, itemId: p.itemId, locationId: p.locationId, quantity: 0 }).onConflictDoNothing();
}

export async function getStock(tx: Db, p: StockKey): Promise<number> {
  const [r] = await tx.select({ q: stockLevels.quantity }).from(stockLevels).where(and(
    eq(stockLevels.orgId, p.orgId), eq(stockLevels.itemId, p.itemId), eq(stockLevels.locationId, p.locationId))).limit(1);
  return r?.q ?? 0;
}

// ── Custody (who holds what) ────────────────────────────────────────
export async function custodyAdd(tx: Db, p: {
  orgId: string; itemId: string; holder: HolderRef; locationId: string; jobId?: string | null;
  qty: number; dueAt?: Date | null; transactionId: string;
}): Promise<void> {
  const col = {
    holderPersonId: p.holder.type === 'person' ? p.holder.id : null,
    holderTeamId: p.holder.type === 'team' ? p.holder.id : null,
    holderJobId: p.holder.type === 'job' ? p.holder.id : null,
  };
  await tx.insert(custody).values({
    orgId: p.orgId, itemId: p.itemId, holderType: p.holder.type, ...col, holderKey: holderKey(p.holder),
    locationId: p.locationId, jobId: p.jobId ?? null, quantity: p.qty, issuedQuantity: p.qty, dueAt: p.dueAt ?? null, lastTransactionId: p.transactionId,
  }).onConflictDoUpdate({
    target: [custody.orgId, custody.itemId, custody.holderKey],
    set: { quantity: sql`${custody.quantity} + ${p.qty}`, issuedQuantity: sql`${custody.issuedQuantity} + ${p.qty}`, updatedAt: new Date(), lastTransactionId: p.transactionId,
      dueAt: sql`case when ${custody.dueAt} is null then excluded.due_at when excluded.due_at is null then ${custody.dueAt} else least(${custody.dueAt}, excluded.due_at) end` },
  });
}

/** Guarded decrement of a holder's balance; deletes the row when it reaches zero. false => holder doesn't hold that much. */
export async function custodyRemove(tx: Db, p: { orgId: string; itemId: string; holder: HolderRef; qty: number }): Promise<boolean> {
  const rows = await tx.update(custody).set({ quantity: sql`${custody.quantity} - ${p.qty}`, updatedAt: new Date() }).where(and(
    eq(custody.orgId, p.orgId), eq(custody.itemId, p.itemId), eq(custody.holderKey, holderKey(p.holder)),
    sql`${custody.quantity} >= ${p.qty}`,
  )).returning({ id: custody.id, q: custody.quantity });
  if (rows.length === 0) return false;
  if (rows[0].q === 0) await tx.delete(custody).where(and(eq(custody.id, rows[0].id), eq(custody.quantity, 0)));
  return true;
}

export async function getCustodyQty(tx: Db, orgId: string, itemId: string, holder: HolderRef): Promise<number> {
  const [r] = await tx.select({ q: custody.quantity }).from(custody).where(and(
    eq(custody.orgId, orgId), eq(custody.itemId, itemId), eq(custody.holderKey, holderKey(holder)))).limit(1);
  return r?.q ?? 0;
}

// ── Policy-driven requirements ──────────────────────────────────────
/** PRD §23: a snapshot is optional unless org policy requires one for this transaction type. */
export async function checkSnapshot(tx: Db, orgId: string, type: string, snapshotFileId?: string | null): Promise<void> {
  if (snapshotFileId) {
    const [f] = await tx.select({ id: files.id, kind: files.kind }).from(files).where(and(eq(files.id, snapshotFileId), eq(files.orgId, orgId))).limit(1);
    if (!f || f.kind !== 'transaction_snapshot') throw new ValidationError('snapshotFileId must reference an uploaded transaction snapshot');
    return;
  }
  const [s] = await tx.select({ req: orgSettings.photoRequiredFor }).from(orgSettings).where(eq(orgSettings.orgId, orgId)).limit(1);
  if (s?.req?.includes(type)) throw new ValidationError(`A photo snapshot is required for ${type} transactions`, { code: 'SNAPSHOT_REQUIRED' });
}
