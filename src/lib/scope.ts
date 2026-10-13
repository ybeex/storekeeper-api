/**
 * Who may see whose activity.
 *
 * Store staff record movements; they do not review the store. They see only the activity they performed themselves
 * (the ledger, the activity feed, an item's timeline). Everyone else with read access sees all of it.
 * Enforced here on the server so a hand-built request cannot widen it; the web app only hides what would be refused.
 */
import type { Principal } from './locations.js';

/** The user id to force into an actor filter, or undefined when the caller may see everyone's activity. */
export const ownActivityOnly = (user: Principal): string | undefined => (user.role === 'store_staff' ? user.id : undefined);
