import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetDb, seedOrg, seedUser, seedConsumable, seedAsset, post, auth, stockOf, type App } from './helpers.js';

let app: App; let admin: Awaited<ReturnType<typeof seedOrg>>;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); admin = await seedOrg(app); });

test('staff adjustment is queued (202); a supervisor approves it; stock changes only on approval; self-approval is blocked', async () => {
  const staff = await seedUser(app, admin, 'store_staff'); const sup = await seedUser(app, admin, 'supervisor');
  const gloves = await seedConsumable(app, admin.token, 50);
  const q = await post(app, staff.token, '/v1/adjustments', { itemId: gloves, delta: -8, reason: 'count_correction' });
  assert.equal(q.statusCode, 202); assert.equal(q.json().status, 'pending_approval');
  assert.equal(await stockOf(app, admin.token, gloves), 50);

  const self = await app.inject({ method: 'POST', url: `/v1/approvals/${q.json().approvalRequestId}/approve`, headers: auth(staff.token), payload: {} });
  assert.equal(self.statusCode, 403, 'staff cannot review at all');

  const ok = await app.inject({ method: 'POST', url: `/v1/approvals/${q.json().approvalRequestId}/approve`, headers: auth(sup.token), payload: { note: 'confirmed' } });
  assert.equal(ok.statusCode, 200); assert.equal(ok.json().status, 'approved');
  assert.equal(await stockOf(app, admin.token, gloves), 42);

  const twice = await app.inject({ method: 'POST', url: `/v1/approvals/${q.json().approvalRequestId}/approve`, headers: auth(sup.token), payload: {} });
  assert.equal(twice.statusCode, 409);
  assert.equal(await stockOf(app, admin.token, gloves), 42, 'approving twice must not apply twice');
});

test('retirement needs an ADMIN (policy mode=approval); a supervisor requesting it is queued', async () => {
  const sup = await seedUser(app, admin, 'supervisor'); const asset = await seedAsset(app, admin.token);
  const r = await post(app, sup.token, `/v1/items/${asset}/status`, { to: 'retired', note: 'beyond repair' });
  assert.equal(r.statusCode, 202);
  const supReview = await app.inject({ method: 'POST', url: `/v1/approvals/${r.json().approvalRequestId}/approve`, headers: auth(sup.token), payload: {} });
  assert.ok([403, 409].includes(supReview.statusCode));
  const adm = await app.inject({ method: 'POST', url: `/v1/approvals/${r.json().approvalRequestId}/approve`, headers: auth(admin.token), payload: {} });
  assert.equal(adm.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/items/${asset}`, headers: auth(admin.token) })).json().assetStatus, 'retired');
});

test('the large-adjustment threshold lets small corrections through directly', async () => {
  const staff = await seedUser(app, admin, 'store_staff'); const gloves = await seedConsumable(app, admin.token, 50);
  await app.inject({ method: 'PUT', url: '/v1/organization/approval-policies', headers: auth(admin.token), payload: { policies: [{ operation: 'adjustment', mode: 'request', largeThreshold: 10 }] } });
  assert.equal((await post(app, staff.token, '/v1/adjustments', { itemId: gloves, delta: -3, reason: 'count_correction' })).statusCode, 201);
  assert.equal((await post(app, staff.token, '/v1/adjustments', { itemId: gloves, delta: -12, reason: 'count_correction' })).statusCode, 202);
});

test('an approval that can no longer apply is marked failed with a reason, not left pending', async () => {
  const staff = await seedUser(app, admin, 'store_staff'); const gloves = await seedConsumable(app, admin.token, 10);
  const q = await post(app, staff.token, '/v1/adjustments', { itemId: gloves, delta: -8, reason: 'loss' });
  await post(app, admin.token, '/v1/consumptions', { itemId: gloves, quantity: 9 }); // stock now 1
  const r = await app.inject({ method: 'POST', url: `/v1/approvals/${q.json().approvalRequestId}/approve`, headers: auth(admin.token), payload: {} });
  assert.equal(r.statusCode, 409); assert.equal(r.json().error.code, 'APPROVAL_EXECUTION_FAILED');
  const detail = (await app.inject({ method: 'GET', url: `/v1/approvals/${q.json().approvalRequestId}`, headers: auth(admin.token) })).json();
  assert.equal(detail.status, 'failed'); assert.match(detail.failureReason, /INSUFFICIENT_STOCK/);
});
