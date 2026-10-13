/**
 * Location resolution and access control (PRD §9 + Phase 2 location-scoped permissions).
 *
 * A user with no rows in `user_locations` may act at every location; a user
 * with rows is confined to exactly those. Enforced here, in one place, so no
 * module can forget it.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { locations, userLocations } from '../db/schema.js';
import { ForbiddenError, NotFoundError, ValidationError } from './errors.js';

export interface Principal { id: string; orgId: string; role: 'admin' | 'store_staff' | 'supervisor' | 'viewer' }

export async function assertLocation(tx: Db, orgId: string, locationId: string) {
  const [loc] = await tx.select().from(locations)
    .where(and(eq(locations.id, locationId), eq(locations.orgId, orgId), isNull(locations.archivedAt))).limit(1);
  if (!loc) throw new NotFoundError('Location');
  return loc;
}

/** null = unrestricted. */
export async function allowedLocationIds(tx: Db, user: Principal): Promise<string[] | null> {
  if (user.role === 'admin') return null; // admins are never location-confined
  const rows = await tx.select({ id: userLocations.locationId }).from(userLocations).where(eq(userLocations.userId, user.id));
  return rows.length ? rows.map((r) => r.id) : null;
}

export async function assertLocationAccess(tx: Db, user: Principal, locationId: string): Promise<void> {
  const allowed = await allowedLocationIds(tx, user);
  if (allowed && !allowed.includes(locationId)) throw new ForbiddenError('You do not have access to this location');
}

/** Location for a request that omitted it: the org's single active location. Ambiguity is an error, never a guess. */
export async function resolveLocationId(tx: Db, user: Principal, requested?: string | null): Promise<string> {
  if (requested) {
    await assertLocation(tx, user.orgId, requested);
    await assertLocationAccess(tx, user, requested);
    return requested;
  }
  const allowed = await allowedLocationIds(tx, user);
  const rows = await tx.select({ id: locations.id }).from(locations)
    .where(and(eq(locations.orgId, user.orgId), isNull(locations.archivedAt))).orderBy(asc(locations.createdAt)).limit(3);
  const candidates = allowed ? rows.filter((r) => allowed.includes(r.id)) : rows;
  if (candidates.length === 0) throw new ValidationError('No active location exists; create one first');
  if (candidates.length > 1) throw new ValidationError('locationId is required when more than one location is available');
  return candidates[0].id;
}
