import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { testApp, resetDb, seedOrg, seedUser, post, auth, uniq, type App } from './helpers.js';
import { db } from '../src/db/index.js';

let app: App; let admin: Awaited<ReturnType<typeof seedOrg>>; let email: string;
const PASSWORD = 'correct-horse-battery-staple';
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); admin = await seedOrg(app); email = (await get(admin.token, '/v1/auth/me')).json().email; });
const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });
const create = (token: string, organizationName: string) => app.inject({ method: 'POST', url: '/v1/account/organizations', headers: auth(token), payload: { organizationName } });
const switchTo = (token: string, orgId: string) => app.inject({ method: 'POST', url: '/v1/auth/switch-org', headers: auth(token), payload: { orgId } });

test('the organisations page and everything behind it is for admins only', async () => {
  const staff = await seedUser(app, admin, 'store_staff'); const sup = await seedUser(app, admin, 'supervisor'); const viewer = await seedUser(app, admin, 'viewer');
  for (const t of [staff.token, sup.token, viewer.token]) {
    assert.equal((await get(t, '/v1/account/overview')).statusCode, 403);
    assert.equal((await get(t, '/v1/account/organizations')).statusCode, 403);
    assert.equal((await create(t, 'Sneaky Co')).statusCode, 403);
    assert.equal((await switchTo(t, admin.orgId)).statusCode, 403);
  }
  const o = (await get(admin.token, '/v1/account/overview')).json();
  assert.equal(o.organizations.length, 1); assert.equal(o.organizations[0].current, true); assert.equal(o.organizations[0].members, 4);
});

test('an admin creates a second organisation under the same login, switches between them, and the data stays apart', async () => {
  const made = await create(admin.token, 'Provisions Depot'); assert.equal(made.statusCode, 201);
  const second = made.json();
  // creating one does not move you: you are still in the first
  assert.equal((await get(admin.token, '/v1/auth/me')).json().orgId, admin.orgId);
  const o = (await get(admin.token, '/v1/account/overview')).json();
  assert.deepEqual(o.organizations.map((x: any) => x.name).length, 2);
  assert.equal(o.organizations.find((x: any) => x.id === second.id).current, false);

  const sw = await switchTo(admin.token, second.id); assert.equal(sw.statusCode, 200);
  const t2 = sw.json().token as string;
  const me2 = (await get(t2, '/v1/auth/me')).json();
  assert.equal(me2.orgId, second.id); assert.equal(me2.role, 'admin'); assert.equal(me2.email, email); assert.equal(me2.orgName, 'Provisions Depot');
  assert.equal((await get(admin.token, '/v1/auth/me')).statusCode, 401, 'the old session ends when you switch');

  // a shelf made in the second organisation is invisible from the first
  assert.equal((await app.inject({ method: 'POST', url: '/v1/shelves', headers: auth(t2), payload: { name: 'Garri wall' } })).statusCode, 201);
  const back = (await switchTo(t2, admin.orgId)).json().token as string;
  assert.equal((await get(back, '/v1/auth/me')).json().orgId, admin.orgId);
  assert.equal((await get(back, '/v1/shelves')).json().items.some((s: any) => s.name === 'Garri wall'), false);
  const both = (await get(back, '/v1/account/organizations')).json().items; assert.equal(both.length, 2); assert.equal(both.filter((x: any) => x.current).length, 1);
});

test('you can only switch into organisations that are really yours; an unverified email match grants nothing', async () => {
  const stranger = await seedOrg(app);
  assert.equal((await switchTo(admin.token, stranger.orgId)).statusCode, 404);
  // someone registers a separate organisation using MY email: it is a different, unlinked login and must not be reachable from mine
  const imposter = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { organizationName: uniq('Imposter'), email, password: 'another-long-passphrase-123' } });
  assert.equal(imposter.statusCode, 201);
  assert.equal((await switchTo(admin.token, imposter.json().orgId)).statusCode, 404);
  assert.equal((await switchTo(imposter.json().token, admin.orgId)).statusCode, 404);
  assert.equal((await get(admin.token, '/v1/account/organizations')).json().items.length, 1);
});

test('one password for all of an admin\'s organisations: changing it in one changes it in all and signs everything out', async () => {
  const second = (await create(admin.token, 'Second Store')).json();
  const slug2 = second.slug as string;
  const ch = await post(app, admin.token, '/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'a-brand-new-long-passphrase-9' });
  assert.equal(ch.statusCode, 200);
  const login = (org: string, password: string) => app.inject({ method: 'POST', url: '/v1/auth/login', payload: { organization: org, email, password } });
  assert.equal((await login(slug2, 'a-brand-new-long-passphrase-9')).statusCode, 200);
  assert.equal((await login(slug2, PASSWORD)).statusCode, 401);
  assert.equal((await login(admin.slug, 'a-brand-new-long-passphrase-9')).statusCode, 200);
});

test('invited people work in one organisation only: no account link, and an address already working elsewhere cannot be invited or accept', async () => {
  const other = await seedOrg(app); const otherEmail = (await get(other.token, '/v1/auth/me')).json().email;
  // sending: refused
  const inv = await post(app, admin.token, '/v1/users/invites', { email: otherEmail, role: 'store_staff' });
  assert.equal(inv.statusCode, 409); assert.equal(inv.json().error.code, 'EMAIL_IN_ANOTHER_ORG');
  // accepting: an invite sent while the address was free is refused if the address has since joined another organisation
  const lateEmail = `late-${uniq()}@example.com`;
  const sent = await post(app, admin.token, '/v1/users/invites', { email: lateEmail, role: 'store_staff' }); assert.equal(sent.statusCode, 201);
  await db.execute(sql`insert into users (org_id, email, password_hash, role) values (${other.orgId}::uuid, ${lateEmail}, 'x', 'store_staff')`);
  const acc = await app.inject({ method: 'POST', url: '/v1/auth/accept-invite', payload: { token: sent.json().devToken, password: 'another-long-passphrase-123' } });
  assert.equal(acc.statusCode, 409);
  // an ordinary invited user has no account link and so can never be offered a second organisation
  await seedUser(app, admin, 'supervisor');
  const linked = await db.execute(sql`select count(*)::int as n from users where org_id = ${admin.orgId}::uuid and role <> 'admin' and account_id is not null`);
  assert.equal((linked as any)[0].n, 0);
});

test('the organisations page lists invitations still waiting, across all of the admin\'s organisations, and recent alerts', async () => {
  const second = (await create(admin.token, 'Depot 2')).json();
  assert.equal((await post(app, admin.token, '/v1/users/invites', { email: `a-${uniq()}@example.com`, role: 'store_staff' })).statusCode, 201);
  const t2 = (await switchTo(admin.token, second.id)).json().token as string;
  assert.equal((await post(app, t2, '/v1/users/invites', { email: `b-${uniq()}@example.com`, role: 'supervisor' })).statusCode, 201);
  const o = (await get(t2, '/v1/account/overview')).json();
  assert.equal(o.pendingInvites.length, 2); assert.deepEqual(new Set(o.pendingInvites.map((i: any) => i.orgName)).size, 2);
  assert.ok(Array.isArray(o.notifications));
});
