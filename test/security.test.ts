import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetDb, seedOrg, seedUser, seedConsumable, auth, uniq, post, type App } from './helpers.js';

let app: App;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); });

const PUBLIC = new Set(['/healthz', '/readyz', '/metrics', '/v1/auth/register', '/v1/auth/login', '/v1/auth/forgot-password', '/v1/auth/reset-password', '/v1/auth/accept-invite', '/docs']);

test('RBAC coverage: every non-public route rejects an unauthenticated caller with 401', async () => {
  const table = (app as unknown as { routeTable: Array<{ method: string | string[]; url: string }> }).routeTable;
  assert.ok(table.length > 80, `expected the full route table, got ${table.length}`);
  const seen = new Set<string>();
  for (const r of table) {
    for (const m of Array.isArray(r.method) ? r.method : [r.method]) {
      if (m === 'HEAD' || m === 'OPTIONS') continue;
      const key = `${m} ${r.url}`; if (seen.has(key)) continue; seen.add(key);
      if (PUBLIC.has(r.url) || r.url.startsWith('/docs')) continue;
      const res = await app.inject({ method: m as 'GET', url: r.url.replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000') });
      assert.equal(res.statusCode, 401, `${key} must require authentication (got ${res.statusCode})`);
    }
  }
});

test('explicit probes: representative protected routes are 401 without a token and 401 with a garbage token', async () => {
  for (const [m, u] of [['GET', '/v1/items'], ['POST', '/v1/checkouts'], ['GET', '/v1/transactions'], ['GET', '/v1/reports/inventory'], ['GET', '/v1/analytics/accountability'], ['POST', '/v1/sync/batch'], ['GET', '/v1/notifications']] as const) {
    assert.equal((await app.inject({ method: m, url: u })).statusCode, 401, `${m} ${u}`);
    assert.equal((await app.inject({ method: m, url: u, headers: auth('not-a-real-token') })).statusCode, 401, `${m} ${u} garbage`);
  }
});

test('tenant isolation: org B cannot read or touch org A items, people or transactions (404, never 403/200)', async () => {
  const a = await seedOrg(app); const b = await seedOrg(app);
  const item = await seedConsumable(app, a.token, 5);
  const person = (await app.inject({ method: 'POST', url: '/v1/people', headers: auth(a.token), payload: { fullName: 'A Worker' } })).json().id;
  assert.equal((await app.inject({ method: 'GET', url: `/v1/items/${item}`, headers: auth(b.token) })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/people/${person}`, headers: auth(b.token) })).statusCode, 404);
  assert.equal((await post(app, b.token, '/v1/consumptions', { itemId: item, quantity: 1 })).statusCode, 404);
  const list = (await app.inject({ method: 'GET', url: '/v1/items', headers: auth(b.token) })).json();
  assert.equal(list.items.length, 0);
});

test('login: wrong password and unknown user are indistinguishable; repeated failures lock the account', async () => {
  const org = await seedOrg(app);
  const me = (await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(org.token) })).json();
  const bad = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { organization: org.slug, email: me.email, password: 'wrong-wrong-wrong' } });
  const ghost = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { organization: org.slug, email: `nobody-${uniq()}@x.com`, password: 'wrong-wrong-wrong' } });
  assert.equal(bad.statusCode, 401); assert.deepEqual(bad.json().error.message, ghost.json().error.message);
  for (let i = 0; i < 9; i++) await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { organization: org.slug, email: me.email, password: 'wrong-wrong-wrong' } });
  const correctButLocked = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { organization: org.slug, email: me.email, password: 'correct-horse-battery-staple' } });
  assert.equal(correctButLocked.statusCode, 401, 'locked accounts reject even the right password');
});

test('deactivating a user cuts off their existing session immediately; the last admin cannot be removed', async () => {
  const admin = await seedOrg(app); const staff = await seedUser(app, admin, 'store_staff');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/items', headers: auth(staff.token) })).statusCode, 200);
  const off = await app.inject({ method: 'PATCH', url: `/v1/users/${staff.userId}`, headers: auth(admin.token), payload: { active: false } });
  assert.equal(off.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/items', headers: auth(staff.token) })).statusCode, 401);
  const second = await seedUser(app, admin, 'admin');
  const self = await app.inject({ method: 'PATCH', url: `/v1/users/${admin.userId}`, headers: auth(second.token), payload: { role: 'viewer' } });
  assert.equal(self.statusCode, 200);
  const last = await app.inject({ method: 'PATCH', url: `/v1/users/${second.userId}`, headers: auth(admin.token), payload: { role: 'viewer' } });
  assert.equal(last.statusCode, 409); assert.equal(last.json().error.code, 'LAST_ADMIN');
});

test('input hardening: unknown fields are rejected and oversized/invalid ids give 400, not 500', async () => {
  const org = await seedOrg(app);
  const extra = await post(app, org.token, '/v1/consumptions', { itemId: '00000000-0000-0000-0000-000000000000', quantity: 1, isAdmin: true });
  assert.equal(extra.statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/items/not-a-uuid', headers: auth(org.token) })).statusCode, 400);
});
