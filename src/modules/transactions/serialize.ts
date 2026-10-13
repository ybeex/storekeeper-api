import type { TransactionRow } from '../../lib/ledger.js';
import { holderFromRow } from '../../lib/holders.js';

export function serializeTx(t: TransactionRow) {
  return {
    id: t.id, seq: t.seq, type: t.type, itemId: t.itemId, itemType: t.itemType, locationId: t.locationId, counterpartLocationId: t.counterpartLocationId,
    quantity: t.quantity, stockDelta: t.stockDelta, custodyDelta: t.custodyDelta, actorUserId: t.actorUserId, holder: holderFromRow(t), jobId: t.jobId,
    purpose: t.purpose, condition: t.condition, fromStatus: t.fromStatus, toStatus: t.toStatus, reason: t.reason, note: t.note, snapshotFileId: t.snapshotFileId,
    correctsTransactionId: t.correctsTransactionId, relatedTransactionId: t.relatedTransactionId, source: t.source, deviceId: t.deviceId,
    occurredAt: t.occurredAt.toISOString(), recordedAt: t.createdAt.toISOString(), metadata: t.metadata,
  };
}
