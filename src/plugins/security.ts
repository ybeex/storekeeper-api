/**
 * Perimeter security and overload protection, registered before auth so
 * every route inherits it. See references/security.md and
 * references/performance-and-scale.md for the reasoning; this file is
 * mostly wiring plus the two decisions that are easy to get wrong.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import underPressure from '@fastify/under-pressure';
import { env } from '../env.js';
import { TooManyRequestsError } from '../lib/errors.js';

/**
 * Rate-limit key: the session token if one was sent, else the client IP.
 *
 * Why not simply `req.user.id`: the limiter runs in `onRequest`, which
 * is *before* authentication resolves a user, so `req.user` is always
 * undefined here. And why not IP-only: this product's users are
 * shop-floor staff, often dozens or hundreds behind one warehouse NAT —
 * an IP-keyed limit would throttle a whole site as if it were a single
 * client. Hashing the Authorization header gives one bucket per session
 * without a database lookup at this stage.
 *
 * The trade-off, stated plainly: an attacker can send random tokens to
 * get a fresh bucket each time, so this limiter is *not* the defense
 * against unauthenticated floods. That belongs at the edge (CDN/WAF/API
 * gateway, which see the real IP-level picture) plus the load shedding
 * below. The login and registration routes — the credential-stuffing
 * surface — get their own much tighter IP-keyed limit (modules/auth).
 */
function rateLimitKey(req: { headers: Record<string, unknown>; ip: string }): string {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.length > 0
    ? `tok:${createHash('sha256').update(auth).digest('hex').slice(0, 32)}`
    : `ip:${req.ip}`;
}

export default fp(async function securityPlugin(app: FastifyInstance) {
  await app.register(helmet, {
    // API-only service: no inline scripts/styles to allow, so a
    // default-deny CSP costs nothing. Left explicit so a future HTML
    // response (e.g. an OpenAPI UI) doesn't silently loosen it.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"] } },
  });

  const allowedOrigins = env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins.length ? allowedOrigins : false, // fail closed if unconfigured
    credentials: true,
  });

  // Backed by Redis rather than memory because this runs as N stateless
  // instances: an in-memory limiter would let a client get N x the
  // intended limit by landing on different instances.
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    redis: app.redis,
    nameSpace: 'rl:',
    skipOnError: true, // if Redis is unreachable, fail open: a limiter outage must not become an API outage
    keyGenerator: rateLimitKey,
    // Returning an AppError (not a plain object) means the response goes
    // through our error handler and gets the standard envelope.
    errorResponseBuilder: (_req, context) => new TooManyRequestsError(Math.ceil(context.ttl / 1000)),
  });

  // Load shedding: once the event loop is backed up or heap is near its
  // limit, return 503 instead of accepting more work and making every
  // in-flight request slower. A fast, honest 503 that a client retries
  // beats a slow 200 that arrives after the client already gave up.
  await app.register(underPressure, {
    maxEventLoopDelay: 1000, // ms
    maxHeapUsedBytes: 1_500_000_000,
    maxRssBytes: 2_000_000_000,
    retryAfter: 50, // seconds, sent as Retry-After
  });
});

/** Per-route limit config for login / org registration: tight, and always IP-keyed. */
export const authRouteRateLimit = {
  rateLimit: {
    max: env.AUTH_RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW_MS,
    keyGenerator: (req: { ip: string }) => `ip:${req.ip}`,
  },
};
