import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { db } from '../src/db/index.js';
import { purgeOrphanFiles } from '../src/modules/ops/jobs.js';
import { sql } from 'drizzle-orm';
import { testApp, resetDb, seedOrg, seedShelf, seedCategory, seedPerson, seedAsset, seedConsumable, post, holder, auth, newKey, type App } from './helpers.js';

let app: App; let org: Awaited<ReturnType<typeof seedOrg>>;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); org = await seedOrg(app); });
const j = (r: { json: () => any }) => r.json();
const get = (url: string, token = org.token) => app.inject({ method: 'GET', url, headers: auth(token) });

test('creating a worker is retry-safe: the same Idempotency-Key makes one person, not two', async () => {
  const key = newKey();
  const mk = () => app.inject({ method: 'POST', url: '/v1/people', headers: auth(org.token, { 'idempotency-key': key }), payload: { fullName: 'Double Tap' } });
  const [a, b] = await Promise.all([mk(), mk()]);
  assert.ok([a.statusCode, b.statusCode].every((c) => [200, 201, 409].includes(c)));
  const again = await mk();
  assert.equal(again.json().id, a.json().id ?? b.json().id);
  assert.equal(j(await get('/v1/people?q=Double')).items.length, 1);
});

test('POST /auth/refresh swaps the token: the old one dies, the new one works', async () => {
  const r = await app.inject({ method: 'POST', url: '/v1/auth/refresh', headers: auth(org.token) });
  assert.equal(r.statusCode, 200);
  assert.equal((await get('/v1/auth/me', org.token)).statusCode, 401, 'old token is revoked');
  assert.equal((await get('/v1/auth/me', r.json().token)).statusCode, 200);
});

test('offline bootstrap: full snapshot first, then only what changed since serverTime', async () => {
  const john = await seedPerson(app, org.token); const gloves = await seedConsumable(app, org.token, 20); const drill = await seedAsset(app, org.token);
  const first = j(await get('/v1/sync/bootstrap'));
  assert.equal(first.items.length, 2); assert.equal(first.holders.people.length >= 1, true); assert.ok(first.stock.length === 1); assert.ok(first.categories.length === 1 && first.shelves.length === 1);
  await new Promise((r) => setTimeout(r, 6000)); // serverTime is backdated 5s
  await post(app, org.token, '/v1/checkouts', { itemId: drill, holder: holder(john) });
  await post(app, org.token, '/v1/consumptions', { itemId: gloves, quantity: 3 });
  const delta = j(await get(`/v1/sync/bootstrap?since=${encodeURIComponent(first.serverTime)}`));
  assert.deepEqual(delta.items.map((i: any) => i.id), [drill], 'only the asset whose row changed');
  assert.equal(delta.stock.find((s: any) => s.itemId === gloves).quantity, 17, 'changed stock rides along');
  assert.equal(delta.openCustody.length, 1);
});

test('items can be filtered by who holds them; holderType/holderId travel together', async () => {
  const john = await seedPerson(app, org.token); const mary = await seedPerson(app, org.token, 'Mary');
  const a = await seedAsset(app, org.token); const b = await seedAsset(app, org.token);
  await post(app, org.token, '/v1/checkouts', { itemId: a, holder: holder(john) }); await post(app, org.token, '/v1/checkouts', { itemId: b, holder: holder(mary) });
  assert.deepEqual(j(await get(`/v1/items?holderType=person&holderId=${john}`)).items.map((i: any) => i.id), [a]);
  assert.equal((await get(`/v1/items?holderId=${john}`)).statusCode, 400);
});

test('dashboard reports today\'s transactions in the org timezone, plus discrepancies; timezone is validated', async () => {
  const gloves = await seedConsumable(app, org.token, 20);
  await post(app, org.token, '/v1/consumptions', { itemId: gloves, quantity: 2 });
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/organization/settings', headers: auth(org.token), payload: { timezone: 'Mars/Olympus' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/v1/organization/settings', headers: auth(org.token), payload: { timezone: 'Africa/Lagos' } })).statusCode, 200);
  const d = j(await get('/v1/dashboard'));
  assert.equal(d.timezone, 'Africa/Lagos'); assert.ok(d.transactionsToday >= 2); assert.equal(d.discrepanciesOpen, 0);
  const s = j(await post(app, org.token, '/v1/reconciliation-sessions', { scope: 'location' }, null));
  await post(app, org.token, `/v1/reconciliation-sessions/${s.id}/counts`, { itemId: gloves, physicalQuantity: 15, reason: 'miscount' });
  assert.equal(j(await get('/v1/dashboard')).discrepancies30d, 1);
});

test('replacement retires the broken asset, links the new unit, and refuses a checked-out original', async () => {
  const old = await seedAsset(app, org.token, { name: 'Old drill' }); const fresh = await seedAsset(app, org.token, { name: 'New drill' }); const john = await seedPerson(app, org.token);
  await post(app, org.token, '/v1/checkouts', { itemId: old, holder: holder(john) });
  assert.equal((await post(app, org.token, `/v1/items/${old}/replacement`, { replacementItemId: fresh, note: 'burnt out' })).statusCode, 409);
  await post(app, org.token, '/v1/checkins', { itemId: old, condition: 'damaged' });
  const r = await post(app, org.token, `/v1/items/${old}/replacement`, { replacementItemId: fresh, note: 'burnt out' });
  assert.equal(r.statusCode, 201);
  assert.equal(j(await get(`/v1/items/${old}`)).assetStatus, 'retired');
  const tl = j(await get(`/v1/items/${fresh}/timeline`)).items;
  assert.ok(tl.some((t: any) => t.type === 'replacement' && t.relatedTransactionId), 'the new unit records what it replaced');
});

test('a category can ask for returns on consumables: due date set, overdue tracked; the org default never makes gloves overdue', async () => {
  const shelf = await seedShelf(app, org.token);
  const cables = await app.inject({ method: 'POST', url: '/v1/categories', headers: auth(org.token), payload: { shelfId: shelf, name: 'Cables', defaultExpectedReturnHours: 24 } });
  await app.inject({ method: 'PATCH', url: '/v1/organization/settings', headers: auth(org.token), payload: { defaultExpectedReturnHours: 1 } });
  const cable = await seedConsumable(app, org.token, 10, undefined, cables.json().id); const gloves = await seedConsumable(app, org.token, 10, undefined, await seedCategory(app, org.token, shelf));
  const john = await seedPerson(app, org.token);
  const a = j(await post(app, org.token, '/v1/checkouts', { itemId: cable, quantity: 2, holder: holder(john) })); const b = j(await post(app, org.token, '/v1/checkouts', { itemId: gloves, quantity: 2, holder: holder(john) }));
  assert.ok(a.dueAt, 'cable line has a due date'); assert.equal(b.dueAt, null, 'gloves never get one');
});

test('orphaned uploads are purged after a day; attached ones are kept', async () => {
  const { sniffImage } = await import('../src/modules/files/module.js'); void sniffImage;
  const [orphan] = await db.execute(sql`insert into files (org_id, kind, storage_key, content_type, size_bytes, sha256, uploaded_by, created_at)
    values (${org.orgId}::uuid, 'item_photo', 'x/orphan.png', 'image/png', 10, 'abc', ${org.userId}::uuid, now() - interval '3 days') returning id`) as unknown as Array<{ id: string }>;
  const [kept] = await db.execute(sql`insert into files (org_id, kind, storage_key, content_type, size_bytes, sha256, uploaded_by, created_at)
    values (${org.orgId}::uuid, 'item_photo', 'x/kept.png', 'image/png', 10, 'def', ${org.userId}::uuid, now() - interval '3 days') returning id`) as unknown as Array<{ id: string }>;
  const cat = await seedCategory(app, org.token);
  await app.inject({ method: 'POST', url: '/v1/items', headers: auth(org.token), payload: { type: 'asset', categoryId: cat, sku: 'PH-1', name: 'With photo', assetTag: 'PH-1', photoFileId: kept.id } });
  await purgeOrphanFiles(db);
  const left = (await db.execute(sql`select id from files`)) as unknown as Array<{ id: string }>;
  assert.ok(!left.some((f) => f.id === orphan.id)); assert.ok(left.some((f) => f.id === kept.id));
});
