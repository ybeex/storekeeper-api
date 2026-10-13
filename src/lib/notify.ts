/**
 * In-app notifications + email fan-out (PRD §30), driven by org-wide, role-based rules.
 *
 * Per notification TYPE the org decides: which roles receive it, whether it shows in-app, whether it is emailed
 * (table `notification_rules`; no row = DEFAULT_RULES below). A caller may only NARROW the audience
 * (e.g. approvals that need an admin) — it can never widen beyond the org's rule, except announcements,
 * whose audience is chosen explicitly by the sender (and role-checked by the route).
 *
 * Written in the caller's DB transaction (transactional outbox): if the business event rolls back, the
 * notification and its emails vanish with it; if it commits, delivery is guaranteed to be attempted by the
 * worker. The request path never talks to SMTP.
 *
 * `dedupeKey` makes a recurring condition (e.g. low stock on item X) notify once per episode.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { notifications, notificationRules, users, emailOutbox } from '../db/schema.js';

export type NotificationType = typeof notifications.$inferInsert['type'];
export type Role = 'admin' | 'store_staff' | 'supervisor' | 'viewer';
export interface Rule { roles: Role[]; inApp: boolean; email: boolean }

const ALL: Role[] = ['admin', 'supervisor', 'store_staff', 'viewer'];
export const DEFAULT_RULES: Record<NotificationType, Rule> = {
  low_stock: { roles: ['admin', 'supervisor', 'store_staff'], inApp: true, email: false },
  overdue_checkout: { roles: ['admin', 'supervisor', 'store_staff'], inApp: true, email: false },
  reconciliation_discrepancy: { roles: ['admin', 'supervisor'], inApp: true, email: false },
  reconciliation_due: { roles: ['admin', 'supervisor', 'store_staff'], inApp: true, email: false },
  sync_failure: { roles: ['admin', 'supervisor'], inApp: true, email: false },
  approval_pending: { roles: ['admin', 'supervisor'], inApp: true, email: false },
  approval_resolved: { roles: ['admin', 'supervisor', 'store_staff'], inApp: true, email: false },
  integrity_alert: { roles: ['admin'], inApp: true, email: true },
  announcement: { roles: ALL, inApp: true, email: false },
};

/** What each alert is, in plain words. Shown next to the switches on the Rules screen so an admin knows what they are routing. */
export const RULE_INFO: Record<NotificationType, { label: string; description: string }> = {
  low_stock: { label: 'Low stock', description: 'A consumable has dropped to or below its minimum level. Sent once per episode, not on every movement.' },
  overdue_checkout: { label: 'Overdue checkout', description: 'Something issued to a person, team or job is past its expected return time.' },
  reconciliation_discrepancy: { label: 'Count discrepancy', description: 'A physical count did not match the system quantity.' },
  reconciliation_due: { label: 'Count due', description: 'A scheduled stock count is due or overdue.' },
  sync_failure: { label: 'Offline sync problem', description: 'An action saved on a device could not be applied and needs a decision.' },
  approval_pending: { label: 'Approval needed', description: 'Someone has asked for an adjustment, loss, retirement or correction that needs sign-off.' },
  approval_resolved: { label: 'Approval decided', description: 'A request you made was approved or rejected.' },
  integrity_alert: { label: 'Data integrity alert', description: 'The nightly check found the ledger and the stock levels disagree. Rare, and always worth a look.' },
  announcement: { label: 'Announcements', description: 'Messages an administrator or supervisor sends to chosen roles. Who receives each one is chosen when it is sent.' },
};

export async function getRule(tx: Db, orgId: string, type: NotificationType): Promise<Rule> {
  const [r] = await tx.select().from(notificationRules).where(and(eq(notificationRules.orgId, orgId), eq(notificationRules.type, type))).limit(1);
  return r ? { roles: r.roles as Role[], inApp: r.inApp, email: r.email } : DEFAULT_RULES[type];
}

export interface NotifyInput {
  orgId: string;
  type: NotificationType;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  data?: Record<string, unknown>;
  /** Narrows the org rule's audience (intersection). With `explicitAudience` it IS the audience. */
  audienceRoles?: Role[];
  explicitAudience?: boolean;
  /** Force email on/off regardless of the org rule (announcements). */
  email?: boolean;
  dedupeKey?: string;
}

/** Returns true if anything was delivered/queued (false = suppressed by rule, dedupe, or empty audience). */
export async function notify(tx: Db, n: NotifyInput): Promise<boolean> {
  const rule = await getRule(tx, n.orgId, n.type);
  const roles: Role[] = n.explicitAudience && n.audienceRoles ? n.audienceRoles : n.audienceRoles ? rule.roles.filter((r) => n.audienceRoles!.includes(r)) : rule.roles;
  const wantEmail = n.email ?? rule.email;
  if (roles.length === 0 || (!rule.inApp && !wantEmail && !n.explicitAudience)) return false;
  const inApp = rule.inApp || !!n.explicitAudience;

  if (inApp) {
    const inserted = await tx.insert(notifications).values({
      orgId: n.orgId, type: n.type, title: n.title, body: n.body, entityType: n.entityType, entityId: n.entityId,
      data: (n.data ?? null) as never, audienceRoles: roles, dedupeKey: n.dedupeKey,
    }).onConflictDoNothing().returning({ id: notifications.id });
    if (inserted.length === 0) return false; // already notified for this episode
  }
  if (!wantEmail) return inApp;

  const recipients = await tx.select({ id: users.id, email: users.email }).from(users)
    .where(and(eq(users.orgId, n.orgId), eq(users.active, true), inArray(users.role, roles)));
  if (recipients.length === 0) return inApp;
  const res = await tx.insert(emailOutbox).values(recipients.map((r) => ({
    orgId: n.orgId, toEmail: r.email, subject: n.title, textBody: n.body,
    dedupeKey: n.dedupeKey ? `${n.dedupeKey}:${r.id}` : undefined,
  }))).onConflictDoNothing().returning({ id: emailOutbox.id });
  return inApp || res.length > 0;
}

/** Queue a transactional email (invites, resets). Delivered by the worker; never sent inline. */
export async function queueEmail(tx: Db, e: { orgId: string; to: string; subject: string; text: string; dedupeKey?: string }): Promise<void> {
  await tx.insert(emailOutbox).values({
    orgId: e.orgId, toEmail: e.to, subject: e.subject, textBody: e.text, dedupeKey: e.dedupeKey,
  }).onConflictDoNothing();
}
