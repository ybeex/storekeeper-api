import type { FastifyInstance } from 'fastify';
import { requireRole } from '../../plugins/rbac.js';
import { invalidateAllSessionsForUser } from '../../plugins/auth.js';
import { IdParams, iso } from '../../lib/schemas.js';
import { ListUsersQuery, UpdateUserBody, CreateInviteBody, SetUserLocationsBody } from './schema.js';
import { listUsers, getUser, updateUser, setUserLocations, createInvite, listInvites, revokeInvite, resendInvite } from './service.js';

const admin = requireRole('admin');
const ser = (u: { createdAt: Date; lockedUntil: Date | null }) => ({ createdAt: u.createdAt.toISOString(), lockedUntil: iso(u.lockedUntil) });

export async function userRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [app.authenticate, requireRole('admin', 'supervisor')], schema: { querystring: ListUsersQuery } }, async (req) => {
    const p = await listUsers(req.server.db, req.user!.orgId, req.query);
    return { items: p.items.map((u) => ({ ...u, ...ser(u) })), nextCursor: p.nextCursor };
  });

  app.get('/:id', { preHandler: [app.authenticate, admin], schema: { params: IdParams } }, async (req) => {
    const u = await getUser(req.server.db, req.user!.orgId, req.params.id);
    return { ...u, ...ser(u) };
  });

  app.patch('/:id', { preHandler: [app.authenticate, admin], schema: { params: IdParams, body: UpdateUserBody } }, async (req) => {
    const u = await updateUser(req.server.db, req.user!, req.params.id, req.body);
    await invalidateAllSessionsForUser(req.server, u.id); // AFTER the commit, per plugins/auth.ts
    return { ...u, ...ser(u) };
  });

  app.put('/:id/locations', { preHandler: [app.authenticate, admin], schema: { params: IdParams, body: SetUserLocationsBody } }, async (req) => {
    const locationIds = await setUserLocations(req.server.db, req.user!, req.params.id, req.body.locationIds);
    await invalidateAllSessionsForUser(req.server, req.params.id);
    return { locationIds };
  });

  // Invites are role-based: admins invite anyone; supervisors invite store staff and viewers (enforced in the service).
  const INVITER = requireRole('admin', 'supervisor');
  const serInv = (r: { expiresAt: Date; createdAt: Date }) => ({ expiresAt: r.expiresAt.toISOString(), createdAt: r.createdAt.toISOString() });

  app.post('/invites', { preHandler: [app.authenticate, INVITER], schema: { body: CreateInviteBody } }, async (req, reply) => {
    const inv = await createInvite(req.server.db, req.user!, req.body);
    reply.code(201);
    return { ...inv, expiresAt: inv.expiresAt.toISOString() };
  });

  app.get('/invites', { preHandler: [app.authenticate, INVITER] }, async (req) => {
    const rows = await listInvites(req.server.db, req.user!);
    return { items: rows.map((r) => ({ ...r, ...serInv({ expiresAt: r.expiresAt, createdAt: r.createdAt }) })) };
  });

  app.post('/invites/:id/resend', { preHandler: [app.authenticate, INVITER], schema: { params: IdParams } }, async (req) => {
    const inv = await resendInvite(req.server.db, req.user!, req.params.id);
    return { ...inv, expiresAt: inv.expiresAt.toISOString() };
  });

  app.delete('/invites/:id', { preHandler: [app.authenticate, INVITER], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    await revokeInvite(req.server.db, req.user!, req.params.id);
    reply.code(204);
  });
}
