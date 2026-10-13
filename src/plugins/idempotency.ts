/**
 * General-purpose idempotency for mutating endpoints that don't already
 * get it from a DB unique constraint on their own business row.
 * Checkout/check-in/consume/restock use the `transactions` ledger's
 * `(org, actor, idempotency_key)` unique index instead (see
 * modules/checkout/service.ts) — a strictly stronger mechanism, because
 * the key and the side effect are written in the *same* database
 * transaction. This plugin covers everything else: item creation, user
 * creation, and any future POST that isn't ledger-shaped.
 *
 * A route opts in with `config: { idempotent: true }` and MUST also
 * authenticate (this plugin fails closed if `req.user` is missing).
 * Clients send an `Idempotency-Key` header (8–200 chars, typically a
 * UUID) which is then required on that route.
 *
 * ── How it's wired (and why not a global hook) ──────────────────────
 * An `onRoute` hook appends this plugin's `preHandler` and `onSend`
 * to each opted-in route's own hook lists, *after* whatever the route
 * already declared. That ordering is the point: the route's own
 * `onRequest` hooks (authenticate, requireRole) run first, so `req.user`
 * exists by the time we need it, and the body has been parsed and
 * validated so we can fingerprint it. A plain global `preHandler` hook
 * would run *before* the route's hooks and see no user at all.
 *
 * ── The protocol, all in Postgres ───────────────────────────────────
 * 1. CLAIM: `INSERT ... ON CONFLICT DO NOTHING RETURNING`. Exactly one
 *    concurrent request can win this; the unique index is the arbiter,
 *    so there is no SELECT-then-INSERT gap to race through. Winner
 *    becomes the *owner* and runs the handler.
 * 2. Losers read the existing row and decide:
 *      - different request fingerprint      -> 409 IDEMPOTENCY_KEY_REUSED
 *      - a stored response exists           -> replay it verbatim
 *      - no response yet, locked < 30s ago  -> 409 REQUEST_IN_PROGRESS
 *      - no response yet, lock is stale     -> the owner died; take over
 *        with a conditional UPDATE (again atomic: only one taker wins)
 *      - row past its `expires_at`          -> reset and re-claim it
 * 3. COMPLETE (`onSend`, owner only): store status + body — but only
 *    for statuses < 500. A 5xx says "the server failed", not "this is
 *    the answer for this key", so the row is deleted instead and a
 *    retry gets a genuine second attempt. Replaying a cached 500 for 24
 *    hours would make an outage permanent for that key.
 *
 * Why no Redis lock: an earlier design also held a Redis `SET NX` lock.
 * It added a failure mode (Redis down => every idempotent request
 * errors) and no correctness the unique index doesn't already provide,
 * since the index alone guarantees a single owner. Liveness ("is the
 * owner still working?") is answered by `locked_at`'s age instead.
 *
 * Fail-fast rather than block: a concurrent duplicate gets an immediate
 * 409, not a held-open connection. At 1M-user scale a flaky mobile
 * client can fire retries faster than the original completes, and
 * parking each one on a worker until it does would turn one slow
 * request into a pile-up. See references/idempotency-and-concurrency.md.
 *
 * ── Known limitation (read before opting a route in) ────────────────
 * The stored response is written *after* the handler's own transaction
 * commits. If the process dies in that gap, the row stays "in flight",
 * and once the 30s lock goes stale a retry re-runs the handler. So a
 * route using this plugin must be safe to re-run — typically via its own
 * natural unique constraint (POST /items would return 409 SKU_TAKEN on
 * the re-run, not create a second item). Anything where a re-run would
 * cause real damage belongs on the ledger mechanism, where key and
 * effect commit atomically.
 */
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash } from 'node:crypto';
import { and, eq, lt, sql } from 'drizzle-orm';
import { idempotencyKeys } from '../db/schema.js';
import type { Db } from '../db/index.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../lib/errors.js';
import { env } from '../env.js';

const LOCK_STALE_SECONDS = 30;

declare module 'fastify' {
  interface FastifyContextConfig {
    idempotent?: boolean;
  }
  interface FastifyRequest {
    /** Set by this plugin: 'owner' = we run the handler and record its result; 'replayed' = response already sent from cache. */
    idempotency?: { key: string; state: 'owner' | 'replayed' };
  }
}

/** JSON with recursively sorted keys, so a retry that re-serializes the same body with different key order still matches. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

function fingerprint(req: FastifyRequest): string {
  // Route *pattern* + concrete params + query + body: two requests are
  // "the same request" only if all of it matches.
  return createHash('sha256')
    .update(`${req.method}|${req.routeOptions.url}|${canonicalize(req.params)}|${canonicalize(req.query)}|${canonicalize(req.body)}`)
    .digest('hex');
}

function expiryFromNow(): Date {
  return new Date(Date.now() + env.IDEMPOTENCY_KEY_TTL_SECONDS * 1000);
}

/** Deletes expired keys. Run from a scheduled job (cron / pg_cron / the worker) — never inline in a request. */
export async function purgeExpiredIdempotencyKeys(db: Db, limit = 5000): Promise<number> {
  // DELETE ... RETURNING id and counting the array is the one shape
  // that's unambiguous across every Postgres driver's result wrapper —
  // a raw driver's "rows affected" field is represented differently
  // enough between drivers/versions that relying on it here isn't
  // worth the risk for what's a periodic cleanup job, not a hot path.
  const deleted = await db.execute<{ id: string }>(sql`
    delete from idempotency_keys where id in (
      select id from idempotency_keys where expires_at < now() limit ${limit}
    )
    returning id
  `);
  return Array.isArray(deleted) ? deleted.length : (deleted as { rows?: unknown[] }).rows?.length ?? 0;
}

export default fp(async function idempotencyPlugin(app: FastifyInstance) {
  app.decorateRequest('idempotency', undefined);

  async function idempotencyPreHandler(req: FastifyRequest, reply: FastifyReply) {
    // An idempotent route without authentication is a wiring bug, and
    // keys are scoped per (org, actor) — there is nothing safe to scope
    // an anonymous key to. Fail closed rather than skip.
    if (!req.user) throw new UnauthorizedError();

    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
      throw new ValidationError('An Idempotency-Key header (8-200 characters) is required for this endpoint');
    }

    const { orgId, id: actorId } = req.user;
    const fp_ = fingerprint(req);
    const scope = and(
      eq(idempotencyKeys.orgId, orgId),
      eq(idempotencyKeys.actorUserId, actorId),
      eq(idempotencyKeys.key, key),
    );

    // Bounded retry: each loop iteration either resolves the request or
    // observes that another request changed the row underneath us.
    for (let attempt = 0; attempt < 3; attempt++) {
      // 1. CLAIM. Only one concurrent caller can get a row back.
      const claimed = await app.db.insert(idempotencyKeys).values({
        orgId, actorUserId: actorId, key, requestFingerprint: fp_, expiresAt: expiryFromNow(),
      }).onConflictDoNothing({
        target: [idempotencyKeys.orgId, idempotencyKeys.actorUserId, idempotencyKeys.key],
      }).returning({ id: idempotencyKeys.id });

      if (claimed.length > 0) {
        req.idempotency = { key, state: 'owner' };
        return;
      }

      // 2. Someone else has (or had) this key. Read it and decide.
      const [existing] = await app.db.select().from(idempotencyKeys).where(scope).limit(1);
      if (!existing) continue; // deleted (a 5xx cleanup) between our claim and read: try to claim again

      if (existing.expiresAt < new Date()) {
        // Reset an expired key in place; atomic, so only one request wins the reset.
        const reset = await app.db.update(idempotencyKeys)
          .set({
            requestFingerprint: fp_, responseStatus: null, responseBody: null,
            lockedAt: new Date(), createdAt: new Date(), expiresAt: expiryFromNow(),
          })
          .where(and(eq(idempotencyKeys.id, existing.id), lt(idempotencyKeys.expiresAt, new Date())))
          .returning({ id: idempotencyKeys.id });
        if (reset.length > 0) { req.idempotency = { key, state: 'owner' }; return; }
        continue; // lost the reset race; re-read
      }

      if (existing.requestFingerprint !== fp_) {
        // Same key, different request. Almost always a client bug (a UUID
        // reused across unrelated actions); failing loudly beats silently
        // replaying a response that belongs to some other request.
        throw new ConflictError('IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request');
      }

      if (existing.responseStatus != null) {
        req.idempotency = { key, state: 'replayed' };
        reply.header('idempotent-replayed', 'true').code(existing.responseStatus);
        if (existing.responseStatus === 204 || existing.responseBody == null) reply.send();
        else reply.send(existing.responseBody);
        return reply; // signals "response already sent" to Fastify's async hook machinery
      }

      // In flight per the row. Is the owner plausibly still working?
      const staleBefore = new Date(Date.now() - LOCK_STALE_SECONDS * 1000);
      if (existing.lockedAt < staleBefore) {
        // Owner presumably died mid-request. Atomic takeover: the WHERE
        // re-checks staleness and "still no response", so if the owner
        // was merely slow and just finished, or another retry already
        // took over, zero rows match and we fall through to a 409.
        const taken = await app.db.update(idempotencyKeys)
          .set({ lockedAt: new Date() })
          .where(and(
            eq(idempotencyKeys.id, existing.id),
            sql`${idempotencyKeys.responseStatus} is null`,
            lt(idempotencyKeys.lockedAt, staleBefore),
          ))
          .returning({ id: idempotencyKeys.id });
        if (taken.length > 0) { req.idempotency = { key, state: 'owner' }; return; }
      }
      throw new ConflictError('REQUEST_IN_PROGRESS', 'This request is already being processed');
    }

    throw new ConflictError('REQUEST_IN_PROGRESS', 'This request is already being processed');
  }

  async function idempotencyOnSend(req: FastifyRequest, reply: FastifyReply, payload: unknown) {
    if (req.idempotency?.state !== 'owner' || !req.user) return payload;

    const scope = and(
      eq(idempotencyKeys.orgId, req.user.orgId),
      eq(idempotencyKeys.actorUserId, req.user.id),
      eq(idempotencyKeys.key, req.idempotency.key),
    );

    try {
      if (reply.statusCode >= 500) {
        // The server failed; that isn't "the answer for this key". Free
        // the key so a retry is a real second attempt.
        await app.db.delete(idempotencyKeys).where(scope);
      } else {
        await app.db.update(idempotencyKeys)
          .set({ responseStatus: reply.statusCode, responseBody: parseJson(payload) })
          .where(scope);
      }
    } catch (err) {
      // Never fail the client's (already successful) request because
      // bookkeeping failed — but log loudly; see the file header's
      // "Known limitation" for what this leaves behind.
      req.log.error({ err }, 'failed to record idempotent response');
    }
    return payload;
  }

  // Inject into every opted-in route, *after* the route's own hooks.
  app.addHook('onRoute', (routeOptions) => {
    if (!routeOptions.config?.idempotent) return;
    const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    routeOptions.preHandler = [...asArray(routeOptions.preHandler), idempotencyPreHandler];
    routeOptions.onSend = [...asArray(routeOptions.onSend), idempotencyOnSend];
  });
});

function parseJson(payload: unknown): unknown {
  if (typeof payload !== 'string' || payload.length === 0) return null;
  try { return JSON.parse(payload); } catch { return null; }
}
