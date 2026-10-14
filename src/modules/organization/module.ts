import type { ApiFastifyInstance } from '../../types.js';
/** Organization settings + approval policies (PRD §18, §23, §30, §32). Schema, service and routes in one file: it is small. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { orgSettings, approvalPolicies, organizations } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import type { Principal } from '../../lib/locations.js';

const TX_TYPES = ['checkout', 'checkin', 'consume', 'restock', 'adjustment', 'loss', 'damage', 'condition_update', 'status_change', 'reconciliation_adjustment', 'transfer'] as const;
const lit = <T extends readonly string[]>(xs: T) => Type.Union(xs.map((x) => Type.Literal(x)) as never);

const PatchSettings = Type.Object({
  requireReconciliationReason: Type.Optional(Type.Boolean()),
  photoRequiredFor: Type.Optional(Type.Array(lit(TX_TYPES), { uniqueItems: true })),
  defaultExpectedReturnHours: Type.Optional(Type.Union([Type.Integer({ minimum: 1, maximum: 24 * 365 }), Type.Null()])),
  timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
}, { additionalProperties: false, minProperties: 1 });

const OPS = ['adjustment', 'loss', 'damage', 'retirement', 'manual_correction', 'checkout', 'checkin'] as const;
const PutPolicies = Type.Object({
  policies: Type.Array(Type.Object({
    operation: Type.Union([
      Type.Literal('adjustment'), Type.Literal('loss'), Type.Literal('damage'), Type.Literal('retirement'),
      Type.Literal('manual_correction'), Type.Literal('checkout'), Type.Literal('checkin'),
    ]),
    mode: Type.Union([Type.Literal('direct'), Type.Literal('request'), Type.Literal('approval')]),
    largeThreshold: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
  }, { additionalProperties: false }), { minItems: 1, maxItems: OPS.length }),
}, { additionalProperties: false });

async function getSettings(db: Db, orgId: string) {
  const [s] = await db.select().from(orgSettings).where(eq(orgSettings.orgId, orgId)).limit(1);
  if (!s) throw new NotFoundError('Organization settings');
  const [o] = await db.select({ name: organizations.name, slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
  return { organization: o, ...s, updatedAt: s.updatedAt.toISOString() };
}

export async function organizationRoutes(app: ApiFastifyInstance) {
  app.get('/settings', { preHandler: [app.authenticate, anyRole] }, async (req) => getSettings(req.server.db, req.user!.orgId));

  app.patch('/settings', { preHandler: [app.authenticate, requireRole('admin')], schema: { body: PatchSettings } }, async (req) => {
    const actor = req.user! as Principal;
    const settings = req.body as { requireReconciliationReason?: boolean; photoRequiredFor?: (typeof TX_TYPES)[number][]; defaultExpectedReturnHours?: number | null; timezone?: string };
    if (settings.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: settings.timezone }); } catch { throw new ValidationError('timezone must be a valid IANA time zone, e.g. Africa/Lagos'); } }
    await req.server.db.transaction(async (tx) => {
      const [before] = await tx.select().from(orgSettings).where(eq(orgSettings.orgId, actor.orgId)).for('update').limit(1);
      await tx.update(orgSettings).set({ ...settings, updatedAt: new Date() }).where(eq(orgSettings.orgId, actor.orgId));
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'settings.updated', entityType: 'org_settings', entityId: actor.orgId, previous: before, next: settings });
    });
    return getSettings(req.server.db, actor.orgId);
  });

  app.get('/approval-policies', { preHandler: [app.authenticate, anyRole] }, async (req) => {
    const rows = await req.server.db.select().from(approvalPolicies).where(eq(approvalPolicies.orgId, req.user!.orgId));
    return { policies: rows.map((r) => ({ operation: r.operation, mode: r.mode, largeThreshold: r.largeThreshold })) };
  });

  app.put('/approval-policies', { preHandler: [app.authenticate, requireRole('admin')], schema: { body: PutPolicies } }, async (req) => {
    const actor = req.user!;
    await req.server.db.transaction(async (tx) => {
      const before = await tx.select().from(approvalPolicies).where(eq(approvalPolicies.orgId, actor.orgId));
      for (const p of req.body.policies) {
        await tx.insert(approvalPolicies).values({ orgId: actor.orgId, operation: p.operation, mode: p.mode, largeThreshold: p.largeThreshold ?? null })
          .onConflictDoUpdate({ target: [approvalPolicies.orgId, approvalPolicies.operation], set: { mode: p.mode, largeThreshold: p.largeThreshold ?? null, updatedAt: new Date() } });
      }
      await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'approval_policies.updated', entityType: 'approval_policies', entityId: actor.orgId, previous: before, next: req.body.policies });
    });
    const rows = await req.server.db.select().from(approvalPolicies).where(eq(approvalPolicies.orgId, actor.orgId));
    return { policies: rows.map((r) => ({ operation: r.operation, mode: r.mode, largeThreshold: r.largeThreshold })) };
  });
}
