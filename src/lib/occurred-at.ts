/**
 * Offline timestamps (PRD §21). A device clock is untrusted input:
 *  - future beyond a small skew  → clamp to server now
 *  - older than OFFLINE_MAX_AGE  → clamp to the oldest accepted instant
 * The original claim is preserved in metadata so nothing is silently lost.
 */
import { env } from '../env.js';

export interface ResolvedTime { occurredAt: Date; adjusted: boolean; clientOccurredAt?: string }

export function resolveOccurredAt(clientIso: string | undefined | null, now = new Date()): ResolvedTime {
  if (!clientIso) return { occurredAt: now, adjusted: false };
  const t = new Date(clientIso);
  if (Number.isNaN(t.getTime())) return { occurredAt: now, adjusted: true, clientOccurredAt: clientIso };
  const latest = now.getTime() + env.OFFLINE_MAX_CLOCK_SKEW_SECONDS * 1000;
  const earliest = now.getTime() - env.OFFLINE_MAX_AGE_HOURS * 3600 * 1000;
  if (t.getTime() > latest) return { occurredAt: now, adjusted: true, clientOccurredAt: clientIso };
  if (t.getTime() < earliest) return { occurredAt: new Date(earliest), adjusted: true, clientOccurredAt: clientIso };
  return { occurredAt: t, adjusted: false };
}
