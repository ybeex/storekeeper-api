/**
 * Server-side role enforcement — PRD AUTH-03: "Every write endpoint
 * rejects unauthorized roles with 403, independent of frontend state."
 *
 * This is deliberately a preHandler *factory*, not a single global
 * check: each route declares the roles it accepts, right next to its
 * schema, so `grep requireRole src/modules` shows every protected
 * endpoint's access rule in one place — and, per AUTH-08, so a test
 * suite can iterate every route and assert the roles it claims to
 * allow are the only ones that succeed. Fails closed: a route that
 * forgets to call this is caught by the route-audit test in
 * test/rbac-coverage.test.ts (see security.md), not by this file,
 * since an omitted preHandler can't enforce anything by definition.
 */
import type { FastifyRequest, FastifyReply } from 'fastify';
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js';
import type { AuthedUser } from './auth.js';

type Role = AuthedUser['role'];

export function requireRole(...roles: Role[]) {
  return async function rbacPreHandler(req: FastifyRequest, _reply: FastifyReply) {
    if (!req.user) throw new UnauthorizedError();
    if (!roles.includes(req.user.role)) {
      throw new ForbiddenError(`Requires one of: ${roles.join(', ')}`);
    }
  };
}

/** Shorthand for the common "any authenticated role" case (e.g. read endpoints). */
export const anyRole = requireRole('admin', 'store_staff', 'supervisor', 'viewer');
