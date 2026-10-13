import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { checkIntegrity } from '../src/modules/ops/jobs.js';
import { testApp, resetDb, seedOrg, seedPerson, seedConsumable, seedAsset, post, holder, auth, newKey, type App } from './helpers.js';

let app: App; let org: Awaited<ReturnType<typeof seedOrg>>; let john: string;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); org = await seedOrg(app); john = await seedPerson(app, org.token); });

test('the database refuses to UPDATE or DELETE ledger rows, even for a direct SQL writer', async () => {
  const gloves = await seedConsumable(app, org.token, 5);
  await assert.rejects(db.execute(sql`update transactions set quantity = 999 where item_id = ${gloves}`), /append-only/);
  await assert.rejects(db.execute(sql`delete from transactions where item_id = ${gloves}`), /append-only/);
  await assert.rejects(db.execute(sql`update audit_events set action = 'x'`), /append-only/);
});

test('after a mixed workload the read models still equal the ledger (zero integrity discrepancies)', async () => {
  const gloves = await seedConsumable(app, org.token, 100); const drill = await seedAsset(app, org.token);
  await Promise.all([
    ...Array.from({ length: 10 }, () => post(app, org.token, '/v1/checkouts', { itemId: gloves, quantity: 3, holder: holder(john) })),
    ...Array.from({ length: 5 }, () => post(app, org.token, '/v1/consumptions', { itemId: gloves, quantity: 2 })),
    post(app, org.token, '/v1/checkouts', { itemId: drill, holder: holder(john) }),
  ]);
  await post(app, org.token, '/v1/checkins', { itemId: gloves, quantity: 10, holder: holder(john) });
  await post(app, org.token, '/v1/restocks', { itemId: gloves, quantity: 7 });
  await post(app, org.token, '/v1/losses', { itemId: gloves, quantity: 4, holder: holder(john), reason: 'left at site' });
  const r = await checkIntegrity(db);
  assert.deepEqual(r, { stock: 0, custody: 0 });
});

test('a correction reverses a transaction exactly once, and history is untouched', async () => {
  const gloves = await seedConsumable(app, org.token, 20);
  const c = (await post(app, org.token, '/v1/consumptions', { itemId: gloves, quantity: 6 })).json().transaction.id;
  const fix = await post(app, org.token, `/v1/transactions/${c}/corrections`, { note: 'entered by mistake' });
  assert.equal(fix.statusCode, 201);
  const again = await post(app, org.token, `/v1/transactions/${c}/corrections`, { note: 'again' });
  assert.equal(again.statusCode, 409); assert.equal(again.json().error.code, 'ALREADY_CORRECTED');
  const item = (await app.inject({ method: 'GET', url: `/v1/items/${gloves}`, headers: auth(org.token) })).json();
  assert.equal(item.quantityAvailable, 20);
  const tl = (await app.inject({ method: 'GET', url: `/v1/items/${gloves}/timeline`, headers: auth(org.token) })).json();
  assert.equal(tl.items.filter((t: { type: string }) => t.type === 'consume').length, 1, 'the original row is still there');
  void newKey;
});
