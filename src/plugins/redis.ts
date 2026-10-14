/**
 * A single shared Redis connection, decorated onto the app as `redis`.
 * Three unrelated things borrow it rather than each getting their own
 * connection pool: the rate limiter's counters (security.ts), the
 * session read-cache (auth.ts), and the idempotency in-flight lock
 * (idempotency.ts). None of them are the source of truth for anything —
 * Postgres always is — so if Redis is flushed or briefly unavailable,
 * the system degrades (slower auth lookups, a rate limit reset, a
 * narrower idempotency race window) rather than corrupting data. See
 * references/performance-and-scale.md.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { env } from '../env.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
  }
}

export default fp(async function redisPlugin(app: FastifyInstance) {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false, // fail fast instead of buffering unboundedly during an outage
  });

  redis.on('error', (err) => app.log.error({ err }, 'redis connection error'));

  app.decorate('redis', redis);
  app.addHook('onClose', async () => {
    await redis.quit();
  });
});
