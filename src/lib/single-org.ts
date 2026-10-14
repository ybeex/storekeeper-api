/**
 * One person, one organisation (for everyone who was invited).
 *
 * Only an admin who creates organisations from the organisations page can run several; that link is the explicit
 * `users.account_id` and it is never created by inviting. So an invite for an address that already has an active login in
 * ANOTHER organisation is refused, both when it is sent and again when it is accepted (the other login may have appeared
 * in between).
 */
import { and, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { ConflictError } from './errors.js';

export async function assertNotInAnotherOrg(db: Db, orgId: string, email: string): Promise<void> {
  const [other] = await db.select({ id: users.id }).from(users)
    .where(and(ne(users.orgId, orgId), eq(users.email, email.trim().toLowerCase()), eq(users.active, true))).limit(1);
  if (other) throw new ConflictError('EMAIL_IN_ANOTHER_ORG', 'This email already works in another organisation. A person can only work in one organisation at a time.');
}
