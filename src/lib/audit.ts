/** Audit trail (PRD §24): who, what, previous and new state, why. Written in the caller's DB transaction. */
import type { Db } from '../db/index.js';
import { auditEvents } from '../db/schema.js';

export interface AuditInput {
  orgId: string;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  previous?: unknown;
  next?: unknown;
  reason?: string | null;
  transactionId?: string | null;
  metadata?: Record<string, unknown>;
  requestId?: string;
}

/** Never put secrets (password hashes, tokens) in previous/next. Callers pass explicit field lists. */
export async function audit(tx: Db, a: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    orgId: a.orgId, actorUserId: a.actorUserId ?? null, action: a.action,
    entityType: a.entityType, entityId: a.entityId,
    previousState: (a.previous ?? null) as never, newState: (a.next ?? null) as never,
    reason: a.reason ?? null, transactionId: a.transactionId ?? null,
    metadata: (a.metadata ?? null) as never, requestId: a.requestId,
  });
}
