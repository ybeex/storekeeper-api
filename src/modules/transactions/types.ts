import type { Principal } from '../../lib/locations.js';
import type { HolderRef } from '../../lib/holders.js';
import type { TransactionRow } from '../../lib/ledger.js';

/** Who/where/how an operation is being executed. The same ops run for live API calls, offline replays and approved requests. */
export interface OpContext {
  actor: Principal;
  source: 'online' | 'offline_sync' | 'system';
  deviceId?: string;
  occurredAt?: Date;
  /** Extra provenance written to ledger metadata (e.g. clamped offline time, approving user). */
  meta?: Record<string, unknown>;
}

export interface OpResult {
  transaction: TransactionRow;
  replayed: boolean;
  dueAt?: Date | null;
}

interface Common { itemId: string; note?: string; snapshotFileId?: string; idempotencyKey?: string }

export interface CheckoutInput extends Common {
  holder: HolderRef; quantity?: number; jobId?: string; purpose?: string; locationId?: string;
  condition?: 'good' | 'damaged' | 'needs_inspection' | 'replaced'; expectedReturnAt?: string;
}
export interface CheckinInput extends Common {
  holder?: HolderRef; quantity?: number; locationId?: string;
  condition?: 'good' | 'damaged' | 'needs_inspection' | 'replaced'; acceptOverReturn?: boolean;
}
export interface ConsumeInput extends Common { quantity: number; locationId?: string; jobId?: string; purpose?: string; holder?: HolderRef }
export interface RestockInput extends Common { quantity: number; locationId?: string }
export interface AdjustmentInput extends Common {
  delta: number; reason: 'count_correction' | 'opening_balance' | 'unrecorded_movement' | 'damage' | 'loss' | 'other'; locationId?: string;
  /** Set when the adjustment resolves a stock-count variance; recorded as type reconciliation_adjustment (PRD §19). */
  reconciliationCountId?: string;
}
export interface IncidentInput extends Common { quantity?: number; holder?: HolderRef; locationId?: string; reason?: string }
export interface ConditionInput extends Common { condition: 'good' | 'damaged' | 'needs_inspection' | 'replaced' }
export interface StatusInput extends Common { to: 'available' | 'under_repair' | 'retired' }
export interface TransferInput extends Common { fromLocationId: string; toLocationId: string; quantity?: number }
export interface CorrectionInput { transactionId: string; note: string; idempotencyKey?: string }
export interface ReplacementInput extends Common { replacementItemId: string }
