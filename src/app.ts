/**
 * Composition root. Building the app as a function that returns an
 * unstarted Fastify instance (rather than calling `.listen()` at
 * import time) is what lets test/*.test.ts spin up a real app against
 * a test database without binding a port — see test/checkout.
 * concurrency.test.ts for that pattern.
 *
 * Registration order matters and is not arbitrary:
 *   1. error-handler   — must exist before anything can throw through it
 *   2. redis, db       — infrastructure every other plugin depends on
 *   3. security         — rate limiting needs redis; must wrap everything after it
 *   4. auth, rbac        — needs db + redis (session cache)
 *   5. idempotency       — needs db + redis + req.user from auth
 *   6. multipart          — only the import module's upload route needs it
 *   7. swagger/docs         — introspects the routes registered after this point
 *   8. module routes          — the actual API, under /v1
 */
import Fastify from 'fastify';
import type { ApiFastifyInstance } from './types.js';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import multipart from '@fastify/multipart';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';

import errorHandlerPlugin from './plugins/error-handler.js';
import redisPlugin from './plugins/redis.js';
import dbPlugin from './plugins/db.js';
import securityPlugin from './plugins/security.js';
import authPlugin from './plugins/auth.js';
import idempotencyPlugin from './plugins/idempotency.js';

import { authRoutes } from './modules/auth/routes.js';
import { userRoutes } from './modules/users/routes.js';
import { accountRoutes } from './modules/account/module.js';
import { organizationRoutes } from './modules/organization/module.js';
import { locationRoutes } from './modules/locations/module.js';
import { peopleRoutes } from './modules/people/module.js';
import { teamRoutes } from './modules/teams/module.js';
import { jobRoutes } from './modules/jobs/module.js';
import { categoryRoutes } from './modules/categories/module.js';
import { fileRoutes } from './modules/files/module.js';
import { itemRoutes } from './modules/items/routes.js';
import { transactionRoutes } from './modules/transactions/routes.js';
import { approvalRoutes } from './modules/approvals/routes.js';
import { reconciliationRoutes } from './modules/reconciliation/module.js';
import { importRoutes } from './modules/imports/module.js';
import { syncRoutes } from './modules/sync/module.js';
import { notificationRoutes } from './modules/notifications/module.js';
import { viewRoutes } from './modules/views/module.js';
import { reportRoutes } from './modules/reports/module.js';
import { analyticsRoutes } from './modules/analytics/module.js';
import { healthRoutes } from './modules/ops/health.js';
import { shelfRoutes } from './modules/shelves/module.js';
import { auditRoutes } from './modules/audit/module.js';
import { activityRoutes } from './modules/activity/module.js';
import { activityLogPlugin } from './plugins/activity-log.js';
import { registerOpsJobs } from './modules/ops/jobs.js';
import { httpDuration } from './lib/metrics.js';
import { bumpOrgVersion } from './lib/cache.js';
import { env } from './env.js';

function parseTrustProxy(v: string): boolean | string {
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  return v;
}

export async function buildApp(): Promise<ApiFastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never let a password, session token, or Authorization header
      // reach the log pipeline, structured or not — see security.md.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'req.body.password', 'req.body.newPassword', 'req.body.currentPassword', 'req.body.token', 'req.body.passwordHash'],
        censor: '[redacted]',
      },
    },
    genReqId: () => randomUUID(),
    trustProxy: parseTrustProxy(env.TRUST_PROXY), // see TRUST_PROXY in env.ts
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Route table for the RBAC-coverage test (test/security.test.ts): every route must be either public or authenticated.
  const routeTable: Array<{ method: string | string[]; url: string }> = [];
  app.addHook('onRoute', (r) => { routeTable.push({ method: r.method, url: r.url }); });
  app.decorate('routeTable', routeTable);

  await app.register(errorHandlerPlugin);
  await app.register(redisPlugin);
  await app.register(dbPlugin);
  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(activityLogPlugin);
  await app.register(idempotencyPlugin);

  await app.register(multipart, {
    limits: {
      fileSize: Math.max(10, env.IMPORT_MAX_MB) * 1024 * 1024, // ceiling only; each upload route sets its own (photos: MAX_IMAGE_BYTES, CSV: IMPORT_MAX_MB)
      files: 1,
    },
  });

  if (env.NODE_ENV !== 'production') {
    await app.register(swagger, {
      openapi: {
        info: { title: 'StoreKeeper API', version: '1.0.0' },
        components: {
          securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
        },
      },
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  // A successful write makes this organisation's cached dashboard numbers stale. Bumped in onSend (before the response
  // reaches the client) so the refetch the browser fires right after a mutation can never read the old answer.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && reply.statusCode < 400 && req.user) await bumpOrgVersion(app, req.user.orgId);
    return payload;
  });

  // Per-route latency histogram. `routeOptions.url` is the pattern (/v1/items/:id), never the raw URL: bounded label cardinality.
  app.addHook('onResponse', async (req, reply) => {
    httpDuration.observe({ method: req.method, route: req.routeOptions?.url ?? 'unmatched', status: String(reply.statusCode) }, reply.elapsedTime / 1000);
  });

  registerOpsJobs(); // handlers must exist in the API process too when JOBS_MODE=inline
  await app.register(healthRoutes);

  await app.register(async (v1) => {
    await v1.register(authRoutes, { prefix: '/auth' });
    await v1.register(userRoutes, { prefix: '/users' });
    await v1.register(accountRoutes, { prefix: '/account' });
    await v1.register(organizationRoutes, { prefix: '/organization' });
    await v1.register(locationRoutes, { prefix: '/locations' });
    await v1.register(peopleRoutes, { prefix: '/people' });
    await v1.register(teamRoutes, { prefix: '/teams' });
    await v1.register(jobRoutes, { prefix: '/jobs' });
    await v1.register(shelfRoutes, { prefix: '/shelves' });
    await v1.register(categoryRoutes, { prefix: '/categories' });
    await v1.register(fileRoutes, { prefix: '/files' });
    await v1.register(itemRoutes, { prefix: '/items' });
    await v1.register(transactionRoutes);
    await v1.register(approvalRoutes, { prefix: '/approvals' });
    await v1.register(reconciliationRoutes, { prefix: '/reconciliation-sessions' });
    await v1.register(importRoutes, { prefix: '/imports' });
    await v1.register(syncRoutes, { prefix: '/sync' });
    await v1.register(notificationRoutes, { prefix: '/notifications' });
    await v1.register(viewRoutes);
    await v1.register(reportRoutes, { prefix: '/reports' });
    await v1.register(analyticsRoutes, { prefix: '/analytics' });
    await v1.register(auditRoutes, { prefix: '/audit-logs' });
    await v1.register(activityRoutes);
  }, { prefix: '/v1' });

  return app;
}
