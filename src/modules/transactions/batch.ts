/**
 * Batch checkout (PRD §14): one logical operation, one DB transaction, one
 * ledger row per line. All-or-nothing — a single unavailable item rolls back the
 * whole batch and the error says which line failed.
 *
 * Lines are processed in item-id order so two concurrent batches touching
 * overlapping items acquire row locks in the same order and cannot deadlock.
 */
import type { Db } from '../../db/index.js';
import { AppError, ValidationError } from '../../lib/errors.js';
import { doCheckout } from './movement.js';
import type { CheckoutInput, OpContext, OpResult } from './types.js';

export interface BatchInput {
  holder: CheckoutInput['holder']; jobId?: string; purpose?: string; locationId?: string; note?: string; snapshotFileId?: string; idempotencyKey?: string;
  lines: Array<{ itemId: string; quantity?: number; condition?: CheckoutInput['condition'] }>;
}

export async function doBatchCheckout(tx: Db, ctx: OpContext, input: BatchInput): Promise<{ results: Array<OpResult & { index: number }>; replayed: boolean }> {
  const ids = input.lines.map((l) => l.itemId);
  if (new Set(ids).size !== ids.length) throw new ValidationError('Each item may appear only once per batch');
  const ordered = input.lines.map((line, index) => ({ line, index })).sort((a, b) => (a.line.itemId < b.line.itemId ? -1 : 1));
  const results: Array<OpResult & { index: number }> = [];
  for (const { line, index } of ordered) {
    try {
      const r = await doCheckout(tx, ctx, {
        itemId: line.itemId, quantity: line.quantity, condition: line.condition, holder: input.holder, jobId: input.jobId, purpose: input.purpose,
        locationId: input.locationId, note: input.note, snapshotFileId: input.snapshotFileId,
        idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${index}` : undefined,
      });
      results.push({ ...r, index });
    } catch (err) {
      if (err instanceof AppError) throw new AppError(err.statusCode, err.code, `Line ${index + 1}: ${err.message}`, { lineIndex: index, itemId: line.itemId, ...(typeof err.details === 'object' && err.details ? err.details : {}) });
      throw err;
    }
  }
  results.sort((a, b) => a.index - b.index);
  return { results, replayed: results.length > 0 && results.every((r) => r.replayed) };
}
