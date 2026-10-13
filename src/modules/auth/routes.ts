import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { authRouteRateLimit } from '../../plugins/security.js';
import { sessionCacheKey } from '../../plugins/auth.js';
import { anyRole } from '../../plugins/rbac.js';
import { hashToken } from '../../lib/tokens.js';
import { env } from '../../env.js';
import { users, organizations, locations, sessions, people } from '../../db/schema.js';
import { eq, and, isNull, asc, desc } from 'drizzle-orm';
import { NotFoundError } from '../../lib/errors.js';
import {
  RegisterBody, LoginBody, ChangePasswordBody, ForgotPasswordBody, ResetPasswordBody, AcceptInviteBody,
} from './schema.js';
import {
  issueSession, registerOrganization, login, logout, changePassword, requestPasswordReset, resetPassword, acceptInvite,
} from './service.js';

const SessionResponse = Type.Object({
  token: Type.String(), expiresAt: Type.String(), userId: Type.String(), orgId: Type.String(), role: Type.String(),
});

function bearer(req: { headers: Record<string, unknown> }): string | undefined {
  const h = req.headers.authorization;
  return typeof h === 'string' ? h.replace(/^Bearer\s+/i, '') : undefined;
}

export async function authRoutes(app: FastifyInstance) {
  const evict = async (hashes: string[]) => {
    if (hashes.length === 0) return;
    // Best effort: the cache TTL bounds staleness even if Redis is unreachable right now.
    await app.redis.del(...hashes.map(sessionCacheKey)).catch((err) => app.log.warn({ err }, 'session cache evict failed'));
  };
  const info = (req: { ip: string; headers: Record<string, unknown> }) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') });

  app.post('/register', { config: authRouteRateLimit, schema: { body: RegisterBody, response: { 201: Type.Intersect([SessionResponse, Type.Object({ locationId: Type.String(), organizationSlug: Type.String() })]) } } },
    async (req, reply) => {
      const r = await registerOrganization(req.server.db, req.body, info(req));
      await evict(r.session.evictedTokenHashes);
      reply.code(201);
      return { token: r.session.token, expiresAt: r.session.expiresAt.toISOString(), userId: r.user.id, orgId: r.org.id, role: r.user.role, locationId: r.location.id, organizationSlug: r.org.slug };
    });

  app.post('/login', { config: authRouteRateLimit, schema: { body: LoginBody, response: { 200: SessionResponse } } }, async (req) => {
    const r = await login(req.server.db, req.body, info(req));
    await evict(r.session.evictedTokenHashes);
    return { token: r.session.token, expiresAt: r.session.expiresAt.toISOString(), userId: r.userId, orgId: r.orgId, role: r.role };
  });

  app.post('/logout', { preHandler: [app.authenticate, anyRole], schema: { response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const token = bearer(req);
    if (token) { await logout(req.server.db, token); await evict([hashToken(token)]); }
    reply.code(204);
  });

  app.get('/me', { preHandler: [app.authenticate, anyRole] }, async (req) => {
    const [u] = await req.server.db.select({ id: users.id, email: users.email, fullName: users.fullName, role: users.role, orgId: users.orgId, orgName: organizations.name, orgSlug: organizations.slug })
      .from(users).innerJoin(organizations, eq(users.orgId, organizations.id)).where(eq(users.id, req.user!.id)).limit(1);
    if (!u) throw new NotFoundError('User');
    const locs = await req.server.db.select({ id: locations.id, name: locations.name }).from(locations)
      .where(and(eq(locations.orgId, u.orgId), isNull(locations.archivedAt))).orderBy(asc(locations.createdAt));
    return { ...u, locations: locs };
  });

  app.patch('/profile', { preHandler: [app.authenticate, anyRole], schema: { body: Type.Object({ fullName: Type.String({ minLength: 1, maxLength: 150 }) }, { additionalProperties: false }) } }, async (req) => {
    await req.server.db.update(users).set({ fullName: req.body.fullName.trim(), updatedAt: new Date() }).where(eq(users.id, req.user!.id));
    await req.server.db.update(people).set({ fullName: req.body.fullName.trim() }).where(eq(people.userId, req.user!.id));
    return { fullName: req.body.fullName.trim() };
  });

  // Session management: see where you're signed in, sign a device out.
  app.get('/sessions', { preHandler: [app.authenticate, anyRole] }, async (req) => {
    const current = bearer(req); const curHash = current ? hashToken(current) : null;
    const rows = await req.server.db.select().from(sessions).where(eq(sessions.userId, req.user!.id)).orderBy(desc(sessions.createdAt)).limit(50);
    return { items: rows.map((s) => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt.toISOString(), expiresAt: s.expiresAt.toISOString(), current: s.tokenHash === curHash })) };
  });
  app.delete('/sessions/:id', { preHandler: [app.authenticate, anyRole], schema: { params: Type.Object({ id: Type.String({ format: 'uuid' }) }), response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const gone = await req.server.db.delete(sessions).where(and(eq(sessions.id, req.params.id), eq(sessions.userId, req.user!.id))).returning({ h: sessions.tokenHash });
    await evict(gone.map((g) => g.h));
    reply.code(204);
  });

  // Sliding sessions for the Next.js server: swap the current token for a fresh one before it expires.
  // The old token dies in the same transaction, so a refreshed-and-leaked old token is useless.
  app.post('/refresh', { preHandler: [app.authenticate, anyRole], schema: { response: { 200: SessionResponse } } }, async (req) => {
    const old = bearer(req)!; const u = req.user!;
    const s = await req.server.db.transaction(async (tx) => {
      const issued = await issueSession(tx as never, u.id, info(req));
      await tx.delete(sessions).where(eq(sessions.tokenHash, hashToken(old)));
      return issued;
    });
    await evict([...s.evictedTokenHashes, hashToken(old)]);
    return { token: s.token, expiresAt: s.expiresAt.toISOString(), userId: u.id, orgId: u.orgId, role: u.role };
  });

  app.post('/change-password', { config: authRouteRateLimit, preHandler: [app.authenticate, anyRole], schema: { body: ChangePasswordBody, response: { 200: SessionResponse } } }, async (req) => {
    const r = await changePassword(req.server.db, req.user!.id, req.body.currentPassword, req.body.newPassword);
    await evict(r.revokedHashes);
    return { token: r.session.token, expiresAt: r.session.expiresAt.toISOString(), userId: req.user!.id, orgId: req.user!.orgId, role: req.user!.role };
  });

  // Public, rate-limited, always 202: never reveals whether the account exists.
  app.post('/forgot-password', { config: authRouteRateLimit, schema: { body: ForgotPasswordBody, response: { 202: Type.Object({ ok: Type.Boolean() }) } } }, async (req, reply) => {
    await requestPasswordReset(req.server.db, req.body);
    reply.code(202);
    return { ok: true };
  });

  app.post('/reset-password', { config: authRouteRateLimit, schema: { body: ResetPasswordBody, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    await evict(await resetPassword(req.server.db, req.body.token, req.body.password));
    reply.code(204);
  });

  app.post('/accept-invite', { config: authRouteRateLimit, schema: { body: AcceptInviteBody, response: { 201: SessionResponse } } }, async (req, reply) => {
    const r = await acceptInvite(req.server.db, req.body.token, req.body.password, info(req));
    await evict(r.session.evictedTokenHashes);
    reply.code(201);
    return { token: r.session.token, expiresAt: r.session.expiresAt.toISOString(), userId: r.user.id, orgId: r.user.orgId, role: r.user.role };
  });
}

void env;
