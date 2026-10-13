/**
 * Integration tests run against REAL Postgres + Redis (`docker compose up -d db redis`, then `npm run db:setup`).
 * The guarantees under test are guarantees about what the database does under a real race; mocks can't tell you that.
 */
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { db } from '../src/db/index.js';

export type App = Awaited<ReturnType<typeof testApp>>;
export const newKey = () => `test-${randomBytes(12).toString('hex')}`;
export const uniq = (p = 'x') => `${p}-${Date.now()}-${randomBytes(3).toString('hex')}`;

export async function testApp() {
  const app = await buildApp();
  await app.ready();
  return app;
}

/** The ledger's TRUNCATE trigger is the point of the trigger; tests disable it only for the reset. */
export async function resetDb() {
  categoryCache.clear();
  await db.execute(sql`alter table transactions disable trigger user`);
  try {
    await db.execute(sql`truncate table organizations restart identity cascade`);
  } finally {
    await db.execute(sql`alter table transactions enable trigger user`);
  }
}

/** Every request gets a fresh Idempotency-Key (required on all create/POST routes) unless the test supplies its own. */
export const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, 'idempotency-key': newKey(), ...extra });

export async function seedOrg(app: App) {
  const res = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { organizationName: uniq('Org'), email: `admin-${uniq()}@example.com`, password: 'correct-horse-battery-staple' } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const b = res.json();
  return { token: b.token as string, orgId: b.orgId as string, userId: b.userId as string, locationId: b.locationId as string, slug: b.organizationSlug as string };
}

/** Admin invites a user, who accepts — exercises the real onboarding path. */
export async function seedUser(app: App, admin: Awaited<ReturnType<typeof seedOrg>>, role: 'admin' | 'store_staff' | 'supervisor' | 'viewer') {
  const email = `${role}-${uniq()}@example.com`;
  const inv = await app.inject({ method: 'POST', url: '/v1/users/invites', headers: auth(admin.token), payload: { email, role } });
  const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: inv.json().devToken, password: 'another-long-passphrase-123' } });
  if (acc.statusCode !== 201) throw new Error(`accept failed: ${acc.body}`);
  return { token: acc.json().token as string, userId: acc.json().userId as string, email };
}

export async function seedPerson(app: App, token: string, name = 'John Okafor') {
  const r = await app.inject({ method: 'POST', url: '/v1/people', headers: auth(token), payload: { fullName: name } });
  return r.json().id as string;
}

/** shelf → category, created through the API (an item cannot exist without them). Cached per token within a test. */
const categoryCache = new Map<string, string>();
export async function seedShelf(app: App, token: string, name = uniq('Shelf')) {
  const r = await app.inject({ method: 'POST', url: '/v1/shelves', headers: auth(token), payload: { name } });
  if (r.statusCode !== 201) throw new Error(`shelf failed: ${r.body}`);
  return r.json().id as string;
}
export async function seedCategory(app: App, token: string, shelfId?: string, name = uniq('Cat')) {
  const shelf = shelfId ?? await seedShelf(app, token);
  const r = await app.inject({ method: 'POST', url: '/v1/categories', headers: auth(token), payload: { shelfId: shelf, name } });
  if (r.statusCode !== 201) throw new Error(`category failed: ${r.body}`);
  return r.json().id as string;
}
export async function defaultCategory(app: App, token: string) {
  let id = categoryCache.get(token);
  if (!id) { id = await seedCategory(app, token); categoryCache.set(token, id); }
  return id;
}

export async function seedAsset(app: App, token: string, o: Partial<{ sku: string; name: string; expectedReturnHours: number; categoryId: string }> = {}) {
  const categoryId = o.categoryId ?? await defaultCategory(app, token);
  const r = await app.inject({ method: 'POST', url: '/v1/items', headers: auth(token, { 'idempotency-key': newKey() }), payload: { type: 'asset', categoryId, sku: o.sku ?? uniq('SKU'), name: o.name ?? 'Test Drill', assetTag: uniq('TAG'), expectedReturnHours: o.expectedReturnHours } });
  if (r.statusCode !== 201) throw new Error(`asset failed: ${r.body}`);
  return r.json().id as string;
}

export async function seedConsumable(app: App, token: string, openingQuantity: number, minThreshold?: number, categoryId?: string) {
  const cat = categoryId ?? await defaultCategory(app, token);
  const r = await app.inject({ method: 'POST', url: '/v1/items', headers: auth(token, { 'idempotency-key': newKey() }), payload: { type: 'consumable', categoryId: cat, sku: uniq('SKU'), name: 'Test Gloves', openingQuantity, minThreshold } });
  if (r.statusCode !== 201) throw new Error(`consumable failed: ${r.body}`);
  return r.json().id as string;
}

export const holder = (personId: string) => ({ type: 'person' as const, id: personId });

export async function post(app: App, token: string, url: string, payload: unknown, key: string | null = newKey()) {
  return app.inject({ method: 'POST', url, headers: auth(token, key ? { 'idempotency-key': key } : {}), payload: payload as object });
}

export async function stockOf(app: App, token: string, itemId: string): Promise<number> {
  const r = await app.inject({ method: 'GET', url: `/v1/items/${itemId}`, headers: auth(token) });
  return r.json().quantityAvailable as number;
}

export function buildMultipartCsv(filename: string, csv: string) {
  const boundary = `----test${Math.random().toString(36).slice(2)}`;
  const body = [`--${boundary}`, `Content-Disposition: form-data; name="file"; filename="${filename}"`, 'Content-Type: text/csv', '', csv, `--${boundary}--`, ''].join('\r\n');
  return { body: Buffer.from(body, 'utf8'), contentType: `multipart/form-data; boundary=${boundary}` };
}
