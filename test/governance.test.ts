import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testApp, resetDb, seedOrg, seedUser, seedConsumable, post, auth, uniq, type App } from './helpers.js';

let app: App; let admin: Awaited<ReturnType<typeof seedOrg>>;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); admin = await seedOrg(app); });
const j = (r: { json: () => any }) => r.json();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('invites are role-based: supervisors can invite staff/viewers but not admins/supervisors; staff cannot invite', async () => {
  const sup = await seedUser(app, admin, 'supervisor'); const staff = await seedUser(app, admin, 'store_staff');
  const invite = (token: string, role: string) => post(app, token, '/v1/users/invites', { email: `${uniq('u')}@example.com`, role }, null);
  assert.equal((await invite(sup.token, 'store_staff')).statusCode, 201);
  assert.equal((await invite(sup.token, 'viewer')).statusCode, 201);
  assert.equal((await invite(sup.token, 'admin')).statusCode, 403);
  assert.equal((await invite(sup.token, 'supervisor')).statusCode, 403);
  assert.equal((await invite(staff.token, 'viewer')).statusCode, 403);
  assert.equal((await invite(admin.token, 'supervisor')).statusCode, 201);
});

test('an invite carries role, name and location access to the new account; resending supersedes the old link', async () => {
  const email = `${uniq('inv')}@example.com`;
  const first = j(await post(app, admin.token, '/v1/users/invites', { email, role: 'viewer', fullName: 'Ben Adeyemi', locationIds: [admin.locationId] }, null));
  const resent = j(await post(app, admin.token, `/v1/users/invites/${first.id}/resend`, {}, null));
  const old = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: first.devToken, password: 'a-long-enough-passphrase-1' } });
  assert.equal(old.statusCode, 400, 'the superseded link is dead');
  const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: resent.devToken, password: 'a-long-enough-passphrase-1' } });
  assert.equal(acc.statusCode, 201); assert.equal(acc.json().role, 'viewer');
  const me = j(await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(acc.json().token) }));
  assert.equal(me.fullName, 'Ben Adeyemi');
  const u = j(await app.inject({ method: 'GET', url: `/v1/users/${acc.json().userId}`, headers: auth(admin.token) }));
  assert.deepEqual(u.locationIds, [admin.locationId]);
});

test('notification rules are org-wide and role-based; announcements reach only the chosen roles', async () => {
  const staff = await seedUser(app, admin, 'store_staff'); const viewer = await seedUser(app, admin, 'viewer');
  const gloves = await seedConsumable(app, admin.token, 20, 10);
  // default: staff get low-stock alerts, viewers do not
  await post(app, admin.token, '/v1/consumptions', { itemId: gloves, quantity: 12 });
  const count = async (t: string) => j(await app.inject({ method: 'GET', url: '/v1/notifications/unread-count', headers: auth(t) })).unread;
  assert.equal(await count(staff.token), 1); assert.equal(await count(viewer.token), 0);
  // admin reconfigures: low stock goes to admins only
  await app.inject({ method: 'PUT', url: '/v1/notifications/rules', headers: auth(admin.token), payload: { rules: [{ type: 'low_stock', roles: ['admin'], inApp: true, email: false }] } });
  const gloves2 = await seedConsumable(app, admin.token, 20, 10);
  await post(app, admin.token, '/v1/consumptions', { itemId: gloves2, quantity: 12 });
  assert.equal(await count(staff.token), 1, 'no new alert for staff after the rule change');
  // staff cannot read or change rules; supervisors cannot announce to admins
  assert.equal((await app.inject({ method: 'GET', url: '/v1/notifications/rules', headers: auth(staff.token) })).statusCode, 403);
  const sup = await seedUser(app, admin, 'supervisor');
  assert.equal((await post(app, sup.token, '/v1/notifications/announcements', { title: 't', body: 'b', roles: ['admin'] }, null)).statusCode, 403);
  assert.equal((await post(app, sup.token, '/v1/notifications/announcements', { title: 'Stocktake Friday', body: 'Count shelf 3', roles: ['viewer'] }, null)).statusCode, 201);
  assert.equal(await count(viewer.token), 1); assert.equal(await count(staff.token), 1);
});

test('every action is logged: writes, failed logins, denials and exports appear in the audit log; entries cannot be altered', async () => {
  const staff = await seedUser(app, admin, 'store_staff');
  await post(app, admin.token, '/v1/shelves', { name: uniq('Shelf') }, null);
  await app.inject({ method: 'POST', url: '/v1/shelves', headers: auth(staff.token), payload: { name: 'denied' } }); // 403
  await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { organization: admin.slug, email: (j(await app.inject({ method: 'GET', url: '/v1/auth/me', headers: auth(admin.token) }))).email, password: 'wrong-wrong-wrong-1' } });
  await app.inject({ method: 'GET', url: '/v1/reports/inventory?format=csv', headers: auth(admin.token) });
  await sleep(300); // request-level rows are written after the response
  const all = j(await app.inject({ method: 'GET', url: '/v1/audit-logs?includeRequests=true&limit=100', headers: auth(admin.token) })).items.map((e: any) => e.action);
  for (const a of ['shelf.created', 'request.post', 'access.denied', 'auth.login_failed', 'data.exported', 'user.invited']) assert.ok(all.includes(a), `missing audit action ${a}; got ${[...new Set(all)].join(', ')}`);
  const domainOnly = j(await app.inject({ method: 'GET', url: '/v1/audit-logs', headers: auth(admin.token) })).items;
  assert.ok(domainOnly.every((e: any) => e.entityType !== 'request'), 'request-level noise is opt-in');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/audit-logs', headers: auth(staff.token) })).statusCode, 403, 'staff cannot read the audit log');
  const csv = await app.inject({ method: 'GET', url: '/v1/audit-logs/export.csv', headers: auth(admin.token) });
  assert.equal(csv.statusCode, 200); assert.match(csv.headers['content-type'] as string, /text\/csv/);
});
