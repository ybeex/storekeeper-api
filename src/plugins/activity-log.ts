/**
 * Request-level activity log: "all actions monitored with logs".
 *
 * Domain events (item.created, approval.approved …) are written by the services with before/after state.
 * This plugin is the safety net underneath: EVERY authenticated state-changing request, every data export, and every
 * permission denial is recorded — including actions whose service forgot to audit. It records WHO, WHAT (route pattern,
 * path ids), WHERE FROM (ip) and the OUTCOME (status) — never request bodies, so no passwords/tokens/PII leak into logs.
 *
 * Written after the response is sent and never awaited by the request, so logging cannot slow or fail a user's action.
 * Failures are logged to stderr/metrics rather than swallowed silently.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { auditEvents } from '../db/schema.js';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const activityLogPlugin = fp(async (app: FastifyInstance) => {
  app.addHook('onResponse', async (req, reply) => {
    const user = req.user;
    if (!user) return;
    const status = reply.statusCode;
    const url = req.routeOptions?.url ?? 'unmatched';
    const write = !READ_METHODS.has(req.method);
    const exported = !write && ((req.query as Record<string, unknown> | undefined)?.format === 'csv' || url.endsWith('.csv') || url.endsWith('/qr'));
    const denied = status === 403;
    if (!write && !exported && !denied) return;

    const action = denied ? 'access.denied' : exported ? 'data.exported' : `request.${req.method.toLowerCase()}`;
    // Fire and forget — see the header comment.
    void app.db.insert(auditEvents).values({
      orgId: user.orgId, actorUserId: user.id, action, entityType: 'request', entityId: String(req.id),
      metadata: { method: req.method, route: url, status, params: req.params ?? null, ms: Math.round(reply.elapsedTime) } as never,
      requestId: String(req.id), ip: req.ip,
    }).catch((err) => app.log.warn({ err, action, url }, 'activity log write failed'));
  });
});
