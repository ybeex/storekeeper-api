/**
 * Short-lived read-through cache for expensive, many-viewer reads (the dashboard, its analytics, catalog stats).
 *
 * Why: the dashboard re-polls every 30 seconds from every open tab. Without a cache, 200 people watching one store's
 * dashboard run 200 identical aggregate queries every half minute. With a 15 second cache, the database sees one.
 *
 * Rules:
 *  - Postgres stays the source of truth. A cache miss, a Redis outage or an open breaker all just run the query.
 *  - Entries are keyed by organisation (and by anything that changes the answer: location scope, role), so one
 *    organisation can never be served another's numbers.
 *  - Only use it for reads where being a few seconds behind is acceptable. Never for anything a write must see.
 *  - Concurrent misses are collapsed in-process, so a burst after expiry still runs the query once per instance.
 *  - Writes invalidate. Every successful non-GET request bumps the organisation's version counter (see `bumpOrgVersion`,
 *    called from app.ts), and the version is part of every key. So after you record a movement your own dashboard
 *    refetch is a miss and shows it immediately. The TTL only matters for changes made outside a request (the worker).
 */
import type { FastifyInstance } from 'fastify';
import { breaker } from './circuit-breaker.js';

/** Anything with the Redis client on it: the Fastify instance, however it was configured (HTTP/1, HTTP/2). */
type WithRedis = Pick<FastifyInstance, 'redis'>;

const redisBreaker = breaker('redis-read-cache', { callTimeoutMs: 250, failureThreshold: 3, resetTimeoutMs: 10_000 });
const inFlight = new Map<string, Promise<unknown>>();

const versionKey = (orgId: string) => `rc:ver:${orgId}`;

/** Marks everything cached for this organisation as stale. Cheap (one INCR) and best-effort: the TTL is the backstop. */
export async function bumpOrgVersion(app: WithRedis, orgId: string): Promise<void> {
  await redisBreaker.execOr(() => app.redis.incr(versionKey(orgId)), () => null);
}

export async function cached<T>(app: WithRedis, orgId: string, key: string, ttlSeconds: number, compute: () => Promise<T>): Promise<T> {
  const version = (await redisBreaker.execOr(() => app.redis.get(versionKey(orgId)), () => null)) ?? '0';
  const k = `rc:${orgId}:v${version}:${key}`;
  const hit = await redisBreaker.execOr(() => app.redis.get(k), () => null);
  if (hit) { try { return JSON.parse(hit) as T; } catch { /* corrupt entry: fall through and recompute */ } }

  const pending = inFlight.get(k) as Promise<T> | undefined;
  if (pending) return pending;
  const run = (async () => {
    const value = await compute();
    await redisBreaker.execOr(() => app.redis.set(k, JSON.stringify(value), 'EX', ttlSeconds), () => null);
    return value;
  })().finally(() => inFlight.delete(k));
  inFlight.set(k, run);
  return run;
}

/** Stable short key part for a location scope (null = every location). */
export const scopeKey = (locs: string[] | null | undefined) => (locs ? [...locs].sort().join(',') : 'all');
