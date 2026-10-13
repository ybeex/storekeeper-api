import type { FastifyInstance } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { env } from '../../env.js';
import { registry } from '../../lib/metrics.js';
import { breakerStates } from '../../lib/circuit-breaker.js';

const safeEq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export async function healthRoutes(app: FastifyInstance) {
  // Liveness: the process is up. Never touches dependencies (a DB blip must not make the orchestrator kill healthy pods).
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));

  // Readiness: can this instance serve traffic right now? Gate the load balancer on this.
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    const checks: Record<string, 'ok' | 'fail'> = {};
    await Promise.all([
      withTimeout(app.db.execute(sql`select 1`), 1500).then(() => { checks.postgres = 'ok'; }, () => { checks.postgres = 'fail'; }),
      withTimeout(app.redis.ping(), 1000).then(() => { checks.redis = 'ok'; }, () => { checks.redis = 'fail'; }),
    ]);
    const ready = checks.postgres === 'ok'; // Redis is a degradable dependency (cache/limiter fail open); Postgres is not.
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', checks, breakers: breakerStates() };
  });

  // Prometheus scrape. Disabled unless METRICS_TOKEN is set; compared in constant time.
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    if (!env.METRICS_TOKEN) return reply.code(404).send();
    const h = String(req.headers.authorization ?? '');
    if (!safeEq(h.replace(/^Bearer\s+/i, ''), env.METRICS_TOKEN)) return reply.code(401).send();
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
}
