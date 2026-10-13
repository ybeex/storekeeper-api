/**
 * Holder helpers (PRD §8). A Holder is a person, a team/department, or a
 * job/site. It is stored as three nullable FK columns (so Postgres enforces
 * referential integrity on each) plus `holder_key`, a stable string used
 * wherever one value must identify "who" (custody uniqueness, grouping).
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { people, teams, jobs } from '../db/schema.js';
import { NotFoundError, ConflictError } from './errors.js';

export type HolderType = 'person' | 'team' | 'job';
export interface HolderRef { type: HolderType; id: string }

export const holderKey = (h: HolderRef) => `${h.type}:${h.id}`;

export function holderColumns(h: HolderRef | null | undefined) {
  return {
    holderType: h?.type ?? null,
    holderPersonId: h?.type === 'person' ? h.id : null,
    holderTeamId: h?.type === 'team' ? h.id : null,
    holderJobId: h?.type === 'job' ? h.id : null,
  };
}

export function holderFromRow(r: {
  holderType: HolderType | null; holderPersonId: string | null; holderTeamId: string | null; holderJobId: string | null;
}): HolderRef | null {
  if (!r.holderType) return null;
  const id = r.holderType === 'person' ? r.holderPersonId : r.holderType === 'team' ? r.holderTeamId : r.holderJobId;
  return id ? { type: r.holderType, id } : null;
}

/** Verifies the holder exists in this org. `forNewIssue` additionally rejects archived/inactive holders
 *  (you can't hand new stock to a departed worker; you must still be able to receive their returns). */
export async function assertHolder(tx: Db, orgId: string, h: HolderRef, forNewIssue: boolean): Promise<string> {
  if (h.type === 'person') {
    const [p] = await tx.select({ n: people.fullName, a: people.active, ar: people.archivedAt }).from(people)
      .where(and(eq(people.id, h.id), eq(people.orgId, orgId))).limit(1);
    if (!p) throw new NotFoundError('Holder');
    if (forNewIssue && (!p.a || p.ar)) throw new ConflictError('HOLDER_INACTIVE', 'This person is inactive and cannot be issued items');
    return p.n;
  }
  if (h.type === 'team') {
    const [t] = await tx.select({ n: teams.name, ar: teams.archivedAt }).from(teams)
      .where(and(eq(teams.id, h.id), eq(teams.orgId, orgId))).limit(1);
    if (!t) throw new NotFoundError('Holder');
    if (forNewIssue && t.ar) throw new ConflictError('HOLDER_INACTIVE', 'This team is archived and cannot be issued items');
    return t.n;
  }
  const [j] = await tx.select({ n: jobs.name, ar: jobs.archivedAt }).from(jobs)
    .where(and(eq(jobs.id, h.id), eq(jobs.orgId, orgId))).limit(1);
  if (!j) throw new NotFoundError('Holder');
  if (forNewIssue && j.ar) throw new ConflictError('HOLDER_INACTIVE', 'This job is archived and cannot be issued items');
  return j.n;
}

export async function assertJob(tx: Db, orgId: string, jobId: string): Promise<void> {
  const [j] = await tx.select({ id: jobs.id }).from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.orgId, orgId), isNull(jobs.archivedAt))).limit(1);
  if (!j) throw new NotFoundError('Job');
}
