/**
 * Drizzle schema for StoreKeeper (PRD v3).
 *
 * Decisions that recur throughout (explained once, here):
 *
 * 1. Multi-tenancy: every business table carries `orgId`, every query filters
 *    on it. Single database, row-level isolation (see references/security.md).
 * 2. Quantities are integers. Fractional units would need numeric(12,3).
 * 3. The `transactions` ledger is append-only (PRD §24/§50). Application code
 *    never UPDATEs or DELETEs it, and a DB trigger enforces that even for a
 *    compromised or buggy code path (drizzle/manual/0002_ledger_immutability.sql).
 * 4. Inventory state is DERIVED from the ledger (PRD §12). `stock_levels` and
 *    `custody` are denormalised read models written in the same DB
 *    transaction as the ledger row. Each ledger row carries a signed
 *    `stock_delta` / `custody_delta`, so an integrity job can prove
 *    SUM(delta) == read model at any time (modules/integrity).
 * 5. Location-aware from day one (PRD §9): stock lives in
 *    `stock_levels(item, location)`, assets carry `location_id`, every
 *    transaction records its location. One active location per org at launch is
 *    an entitlement (`org_settings.location_limit`), not a schema limit.
 * 6. Actor vs Holder (PRD §8): Actor is always a login `user`; Holder is a
 *    `person`, `team` (team or department) or `job` — three nullable FK columns
 *    so Postgres enforces referential integrity on each.
 * 7. Time: `occurred_at` is when it physically happened (client clock for
 *    offline replays, clamped); `created_at` is when the server recorded it;
 *    `seq` is the server's total order and what inventory arithmetic follows.
 */
import {
  pgTable, pgEnum, uuid, text, integer, bigint, boolean, timestamp, jsonb,
  uniqueIndex, index, primaryKey, check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ── Enums ────────────────────────────────────────────────────────────
export const roleEnum = pgEnum('role', ['admin', 'store_staff', 'supervisor', 'viewer']);
export const itemTypeEnum = pgEnum('item_type', ['asset', 'consumable']);
// PRD §12 asset state. Condition (below) is a separate axis (PRD §15.2).
export const assetStatusEnum = pgEnum('asset_status', [
  'available', 'checked_out', 'lost', 'damaged', 'under_repair', 'retired',
]);
export const conditionEnum = pgEnum('condition', ['good', 'damaged', 'needs_inspection', 'replaced']);
export const holderTypeEnum = pgEnum('holder_type', ['person', 'team', 'job']);
export const teamKindEnum = pgEnum('team_kind', ['team', 'department']);
export const jobKindEnum = pgEnum('job_kind', ['job', 'project', 'site', 'task']);
export const locationKindEnum = pgEnum('location_kind', ['store', 'site', 'warehouse', 'area']);
export const adjustmentReasonEnum = pgEnum('adjustment_reason', [
  'count_correction', 'opening_balance', 'unrecorded_movement', 'damage', 'loss', 'other',
]);
export const transactionTypeEnum = pgEnum('transaction_type', [
  'create', 'checkout', 'checkin', 'consume', 'restock', 'adjustment',
  'loss', 'damage', 'condition_update', 'status_change', 'archive', 'restore',
  'transfer_out', 'transfer_in', 'reconciliation_adjustment', 'replacement',
]);
export const txSourceEnum = pgEnum('tx_source', ['online', 'offline_sync', 'import', 'system']);
// PRD §32. `request` = staff queue, supervisors/admins self-commit;
// `approval` = staff and supervisors queue, only admins self-commit.
export const approvalModeEnum = pgEnum('approval_mode', ['direct', 'request', 'approval']);
export const approvalOperationEnum = pgEnum('approval_operation', [
  'adjustment', 'loss', 'damage', 'retirement', 'manual_correction', 'checkout', 'checkin',
]);
export const approvalStatusEnum = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'failed']);
export const reconciliationScopeEnum = pgEnum('reconciliation_scope', ['item', 'category', 'shelf', 'location']);
export const reconciliationStatusEnum = pgEnum('reconciliation_status', ['open', 'closed']);
export const importStatusEnum = pgEnum('import_status', ['uploaded', 'validating', 'ready', 'queued', 'committing', 'completed', 'failed']);
export const syncConflictStatusEnum = pgEnum('sync_conflict_status', ['open', 'resolved_kept_server', 'resolved_applied_client']);
export const fileKindEnum = pgEnum('file_kind', ['item_photo', 'transaction_snapshot']);
export const notificationTypeEnum = pgEnum('notification_type', [
  'low_stock', 'overdue_checkout', 'reconciliation_discrepancy', 'sync_failure', 'approval_pending',
  'approval_resolved', 'integrity_alert', 'reconciliation_due', 'announcement',
]);
export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'sent', 'failed', 'dead']);

// ── Identity & tenancy ───────────────────────────────────────────────
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  // Login resolves the org by slug first: email is unique per org, not globally.
  slug: text('slug').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ slugUnique: uniqueIndex('organizations_slug_unique').on(t.slug) }));

// One row per org of mutable configuration (PRD §18, §23, §30, §9).
export const orgSettings = pgTable('org_settings', {
  orgId: uuid('org_id').primaryKey().references(() => organizations.id),
  locationLimit: integer('location_limit').notNull().default(1), // PRD §9/§47: one active store at launch
  requireReconciliationReason: boolean('require_reconciliation_reason').notNull().default(true), // PRD §56.4
  // Transaction types for which a snapshot photo is mandatory (PRD §23 "unless configured by policy").
  photoRequiredFor: text('photo_required_for').array().notNull().default(sql`'{}'::text[]`),
  defaultExpectedReturnHours: integer('default_expected_return_hours'),
  timezone: text('timezone').notNull().default('UTC'), // IANA name; decides what "today" means on the dashboard
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  code: text('code'),
  kind: locationKindEnum('kind').notNull().default('store'),
  parentId: uuid('parent_id'),
  address: text('address'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrg: index('locations_org_idx').on(t.orgId),
  codeUnique: uniqueIndex('locations_org_code_unique').on(t.orgId, t.code).where(sql`archived_at is null and code is not null`),
}));

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  fullName: text('full_name'), // shown in activity feeds ("Ben checked out…"); falls back to the email name
  passwordHash: text('password_hash').notNull(),
  role: roleEnum('role').notNull().default('store_staff'),
  active: boolean('active').notNull().default(true),
  failedLoginCount: integer('failed_login_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }).notNull().defaultNow(),
  // Links the admin rows of ONE person who runs several organisations. Only ever set when an authenticated admin creates
  // another organisation, never from an email match (email is not verified, so matching on it would let anyone claim an
  // admin's other organisations). Invited users never get one: they work in exactly one organisation.
  accountId: uuid('account_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgEmailUnique: uniqueIndex('users_org_email_unique').on(t.orgId, t.email),
  byAccount: uniqueIndex('users_account_org_unique').on(t.accountId, t.orgId).where(sql`account_id is not null`), // one row per organisation per account
}));

// Location-scoped permissions (PRD Phase 2). A user with NO rows may act at every
// location; a user with rows is confined to exactly those.
export const userLocations = pgTable('user_locations', {
  userId: uuid('user_id').notNull().references(() => users.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.locationId] }) }));

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  ip: text('ip'),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenHashUnique: uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
  byUser: index('sessions_user_idx').on(t.userId),
}));

// Invites and password resets share one single-use token table (hash only stored).
export const userTokens = pgTable('user_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  purpose: text('purpose').notNull(), // 'invite' | 'password_reset'
  email: text('email').notNull(),
  role: roleEnum('role'),             // invites only
  userId: uuid('user_id').references(() => users.id), // resets only
  personId: uuid('person_id'),        // optional link applied on invite acceptance
  fullName: text('full_name'),        // invites only
  locationIds: uuid('location_ids').array(), // invites only: confine the new user to these locations
  tokenHash: text('token_hash').notNull(),
  createdBy: uuid('created_by').references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenHashUnique: uniqueIndex('user_tokens_hash_unique').on(t.tokenHash),
  byOrgPurpose: index('user_tokens_org_purpose_idx').on(t.orgId, t.purpose),
}));

// ── People & Holders (PRD §8) ───────────────────────────────────────
// A worker who never logs in is still a Holder: `people` is separate from `users`.
export const people = pgTable('people', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  fullName: text('full_name').notNull(),
  employeeCode: text('employee_code'),
  phone: text('phone'),
  email: text('email'),
  userId: uuid('user_id').references(() => users.id), // optional login account
  active: boolean('active').notNull().default(true),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrg: index('people_org_idx').on(t.orgId),
  codeUnique: uniqueIndex('people_org_code_unique').on(t.orgId, t.employeeCode).where(sql`archived_at is null and employee_code is not null`),
  userUnique: uniqueIndex('people_user_unique').on(t.userId).where(sql`user_id is not null`),
  nameTrgm: index('people_name_trgm_idx').using('gin', sql`${t.fullName} gin_trgm_ops`),
}));

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  kind: teamKindEnum('kind').notNull().default('team'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byOrg: index('teams_org_idx').on(t.orgId) }));

export const teamMembers = pgTable('team_members', {
  teamId: uuid('team_id').notNull().references(() => teams.id),
  personId: uuid('person_id').notNull().references(() => people.id),
}, (t) => ({ pk: primaryKey({ columns: [t.teamId, t.personId] }) }));

// Job / project / site / task: usable as transaction context (PRD §10) AND as a Holder (§8).
export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  code: text('code'),
  name: text('name').notNull(),
  kind: jobKindEnum('kind').notNull().default('job'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrg: index('jobs_org_idx').on(t.orgId),
  codeUnique: uniqueIndex('jobs_org_code_unique').on(t.orgId, t.code).where(sql`archived_at is null and code is not null`),
}));

// ── Files (PRD §23, §37, §52) ───────────────────────────────────────
export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  kind: fileKindEnum('kind').notNull(),
  storageKey: text('storage_key').notNull(), // object key in the private bucket; never exposed raw
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byOrg: index('files_org_idx').on(t.orgId, t.createdAt) }));

// ── Catalogue (PRD §6, §7) ──────────────────────────────────────────
// Hierarchy: location → shelf → category → item. A shelf is a physical rack/area in ONE location (immutable once
// created: items inherit their home location from their shelf). Shelves and categories are created separately;
// a category must sit under a shelf, an item under a category. It is a separate entity from `locations` because
// stock is counted per location, not per shelf — modelling shelves as sub-locations would force stock-per-shelf.
export const shelves = pgTable('shelves', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  name: text('name').notNull(),
  code: text('code'),
  description: text('description'),
  color: text('color'), // palette key (lib/appearance.ts)
  icon: text('icon'),   // icon key (lib/appearance.ts)
  sortOrder: integer('sort_order').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrgLocation: index('shelves_org_location_idx').on(t.orgId, t.locationId),
  nameUnique: uniqueIndex('shelves_location_name_unique').on(t.locationId, t.name).where(sql`archived_at is null`),
  codeUnique: uniqueIndex('shelves_org_code_unique').on(t.orgId, t.code).where(sql`archived_at is null and code is not null`),
}));

export const categories = pgTable('categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  shelfId: uuid('shelf_id').notNull().references(() => shelves.id),
  name: text('name').notNull(),
  defaultMinThreshold: integer('default_min_threshold'),
  defaultExpectedReturnHours: integer('default_expected_return_hours'), // PRD §27
  color: text('color'),
  icon: text('icon'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => ({
  byOrg: index('categories_org_idx').on(t.orgId),
  byShelf: index('categories_shelf_idx').on(t.shelfId),
  nameUnique: uniqueIndex('categories_shelf_name_unique').on(t.shelfId, t.name).where(sql`archived_at is null`),
}));

// One row per Tracked Asset (a physical object) or per Consumable line (PRD §7).
export const items = pgTable('items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: itemTypeEnum('type').notNull(),
  sku: text('sku').notNull(),
  assetTag: text('asset_tag'),          // e.g. DRL-0042 — assets only
  name: text('name').notNull(),
  description: text('description'),
  categoryId: uuid('category_id').notNull().references(() => categories.id), // every item lives under a category
  photoFileId: uuid('photo_file_id').references(() => files.id),
  color: text('color'), // shown on the item card when there is no photo
  icon: text('icon'),
  qrCode: text('qr_code'),
  locationId: uuid('location_id').notNull().references(() => locations.id), // asset's current location / consumable's home location

  // Tracked Asset state (null for consumables)
  assetStatus: assetStatusEnum('asset_status'),
  condition: conditionEnum('condition'),     // last known condition (PRD §13.1)
  expectedReturnHours: integer('expected_return_hours'), // PRD §27, overrides category/org default

  // Consumable config (null for assets). Quantity lives in stock_levels.
  unit: text('unit'),
  minThreshold: integer('min_threshold'),    // PRD §28
  reorderQuantity: integer('reorder_quantity'),

  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  updatedBy: uuid('updated_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgSkuUnique: uniqueIndex('items_org_sku_unique').on(t.orgId, t.sku).where(sql`archived_at is null`),
  orgQrUnique: uniqueIndex('items_org_qr_unique').on(t.orgId, t.qrCode).where(sql`archived_at is null and qr_code is not null`),
  orgTagUnique: uniqueIndex('items_org_asset_tag_unique').on(t.orgId, t.assetTag).where(sql`archived_at is null and asset_tag is not null`),
  byOrgStatus: index('items_org_status_idx').on(t.orgId, t.assetStatus),
  byOrgCategory: index('items_org_category_idx').on(t.orgId, t.categoryId),
  byCategoryCreated: index('items_org_category_created_idx').on(t.orgId, t.categoryId, t.createdAt, t.id), // keyset browsing inside one category
  byOrgLocation: index('items_org_location_idx').on(t.orgId, t.locationId),
  nameTrgm: index('items_name_trgm_idx').using('gin', sql`${t.name} gin_trgm_ops`),
  assetAvailabilityConsistent: check('items_asset_fields_chk', sql`(${t.type} = 'asset' and ${t.assetStatus} is not null) or (${t.type} = 'consumable' and ${t.assetStatus} is null)`),
}));

// Consumable stock per (item, location) — the PRD §9 "no rewrite later" structure.
export const stockLevels = pgTable('stock_levels', {
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  quantity: integer('quantity').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.itemId, t.locationId] }),
  nonNegative: check('stock_levels_quantity_nonneg', sql`${t.quantity} >= 0`), // backstop to the guarded UPDATEs
  byOrgLocation: index('stock_levels_org_location_idx').on(t.orgId, t.locationId),
}));

// Who currently holds what (PRD §26). One row per asset out; one per (consumable, holder).
export const custody = pgTable('custody', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  holderType: holderTypeEnum('holder_type').notNull(),
  holderPersonId: uuid('holder_person_id').references(() => people.id),
  holderTeamId: uuid('holder_team_id').references(() => teams.id),
  holderJobId: uuid('holder_job_id').references(() => jobs.id),
  holderKey: text('holder_key').notNull(), // `${type}:${id}` — uniqueness without a polymorphic FK
  locationId: uuid('location_id').notNull().references(() => locations.id), // where it was issued from
  jobId: uuid('job_id').references(() => jobs.id),
  quantity: integer('quantity').notNull(),
  issuedQuantity: integer('issued_quantity').notNull(), // total issued since this row opened; quantity < issued => 'partial return'
  checkedOutAt: timestamp('checked_out_at', { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp('due_at', { withTimezone: true }), // PRD §27 — assets
  lastTransactionId: uuid('last_transaction_id'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  itemHolderUnique: uniqueIndex('custody_item_holder_unique').on(t.orgId, t.itemId, t.holderKey),
  outstanding: index('custody_org_open_idx').on(t.orgId, t.checkedOutAt).where(sql`quantity > 0`),
  overdue: index('custody_org_due_idx').on(t.orgId, t.dueAt).where(sql`quantity > 0 and due_at is not null`),
  byHolder: index('custody_org_holder_idx').on(t.orgId, t.holderKey),
  nonNegative: check('custody_quantity_nonneg', sql`${t.quantity} >= 0`),
}));

// ── The immutable ledger (PRD §11, §24, §50) ───────────────────────
export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(), // server total order
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: transactionTypeEnum('type').notNull(),
  itemId: uuid('item_id').notNull().references(() => items.id),
  itemType: itemTypeEnum('item_type').notNull(), // PRD §11 "Item ID & Type" — denormalised so the ledger is self-describing
  locationId: uuid('location_id').notNull().references(() => locations.id),
  counterpartLocationId: uuid('counterpart_location_id').references(() => locations.id), // transfers
  quantity: integer('quantity'),                // magnitude; null for whole-asset events
  stockDelta: integer('stock_delta'),           // signed effect on stock_levels(item, location)
  custodyDelta: integer('custody_delta'),       // signed effect on custody for this holder

  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  holderType: holderTypeEnum('holder_type'),
  holderPersonId: uuid('holder_person_id').references(() => people.id),
  holderTeamId: uuid('holder_team_id').references(() => teams.id),
  holderJobId: uuid('holder_job_id').references(() => jobs.id),
  jobId: uuid('job_id').references(() => jobs.id), // job/site context, independent of holder
  purpose: text('purpose'),

  condition: conditionEnum('condition'),
  fromStatus: assetStatusEnum('from_status'),
  toStatus: assetStatusEnum('to_status'),
  reason: adjustmentReasonEnum('reason'),
  note: text('note'),
  snapshotFileId: uuid('snapshot_file_id').references(() => files.id), // PRD §23

  correctsTransactionId: uuid('corrects_transaction_id'), // PRD §50
  relatedTransactionId: uuid('related_transaction_id'),   // transfer pair / replacement link
  idempotencyKey: text('idempotency_key'),

  source: txSourceEnum('source').notNull().default('online'),
  deviceId: text('device_id'),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgActorIdempotencyUnique: uniqueIndex('tx_org_actor_idempotency_unique')
    .on(t.orgId, t.actorUserId, t.idempotencyKey).where(sql`idempotency_key is not null`),
  byItemOccurred: index('tx_item_occurred_idx').on(t.itemId, t.occurredAt, t.seq),
  byOrgCreated: index('tx_org_created_idx').on(t.orgId, t.createdAt, t.id),
  byOrgSeq: index('tx_org_seq_idx').on(t.orgId, t.seq),
  byOrgOccurred: index('tx_org_occurred_idx').on(t.orgId, t.occurredAt), // dashboard analytics windows (occurred_at differs from created_at for offline-synced entries)
  byOrgTypeCreated: index('tx_org_type_created_idx').on(t.orgId, t.type, t.createdAt),
  byOrgLocation: index('tx_org_location_idx').on(t.orgId, t.locationId, t.createdAt),
  byHolder: index('tx_org_holder_person_idx').on(t.orgId, t.holderPersonId),
  byActor: index('tx_org_actor_idx').on(t.orgId, t.actorUserId, t.createdAt),
}));

// ── Approvals (PRD §18, §32) ────────────────────────────────────────
// Per-operation policy; `largeThreshold` = only quantities >= it need review (null = always).
export const approvalPolicies = pgTable('approval_policies', {
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  operation: approvalOperationEnum('operation').notNull(),
  mode: approvalModeEnum('mode').notNull().default('direct'),
  largeThreshold: integer('large_threshold'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.operation] }) }));

export const approvalRequests = pgTable('approval_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  operation: approvalOperationEnum('operation').notNull(),
  payload: jsonb('payload').notNull(), // the full draft; executing it later = calling the same service
  itemId: uuid('item_id').references(() => items.id),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  status: approvalStatusEnum('status').notNull().default('pending'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewNote: text('review_note'),
  resultingTransactionId: uuid('resulting_transaction_id').references(() => transactions.id),
  failureReason: text('failure_reason'),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrgStatus: index('approval_requests_org_status_idx').on(t.orgId, t.status, t.createdAt),
  idempotencyUnique: uniqueIndex('approval_requests_idempotency_unique')
    .on(t.orgId, t.requestedBy, t.idempotencyKey).where(sql`idempotency_key is not null`),
}));

// ── Reconciliation (PRD §19, §56.4) ─────────────────────────────────
export const reconciliationSessions = pgTable('reconciliation_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  scope: reconciliationScopeEnum('scope').notNull(),
  scopeId: uuid('scope_id'),
  scheduleId: uuid('schedule_id'),
  status: reconciliationStatusEnum('status').notNull().default('open'),
  startedBy: uuid('started_by').notNull().references(() => users.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  dueAt: timestamp('due_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (t) => ({ byOrgStatus: index('recon_sessions_org_status_idx').on(t.orgId, t.status, t.startedAt) }));

export const reconciliationCounts = pgTable('reconciliation_counts', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id').notNull().references(() => reconciliationSessions.id),
  itemId: uuid('item_id').notNull().references(() => items.id),
  systemQuantityAtCount: integer('system_quantity_at_count').notNull(), // preserved original (PRD §56.4)
  physicalQuantity: integer('physical_quantity').notNull(),
  variance: integer('variance').notNull(),
  reason: text('reason'),
  note: text('note'),
  snapshotFileId: uuid('snapshot_file_id').references(() => files.id),
  countedBy: uuid('counted_by').notNull().references(() => users.id),
  linkedAdjustmentTransactionId: uuid('linked_adjustment_transaction_id').references(() => transactions.id),
  linkedApprovalRequestId: uuid('linked_approval_request_id').references(() => approvalRequests.id),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  idempotencyKey: text('idempotency_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  bySession: index('recon_counts_session_idx').on(t.sessionId),
  byItem: index('recon_counts_item_idx').on(t.itemId, t.createdAt),
  sessionIdempotencyUnique: uniqueIndex('recon_counts_session_idempotency_unique')
    .on(t.sessionId, t.idempotencyKey).where(sql`idempotency_key is not null`),
}));

// Scheduled counts (PRD §41 "% of scheduled counts completed on time").
export const reconciliationSchedules = pgTable('reconciliation_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  scope: reconciliationScopeEnum('scope').notNull(),
  scopeId: uuid('scope_id'),
  intervalDays: integer('interval_days').notNull(),
  nextDueAt: timestamp('next_due_at', { withTimezone: true }).notNull(),
  active: boolean('active').notNull().default(true),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ byDue: index('recon_schedules_due_idx').on(t.active, t.nextDueAt) }));

// ── CSV import (PRD §22) ────────────────────────────────────────────
export const importJobs = pgTable('import_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  fileName: text('file_name').notNull(),
  headers: jsonb('headers'),
  rows: jsonb('rows'), // legacy: rows now live in import_rows; kept so old jobs still read
  columnMapping: jsonb('column_mapping'),
  fileBytes: bigint('file_bytes', { mode: 'number' }),
  processedRows: integer('processed_rows').notNull().default(0), // progress / resume pointer for the running stage
  validRows: integer('valid_rows'),
  invalidRows: integer('invalid_rows'),
  failureReason: text('failure_reason'),
  status: importStatusEnum('status').notNull().default('uploaded'),
  totalRows: integer('total_rows'),
  importedRows: integer('imported_rows'),
  skippedRows: integer('skipped_rows'),
  failedRows: integer('failed_rows'),
  errorReport: jsonb('error_report'),
  startedBy: uuid('started_by').notNull().references(() => users.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => ({ byOrg: index('import_jobs_org_idx').on(t.orgId, t.startedAt) }));

// Staging area for an uploaded CSV, one row per record. Streaming the upload into this table (instead of one giant JSON
// column) keeps memory flat for any file size, lets validation and commit page through it, and makes both resumable.
export const importRows = pgTable('import_rows', {
  importId: uuid('import_id').notNull().references(() => importJobs.id, { onDelete: 'cascade' }),
  rowNo: integer('row_no').notNull(), // 1-based position among data rows (the CSV line number is rowNo + 1)
  data: jsonb('data').notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.importId, t.rowNo] }) }));

// ── Offline sync (PRD §21, §56.5) ───────────────────────────────────
export const syncConflicts = pgTable('sync_conflicts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  deviceId: text('device_id').notNull(),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  clientGeneratedId: text('client_generated_id').notNull(),
  attemptedTransaction: jsonb('attempted_transaction').notNull(),
  itemId: uuid('item_id').references(() => items.id),
  conflictReason: text('conflict_reason').notNull(),
  failureKind: text('failure_kind').notNull().default('conflict'), // 'conflict' | 'failed'
  status: syncConflictStatusEnum('status').notNull().default('open'),
  resolutionNote: text('resolution_note'),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: uuid('resolved_by').references(() => users.id),
}, (t) => ({
  byOrgStatus: index('sync_conflicts_org_status_idx').on(t.orgId, t.status, t.detectedAt),
  // A device re-sending the same failing action must not pile up duplicate conflict rows.
  perActionUnique: uniqueIndex('sync_conflicts_action_unique').on(t.orgId, t.actorUserId, t.clientGeneratedId),
}));

// ── Notifications & email outbox (PRD §30) ──────────────────────────
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: notificationTypeEnum('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  data: jsonb('data'),
  // Audience by role (null = everyone with a notifying role). Read state is per notification
  // *per user* in notification_reads, so one supervisor reading it does not hide it from another.
  audienceRoles: roleEnum('audience_roles').array().notNull().default(sql`'{admin,supervisor}'::role[]`),
  dedupeKey: text('dedupe_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byOrgCreated: index('notifications_org_created_idx').on(t.orgId, t.createdAt, t.id),
  dedupeUnique: uniqueIndex('notifications_dedupe_unique').on(t.orgId, t.dedupeKey).where(sql`dedupe_key is not null`),
}));

export const notificationReads = pgTable('notification_reads', {
  notificationId: uuid('notification_id').notNull().references(() => notifications.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.notificationId, t.userId] }) }));

// Org-wide, role-based delivery rules per notification type (PRD §30). No row = built-in default (lib/notify.ts).
export const notificationRules = pgTable('notification_rules', {
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  type: notificationTypeEnum('type').notNull(),
  roles: roleEnum('roles').array().notNull(),   // who receives it
  inApp: boolean('in_app').notNull().default(true),
  email: boolean('email').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.orgId, t.type] }) }));

// Transactional outbox: the email is committed with the business event, delivered by the worker.
export const emailOutbox = pgTable('email_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  toEmail: text('to_email').notNull(),
  subject: text('subject').notNull(),
  textBody: text('text_body').notNull(),
  status: outboxStatusEnum('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  dedupeKey: text('dedupe_key'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp('sent_at', { withTimezone: true }),
}, (t) => ({
  due: index('email_outbox_due_idx').on(t.status, t.nextAttemptAt),
  dedupeUnique: uniqueIndex('email_outbox_dedupe_unique').on(t.orgId, t.dedupeKey).where(sql`dedupe_key is not null`),
}));

// ── Cross-request idempotency for non-ledger writes ─────────────────
export const idempotencyKeys = pgTable('idempotency_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  actorUserId: uuid('actor_user_id').notNull().references(() => users.id),
  key: text('key').notNull(),
  requestFingerprint: text('request_fingerprint').notNull(),
  responseStatus: integer('response_status'),
  responseBody: jsonb('response_body'),
  lockedAt: timestamp('locked_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (t) => ({
  orgActorKeyUnique: uniqueIndex('idem_org_actor_key_unique').on(t.orgId, t.actorUserId, t.key),
  byExpiry: index('idem_expires_idx').on(t.expiresAt),
}));

// ── Audit events (PRD §24): previous + new state for every material change ──
export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  actorUserId: uuid('actor_user_id').references(() => users.id), // null = system/worker
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  previousState: jsonb('previous_state'),
  newState: jsonb('new_state'),
  reason: text('reason'),
  transactionId: uuid('transaction_id'),
  metadata: jsonb('metadata'),
  requestId: text('request_id'),
  ip: text('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byActor: index('audit_actor_idx').on(t.orgId, t.actorUserId, t.createdAt),
  byOrgCreated: index('audit_org_created_idx').on(t.orgId, t.createdAt, t.id),
  byEntity: index('audit_entity_idx').on(t.orgId, t.entityType, t.entityId),
}));

// ── Relations ───────────────────────────────────────────────────────
export const itemsRelations = relations(items, ({ one, many }) => ({
  category: one(categories, { fields: [items.categoryId], references: [categories.id] }),
  location: one(locations, { fields: [items.locationId], references: [locations.id] }),
  transactions: many(transactions),
}));
export const transactionsRelations = relations(transactions, ({ one }) => ({
  item: one(items, { fields: [transactions.itemId], references: [items.id] }),
  actor: one(users, { fields: [transactions.actorUserId], references: [users.id] }),
}));
