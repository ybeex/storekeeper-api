import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetDb, seedOrg, seedPerson, seedAsset, seedConsumable, post, holder, auth, stockOf, type App } from './helpers.js';

let app: App; let org: Awaited<ReturnType<typeof seedOrg>>; let john: string; let mary: string;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); org = await seedOrg(app); john = await seedPerson(app, org.token); mary = await seedPerson(app, org.token, 'Mary'); });

const batch = (deviceId: string, actions: object[]) => app.inject({ method: 'POST', url: '/v1/sync/batch', headers: auth(org.token), payload: { deviceId, actions } });
const act = (id: string, extra: object) => ({ clientActionId: id, occurredAt: new Date(Date.now() - 3600_000).toISOString(), ...extra });

test('replaying the same offline batch is a no-op; applied once', async () => {
  const gloves = await seedConsumable(app, org.token, 20);
  const actions = [act('client-action-0001', { type: 'checkout', itemId: gloves, quantity: 5, holder: holder(john) })];
  const first = (await batch('device-A', actions)).json(); const second = (await batch('device-A', actions)).json();
  assert.equal(first.results[0].status, 'applied'); assert.equal(second.results[0].status, 'replayed');
  assert.equal(await stockOf(app, org.token, gloves), 15);
});

test('an offline checkout of an asset someone else took meanwhile becomes a CONFLICT for a supervisor; other actions still apply', async () => {
  const drill = await seedAsset(app, org.token); const gloves = await seedConsumable(app, org.token, 20);
  await post(app, org.token, '/v1/checkouts', { itemId: drill, holder: holder(mary) });
  const r = (await batch('device-B', [
    act('client-action-0002', { type: 'checkout', itemId: drill, holder: holder(john) }),
    act('client-action-0003', { type: 'consume', itemId: gloves, quantity: 4 }),
  ])).json();
  assert.equal(r.summary.conflicts, 1); assert.equal(r.summary.applied, 1);
  assert.equal(await stockOf(app, org.token, gloves), 16);
  const open = (await app.inject({ method: 'GET', url: '/v1/sync/conflicts?status=open', headers: auth(org.token) })).json();
  assert.equal(open.items.length, 1); assert.match(open.items[0].reason, /ITEM_NOT_AVAILABLE/);
  const keep = await app.inject({ method: 'POST', url: `/v1/sync/conflicts/${open.items[0].id}/resolve`, headers: auth(org.token), payload: { resolution: 'keep_server', note: 'Mary has it' } });
  assert.equal(keep.statusCode, 200);
});

test('a device clock set to the future is clamped; the claim is preserved in metadata', async () => {
  const gloves = await seedConsumable(app, org.token, 5);
  const r = (await batch('device-C', [{ clientActionId: 'client-action-0004', type: 'consume', itemId: gloves, quantity: 1, occurredAt: new Date(Date.now() + 5 * 86_400_000).toISOString() }])).json();
  assert.equal(r.results[0].status, 'applied');
  const tx = (await app.inject({ method: 'GET', url: `/v1/transactions/${r.results[0].transactionId}`, headers: auth(org.token) })).json();
  assert.ok(Date.parse(tx.occurredAt) <= Date.now() + 1000);
  assert.equal(tx.metadata.occurredAtAdjusted, true); assert.equal(tx.source, 'offline_sync');
});
