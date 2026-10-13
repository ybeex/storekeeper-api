import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetDb, seedOrg, seedPerson, seedAsset, seedConsumable, post, holder, stockOf, newKey, auth, type App } from './helpers.js';

let app: App; let org: Awaited<ReturnType<typeof seedOrg>>; let john: string;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); org = await seedOrg(app); john = await seedPerson(app, org.token); });

test('20 simultaneous checkouts of ONE asset: exactly one wins, the rest get ITEM_NOT_AVAILABLE', async () => {
  const asset = await seedAsset(app, org.token);
  const results = await Promise.all(Array.from({ length: 20 }, () => post(app, org.token, '/v1/checkouts', { itemId: asset, holder: holder(john) })));
  assert.equal(results.filter((r) => r.statusCode === 201).length, 1);
  const losers = results.filter((r) => r.statusCode === 409);
  assert.equal(losers.length, 19);
  assert.ok(losers.every((r) => r.json().error.code === 'ITEM_NOT_AVAILABLE'));
});

test('15 checkouts of 1 unit against stock of 10: stock ends at exactly 0, never negative', async () => {
  const gloves = await seedConsumable(app, org.token, 10);
  const results = await Promise.all(Array.from({ length: 15 }, () => post(app, org.token, '/v1/checkouts', { itemId: gloves, quantity: 1, holder: holder(john) })));
  assert.equal(results.filter((r) => r.statusCode === 201).length, 10);
  assert.equal(results.filter((r) => r.statusCode === 409 && r.json().error.code === 'INSUFFICIENT_STOCK').length, 5);
  assert.equal(await stockOf(app, org.token, gloves), 0);
});

test('same Idempotency-Key sent 10x concurrently decrements stock ONCE and every caller sees the same transaction', async () => {
  const gloves = await seedConsumable(app, org.token, 10);
  const key = newKey();
  const results = await Promise.all(Array.from({ length: 10 }, () => post(app, org.token, '/v1/checkouts', { itemId: gloves, quantity: 3, holder: holder(john) }, key)));
  assert.ok(results.every((r) => [200, 201].includes(r.statusCode)), results.map((r) => r.body).join('\n'));
  assert.equal(new Set(results.map((r) => r.json().transaction.id)).size, 1);
  assert.equal(await stockOf(app, org.token, gloves), 7);
});

test('an Idempotency-Key reused for a DIFFERENT item is rejected, not silently replayed', async () => {
  const a = await seedConsumable(app, org.token, 10); const b = await seedConsumable(app, org.token, 10);
  const key = newKey();
  assert.equal((await post(app, org.token, '/v1/checkouts', { itemId: a, quantity: 1, holder: holder(john) }, key)).statusCode, 201);
  const r = await post(app, org.token, '/v1/checkouts', { itemId: b, quantity: 1, holder: holder(john) }, key);
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'IDEMPOTENCY_KEY_REUSED');
});

test('batch checkout is all-or-nothing and names the failing line', async () => {
  const ok = await seedConsumable(app, org.token, 10); const scarce = await seedConsumable(app, org.token, 1);
  const r = await post(app, org.token, '/v1/checkouts/batch', { holder: holder(john), lines: [{ itemId: ok, quantity: 2 }, { itemId: scarce, quantity: 5 }] });
  assert.equal(r.statusCode, 409);
  assert.equal(await stockOf(app, org.token, ok), 10, 'first line must have rolled back');
});

test('a viewer cannot check anything out', async () => {
  const { seedUser } = await import('./helpers.js');
  const viewer = await seedUser(app, org, 'viewer');
  const asset = await seedAsset(app, org.token);
  assert.equal((await post(app, viewer.token, '/v1/checkouts', { itemId: asset, holder: holder(john) })).statusCode, 403);
});

test('return flow: asset goes back to available (or under_repair when flagged for inspection)', async () => {
  const asset = await seedAsset(app, org.token);
  await post(app, org.token, '/v1/checkouts', { itemId: asset, holder: holder(john) });
  const back = await post(app, org.token, '/v1/checkins', { itemId: asset, condition: 'needs_inspection' });
  assert.equal(back.statusCode, 201);
  const item = (await app.inject({ method: 'GET', url: `/v1/items/${asset}`, headers: auth(org.token) })).json();
  assert.equal(item.assetStatus, 'under_repair'); assert.equal(item.holder, null);
});
