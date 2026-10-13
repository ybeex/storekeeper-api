/**
 * Session verification. Decorates every request with `request.user`
 * (or leaves it undefined for anonymous routes) and exposes an
 * `app.authenticate` hook that routes attach to `onRequest`.
 *
 * Token shape: the client holds a random 32-byte token; only its
 * SHA-256 hash is ever stored (Postgres `sessions.token_hash`, Redis
 * key). A leaked database or Redis snapshot is useless for
 * impersonation without the original token. See security.md.
 *
 * Lookup path: Redis first (sub-millisecond, the common case), falling
 * back to Postgres on a cache miss and repopulating Redis. Postgres is
 * always the source of truth.
 *
 * Cache invalidation is keyed by *user*, not just by token: alongside
 * `session:{tokenHash} -> user data`, we maintain
 * `user_sessions:{userId} -> set of that user's live tokenHashes`. A
 * user can hold several sessions at once (phone + desktop), and
 * AUTH-07 requires deactivation/role changes to take effect on *every*
 * one of them immediately — caching only the single token just
 * presented would leave their other sessions stale for up to the
 * cache TTL. The user-management handler that deactivates a user or
 * changes their role must call `invalidateAllSessionsForUser` in the
 * same request (see security.md for the ordering: Postgres write
 * first, then cache invalidation — never the reverse, or a request
 * racing between the two steps could repopulate the cache with the
 * now-stale value).
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { sessions, users } from '../db/schema.js';
import { breaker } from '../lib/circuit-breaker.js';

const redisBreaker = breaker('redis-session-cache', { callTimeoutMs: 250, failureThreshold: 3, resetTimeoutMs: 10_000 });
import { UnauthorizedError } from '../lib/errors.js';
import { hashToken } from '../lib/tokens.js';

export interface AuthedUser {
  id: string;
  orgId: string;
  role: 'admin' | 'store_staff' | 'supervisor' | 'viewer';
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user?: AuthedUser;
  }
}

/** Upper bound on how stale a cached session can be if invalidation is somehow missed. */
const CACHE_TTL_SECONDS = 300;

export function sessionCacheKey(tokenHash: string): string {
  return `session:${tokenHash}`;
}

function userSessionSetKey(userId: string): string {
  return `user_sessions:${userId}`;
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorateRequest('user', undefined);

  /**
   * Authenticate BEFORE the body is parsed or validated.
   *
   * Routes declare `preHandler: [app.authenticate, requireRole(...)]` because that reads naturally next to
   * the schema, but Fastify's lifecycle is onRequest → parse → validate → preHandler. Left alone, an
   * anonymous caller would get schema-validation errors (400) from protected routes and would make the server
   * parse and validate arbitrary bodies for free. This hook lifts `app.authenticate` out of preHandler into
   * onRequest at route-registration time, so anonymous traffic is rejected (401) before any of that work.
   * RBAC (requireRole) stays in preHandler, where it runs after authentication has populated req.user.
   */
  app.addHook('onRoute', (opts) => {
    const toList = <T,>(h: T | T[] | undefined): T[] => (h === undefined ? [] : Array.isArray(h) ? h : [h]);
    const pre = toList(opts.preHandler as unknown);
    if (!pre.includes(app.authenticate as unknown)) return;
    opts.preHandler = pre.filter((h) => h !== (app.authenticate as unknown)) as never;
    opts.onRequest = [...toList(opts.onRequest as unknown), app.authenticate] as never;
  });

  app.decorate('authenticate', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedError();
    }
    const tokenHash = hashToken(header.slice('Bearer '.length));

    // Redis is a cache here, not a gatekeeper: if it is slow or down the breaker opens and we read Postgres directly.
    const cached = await redisBreaker.execOr(() => app.redis.get(sessionCacheKey(tokenHash)), () => null);
    if (cached) {
      req.user = JSON.parse(cached) as AuthedUser;
      return;
    }

    const [row] = await app.db
      .select({
        userId: users.id, orgId: users.orgId, role: users.role,
        active: users.active, expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);

    if (!row || !row.active || row.expiresAt < new Date()) {
      throw new UnauthorizedError();
    }

    const authedUser: AuthedUser = { id: row.userId, orgId: row.orgId, role: row.role };
    req.user = authedUser;

    // Best-effort cache repopulation. The TTL is the *smaller* of the
    // normal cache window and the session's own remaining lifetime — a
    // fixed 300s would let a session with 100s left keep authenticating
    // for 200s after it expired. Both writes are pipelined but
    // independent: losing the set membership just means a future
    // deactivation invalidates one fewer cached token, which self-heals
    // within the TTL; it never makes an invalidated session look valid.
    const ttl = Math.max(1, Math.min(CACHE_TTL_SECONDS, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000)));
    await redisBreaker.execOr(() => app.redis
      .pipeline()
      .set(sessionCacheKey(tokenHash), JSON.stringify(authedUser), 'EX', ttl)
      .sadd(userSessionSetKey(authedUser.id), tokenHash)
      .expire(userSessionSetKey(authedUser.id), CACHE_TTL_SECONDS)
      .exec(), () => null);
  });
});

/**
 * Call this immediately after the Postgres write that deactivates a
 * user or changes their role (never before it — see file header).
 * Deletes every session token this user currently has cached, so the
 * very next request on any of their devices misses the cache, re-reads
 * Postgres, and gets the current (blocked, or newly-scoped) state.
 */
export async function invalidateAllSessionsForUser(app: FastifyInstance, userId: string) {
  // If Redis is unreachable the breaker is (or soon will be) open, which makes every request bypass the cache and
  // read Postgres — so no stale grant can be served. If it is only flaky, the 300s cache TTL bounds the exposure.
  await redisBreaker.execOr(async () => {
    const setKey = userSessionSetKey(userId);
    const tokenHashes = await app.redis.smembers(setKey);
    if (tokenHashes.length === 0) return;
    const pipeline = app.redis.pipeline();
    for (const hash of tokenHashes) pipeline.del(sessionCacheKey(hash));
    pipeline.del(setKey);
    await pipeline.exec();
  }, () => { app.log.warn({ userId }, 'session cache invalidation skipped (redis unavailable)'); });
}
