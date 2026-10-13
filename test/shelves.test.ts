import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetDb, seedOrg, seedUser, seedShelf, seedCategory, seedConsumable, seedAsset, post, holder, seedPerson, auth, uniq, newKey, type App } from './helpers.js';

let app: App; let admin: Awaited<ReturnType<typeof seedOrg>>;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); admin = await seedOrg(app); });

const j = (r: { json: () => any }) => r.json();

test('hierarchy is enforced: a category needs an existing shelf, an item needs an existing category', async () => {
  const noShelf = await app.inject({ method: 'POST', url: '/v1/categories', headers: auth(admin.token), payload: { name: 'Orphan' } });
  assert.equal(noShelf.statusCode, 400);
  const ghostShelf = await app.inject({ method: 'POST', url: '/v1/categories', headers: auth(admin.token), payload: { shelfId: '00000000-0000-0000-0000-000000000000', name: 'Ghost' } });
  assert.equal(ghostShelf.statusCode, 400);
  const noCat = await app.inject({ method: 'POST', url: '/v1/items', headers: auth(admin.token, { 'idempotency-key': newKey() }), payload: { type: 'consumable', sku: uniq('S'), name: 'No category', openingQuantity: 1 } });
  assert.equal(noCat.statusCode, 400);
  const badCat = await app.inject({ method: 'POST', url: '/v1/items', headers: auth(admin.token, { 'idempotency-key': newKey() }), payload: { type: 'consumable', categoryId: '00000000-0000-0000-0000-000000000000', sku: uniq('S'), name: 'Bad', openingQuantity: 1 } });
  assert.equal(badCat.statusCode, 400);
});

test('one shelf holds many categories, a category holds many items, and the browse API reports the roll-up', async () => {
  const shelf = await seedShelf(app, admin.token, 'Safety wall');
  const gloves = await seedCategory(app, admin.token, shelf, 'Gloves'); const helmets = await seedCategory(app, admin.token, shelf, 'Helmets');
  await seedConsumable(app, admin.token, 40, 50, gloves); await seedConsumable(app, admin.token, 100, 10, gloves); await seedAsset(app, admin.token, { categoryId: helmets });
  const detail = j(await app.inject({ method: 'GET', url: `/v1/shelves/${shelf}`, headers: auth(admin.token) }));
  assert.equal(detail.categories.length, 2);
  const g = detail.categories.find((c: any) => c.name === 'Gloves');
  assert.equal(g.stats.products, 2); assert.equal(g.stats.units, 140); assert.equal(g.stats.lowStock, 1);
  assert.equal(detail.stats.assets, 1);
  const items = j(await app.inject({ method: 'GET', url: `/v1/items?shelfId=${shelf}`, headers: auth(admin.token) }));
  assert.equal(items.items.length, 3); assert.ok(items.items.every((i: any) => i.shelfName === 'Safety wall'));
});

test('names are unique per shelf, not globally', async () => {
  const a = await seedShelf(app, admin.token); const b = await seedShelf(app, admin.token);
  await seedCategory(app, admin.token, a, 'Gloves');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/categories', headers: auth(admin.token), payload: { shelfId: a, name: 'Gloves' } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/categories', headers: auth(admin.token), payload: { shelfId: b, name: 'Gloves' } })).statusCode, 201);
});

test('non-empty shelves and categories cannot be archived; moving a category carries its items', async () => {
  const s1 = await seedShelf(app, admin.token); const s2 = await seedShelf(app, admin.token); const cat = await seedCategory(app, admin.token, s1);
  const item = await seedConsumable(app, admin.token, 5, undefined, cat);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/shelves/${s1}`, headers: auth(admin.token) })).statusCode, 409);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/categories/${cat}`, headers: auth(admin.token) })).statusCode, 409);
  const mv = await app.inject({ method: 'PATCH', url: `/v1/categories/${cat}`, headers: auth(admin.token), payload: { shelfId: s2 } });
  assert.equal(mv.statusCode, 200);
  assert.equal(j(await app.inject({ method: 'GET', url: `/v1/items/${item}`, headers: auth(admin.token) })).shelfId, s2);
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/shelves/${s1}`, headers: auth(admin.token) })).statusCode, 204);
});

test('bulk-move re-files items under another category in one step', async () => {
  const shelf = await seedShelf(app, admin.token); const c1 = await seedCategory(app, admin.token, shelf); const c2 = await seedCategory(app, admin.token, shelf);
  const a = await seedConsumable(app, admin.token, 5, undefined, c1); const b = await seedConsumable(app, admin.token, 5, undefined, c1);
  assert.equal(j(await post(app, admin.token, '/v1/items/bulk-move', { itemIds: [a, b], categoryId: c2 }, null)).moved, 2);
  assert.equal(j(await app.inject({ method: 'GET', url: `/v1/items/${a}`, headers: auth(admin.token) })).categoryId, c2);
});

test('only admins manage shelves and categories', async () => {
  const sup = await seedUser(app, admin, 'supervisor');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/shelves', headers: auth(sup.token), payload: { name: 'Nope' } })).statusCode, 403);
});

test('shelf-scoped stock counts cover exactly the items on that shelf', async () => {
  const s1 = await seedShelf(app, admin.token); const s2 = await seedShelf(app, admin.token);
  const inShelf = await seedConsumable(app, admin.token, 10, undefined, await seedCategory(app, admin.token, s1)); const other = await seedConsumable(app, admin.token, 10, undefined, await seedCategory(app, admin.token, s2));
  const sess = j(await post(app, admin.token, '/v1/reconciliation-sessions', { scope: 'shelf', scopeId: s1 }, null));
  assert.equal((await post(app, admin.token, `/v1/reconciliation-sessions/${sess.id}/counts`, { itemId: inShelf, physicalQuantity: 10 })).statusCode, 201);
  assert.equal((await post(app, admin.token, `/v1/reconciliation-sessions/${sess.id}/counts`, { itemId: other, physicalQuantity: 10 })).statusCode, 400);
});

test('UI-kit read APIs: outstanding shows overdue/partial states; holder search spans people, teams and jobs; activity feed is human-ready', async () => {
  const john = await seedPerson(app, admin.token, 'John Okafor');
  await app.inject({ method: 'POST', url: '/v1/teams', headers: auth(admin.token), payload: { name: 'Electrical team' } });
  await app.inject({ method: 'POST', url: '/v1/jobs', headers: auth(admin.token), payload: { name: 'Project Alpha', kind: 'project' } });
  const cable = await seedConsumable(app, admin.token, 10);
  await post(app, admin.token, '/v1/checkouts', { itemId: cable, quantity: 3, holder: holder(john) });
  await post(app, admin.token, '/v1/checkins', { itemId: cable, quantity: 1, holder: holder(john) });
  const out = j(await app.inject({ method: 'GET', url: '/v1/outstanding', headers: auth(admin.token) }));
  assert.equal(out.items[0].state, 'partial_return'); assert.equal(out.items[0].quantity, 2); assert.equal(out.items[0].issuedQuantity, 3);
  const hs = j(await app.inject({ method: 'GET', url: '/v1/holders?q=o', headers: auth(admin.token) }));
  assert.deepEqual([...new Set(hs.items.map((h: any) => h.type))].sort(), ['job', 'person', 'team']);
  assert.equal(hs.items.find((h: any) => h.name === 'John Okafor').outstandingLines, 1);
  const feed = j(await app.inject({ method: 'GET', url: '/v1/activity', headers: auth(admin.token) }));
  assert.equal(feed.items[0].type, 'checkin'); assert.equal(feed.items[0].holder.name, 'John Okafor'); assert.ok(feed.items[0].actor.name);
});
