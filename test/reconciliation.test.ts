import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetDb, seedOrg, seedUser, seedConsumable, post, auth, stockOf, type App } from './helpers.js';

let app: App; let admin: Awaited<ReturnType<typeof seedOrg>>;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); admin = await seedOrg(app); });

test('a count with variance preserves the original system quantity and resolves through the adjustment path', async () => {
  const gloves = await seedConsumable(app, admin.token, 50);
  const s = (await post(app, admin.token, '/v1/reconciliation-sessions', { scope: 'item', scopeId: gloves }, null)).json();
  const noReason = await post(app, admin.token, `/v1/reconciliation-sessions/${s.id}/counts`, { itemId: gloves, physicalQuantity: 44 });
  assert.equal(noReason.statusCode, 400, 'a reason is required for a variance by default');
  const c = await post(app, admin.token, `/v1/reconciliation-sessions/${s.id}/counts`, { itemId: gloves, physicalQuantity: 44, reason: 'damaged in rain' });
  assert.equal(c.statusCode, 201); assert.equal(c.json().count.systemQuantityAtCount, 50); assert.equal(c.json().count.variance, -6);
  assert.equal(c.json().adjustment, 'applied');
  assert.equal(await stockOf(app, admin.token, gloves), 44);
  const detail = (await app.inject({ method: 'GET', url: `/v1/reconciliation-sessions/${s.id}`, headers: auth(admin.token) })).json();
  assert.equal(detail.counts[0].systemQuantityAtCount, 50, 'original system quantity survives the adjustment');
  assert.equal(detail.summary.withVariance, 1);
});

test('when policy gates adjustments, staff variances wait for a supervisor and stock is untouched until then', async () => {
  const staff = await seedUser(app, admin, 'store_staff'); const sup = await seedUser(app, admin, 'supervisor');
  const gloves = await seedConsumable(app, admin.token, 50);
  const s = (await post(app, staff.token, '/v1/reconciliation-sessions', { scope: 'item', scopeId: gloves }, null)).json();
  const c = await post(app, staff.token, `/v1/reconciliation-sessions/${s.id}/counts`, { itemId: gloves, physicalQuantity: 40, reason: 'miscount?' });
  assert.equal(c.json().adjustment, 'pending_approval'); assert.equal(await stockOf(app, admin.token, gloves), 50);
  const ok = await app.inject({ method: 'POST', url: `/v1/approvals/${c.json().approvalRequestId}/approve`, headers: auth(sup.token), payload: {} });
  assert.equal(ok.statusCode, 200); assert.equal(await stockOf(app, admin.token, gloves), 40);
  const detail = (await app.inject({ method: 'GET', url: `/v1/reconciliation-sessions/${s.id}`, headers: auth(admin.token) })).json();
  assert.ok(detail.counts[0].linkedAdjustmentTransactionId, 'count is linked to the resulting adjustment');
});

test('submitting the same count twice (same key) records it once', async () => {
  const gloves = await seedConsumable(app, admin.token, 10);
  const s = (await post(app, admin.token, '/v1/reconciliation-sessions', { scope: 'location' }, null)).json();
  const key = 'count-key-0001';
  const a = await post(app, admin.token, `/v1/reconciliation-sessions/${s.id}/counts`, { itemId: gloves, physicalQuantity: 9, reason: 'x' }, key);
  const b = await post(app, admin.token, `/v1/reconciliation-sessions/${s.id}/counts`, { itemId: gloves, physicalQuantity: 9, reason: 'x' }, key);
  assert.equal(a.json().count.id, b.json().count.id); assert.equal(await stockOf(app, admin.token, gloves), 9);
});
