/** Background jobs: email outbox, overdue scan, integrity check, scheduled counts, housekeeping. Every handler is idempotent. */
import { and, eq, lte, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { custody, emailOutbox, items, idempotencyKeys, organizations, people, teams, jobs, sessions, userTokens, notifications } from '../../db/schema.js';
import { env } from '../../env.js';
import { sendMail, PermanentMailError } from '../../lib/mailer.js';
import { DependencyUnavailableError } from '../../lib/circuit-breaker.js';
import { notify } from '../../lib/notify.js';
import { emailsTotal, inventoryDiscrepancies } from '../../lib/metrics.js';
import { registerJob, scheduleRepeatable } from '../../lib/jobs.js';
import { deleteObject } from '../../lib/storage.js';
import { files } from '../../db/schema.js';
import { db as rootDb } from '../../db/index.js';
import { runScheduleScan } from '../reconciliation/module.js';
import { sweepImports } from '../imports/module.js';

const MAX_ATTEMPTS = 8;

/** Deliver due emails. SKIP LOCKED lets several workers drain the outbox concurrently without double-sending. */
export async function processOutbox(db: Db, batch = 50): Promise<{ sent: number; failed: number; paused: boolean }> {
  let sent = 0; let failed = 0; let paused = false;
  await db.transaction(async (tx) => {
    const due = await tx.select().from(emailOutbox).where(and(eq(emailOutbox.status, 'pending'), lte(emailOutbox.nextAttemptAt, new Date())))
      .orderBy(emailOutbox.nextAttemptAt).limit(batch).for('update', { skipLocked: true });
    for (const m of due) {
      if (!env.MAIL_ENABLED) {
        await tx.update(emailOutbox).set({ status: 'sent', sentAt: new Date(), lastError: 'MAIL_ENABLED=false (not delivered)' }).where(eq(emailOutbox.id, m.id));
        sent++; continue;
      }
      try {
        await sendMail(m.toEmail, m.subject, m.textBody);
        await tx.update(emailOutbox).set({ status: 'sent', sentAt: new Date(), attempts: m.attempts + 1, lastError: null }).where(eq(emailOutbox.id, m.id));
        emailsTotal.inc({ outcome: 'sent' }); sent++;
      } catch (err) {
        if (err instanceof DependencyUnavailableError) { paused = true; break; } // our side is shedding load: don't burn this message's attempts
        const attempts = m.attempts + 1;
        const permanent = err instanceof PermanentMailError || attempts >= MAX_ATTEMPTS;
        await tx.update(emailOutbox).set({
          attempts, status: permanent ? 'dead' : 'pending', lastError: String((err as Error).message).slice(0, 500),
          nextAttemptAt: new Date(Date.now() + Math.min(2 ** attempts, 360) * 60_000), // 2,4,8… minutes, capped at 6h
        }).where(eq(emailOutbox.id, m.id));
        emailsTotal.inc({ outcome: permanent ? 'dead' : 'retry' }); failed++;
      }
    }
  });
  return { sent, failed, paused };
}

/** PRD §27/§30: one notification per overdue checkout episode. */
export async function scanOverdue(db: Db): Promise<number> {
  const rows = await db.select({
    id: custody.id, orgId: custody.orgId, itemId: custody.itemId, dueAt: custody.dueAt, itemName: items.name,
    holder: sql<string | null>`coalesce(${people.fullName}, ${teams.name}, ${jobs.name})`,
  }).from(custody).innerJoin(items, eq(custody.itemId, items.id))
    .leftJoin(people, eq(custody.holderPersonId, people.id)).leftJoin(teams, eq(custody.holderTeamId, teams.id)).leftJoin(jobs, eq(custody.holderJobId, jobs.id))
    .where(and(sql`${custody.quantity} > 0`, lt(custody.dueAt, new Date()))).limit(2000);
  let n = 0;
  for (const r of rows) {
    const created = await db.transaction((tx) => notify(tx as unknown as Db, {
      orgId: r.orgId, type: 'overdue_checkout', entityType: 'item', entityId: r.itemId, dedupeKey: `overdue:${r.id}`,
      title: `Overdue: ${r.itemName}`, body: `${r.itemName} was due back ${r.dueAt!.toUTCString()} and is still with ${r.holder ?? 'its holder'}.`,
      data: { itemId: r.itemId, custodyId: r.id, dueAt: r.dueAt!.toISOString() }, audienceRoles: ['admin', 'supervisor', 'store_staff'],
    }));
    if (created) n++;
  }
  return n;
}

/**
 * PRD §12 + §39: prove the denormalised read models still equal the ledger.
 * A mismatch means a bug, a manual DB edit, or corruption — all of which an operator
 * must hear about immediately, not discover at the next stock count.
 */
export async function checkIntegrity(db: Db): Promise<{ stock: number; custody: number }> {
  const stockBad = await db.execute(sql`
    select coalesce(l.org_id, s.org_id) as org_id, coalesce(l.item_id, s.item_id) as item_id, coalesce(l.location_id, s.location_id) as location_id,
           coalesce(l.q, 0) as ledger, coalesce(s.quantity, 0) as actual
    from (select org_id, item_id, location_id, sum(stock_delta)::int q from transactions where stock_delta is not null group by 1,2,3) l
    full join stock_levels s on s.item_id = l.item_id and s.location_id = l.location_id
    where coalesce(l.q, 0) <> coalesce(s.quantity, 0) limit 200`);
  const custodyBad = await db.execute(sql`
    select coalesce(l.org_id, c.org_id) as org_id, coalesce(l.item_id, c.item_id) as item_id, coalesce(l.hk, c.holder_key) as holder_key,
           coalesce(l.q, 0) as ledger, coalesce(c.quantity, 0) as actual
    from (select org_id, item_id, holder_type::text || ':' || coalesce(holder_person_id, holder_team_id, holder_job_id)::text hk, sum(custody_delta)::int q
          from transactions where custody_delta is not null and holder_type is not null group by 1,2,3) l
    full join custody c on c.item_id = l.item_id and c.holder_key = l.hk
    where coalesce(l.q, 0) <> coalesce(c.quantity, 0) limit 200`);
  const bad = [...(stockBad as unknown as Record<string, unknown>[]), ...(custodyBad as unknown as Record<string, unknown>[])];
  inventoryDiscrepancies.set(bad.length);
  const byOrg = new Map<string, number>();
  for (const r of bad) byOrg.set(String(r.org_id), (byOrg.get(String(r.org_id)) ?? 0) + 1);
  const day = new Date().toISOString().slice(0, 10);
  for (const [orgId, count] of byOrg) {
    await db.transaction((tx) => notify(tx as unknown as Db, {
      orgId, type: 'integrity_alert', dedupeKey: `integrity:${day}`, audienceRoles: ['admin'],
      title: 'Inventory integrity check found discrepancies', body: `${count} record(s) disagree with the transaction ledger. Contact support before making further adjustments.`,
      data: { count },
    }));
  }
  return { stock: (stockBad as unknown as unknown[]).length, custody: (custodyBad as unknown as unknown[]).length };
}

/**
 * Uploads that never got attached to anything (an item photo chosen then abandoned, a snapshot for a cancelled
 * checkout) are deleted after a day. The row goes first: the foreign keys make Postgres refuse if anything
 * references it after all, so a race can never delete a file that is in use. A failed object delete only leaves
 * an unreferenced blob behind, which the bucket's lifecycle rule can sweep.
 */
export async function purgeOrphanFiles(db: Db): Promise<number> {
  const rows = (await db.execute(sql`
    select f.id, f.storage_key from files f
    where f.created_at < now() - interval '1 day'
      and not exists (select 1 from items i where i.photo_file_id = f.id)
      and not exists (select 1 from transactions t where t.snapshot_file_id = f.id)
      and not exists (select 1 from reconciliation_counts r where r.snapshot_file_id = f.id)
    limit 200`)) as unknown as Array<{ id: string; storage_key: string }>;
  let n = 0;
  for (const r of rows) {
    try { await db.delete(files).where(eq(files.id, r.id)); } catch { continue; } // referenced after all
    n++;
    await deleteObject(r.storage_key).catch(() => undefined);
  }
  return n;
}

/** Retention: expired idempotency keys, sessions, spent tokens, sent outbox rows, old read notifications. */
export async function housekeeping(db: Db): Promise<void> {
  const now = new Date(); const ago = (d: number) => new Date(Date.now() - d * 86_400_000);
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.expiresAt, now));
  await db.delete(sessions).where(lt(sessions.expiresAt, now));
  await db.delete(userTokens).where(lt(userTokens.expiresAt, ago(7)));
  await db.delete(emailOutbox).where(and(eq(emailOutbox.status, 'sent'), lt(emailOutbox.sentAt, ago(30))));
  await db.delete(notifications).where(lt(notifications.createdAt, ago(180)));
  await purgeOrphanFiles(db);
  await sweepImports(db);
}

export function registerOpsJobs() {
  registerJob('outbox.process', () => processOutbox(rootDb).then(() => undefined));
  registerJob('overdue.scan', () => scanOverdue(rootDb).then(() => undefined));
  registerJob('integrity.check', () => checkIntegrity(rootDb).then(() => undefined));
  registerJob('reconciliation.schedules', () => runScheduleScan(rootDb).then(() => undefined));
  registerJob('housekeeping', () => housekeeping(rootDb));
}

export async function scheduleOpsJobs() {
  await scheduleRepeatable('outbox.process', '* * * * *');
  await scheduleRepeatable('overdue.scan', env.OVERDUE_SCAN_CRON);
  await scheduleRepeatable('reconciliation.schedules', '*/15 * * * *');
  await scheduleRepeatable('integrity.check', '17 2 * * *');
  await scheduleRepeatable('housekeeping', '43 3 * * *');
}
void organizations;
