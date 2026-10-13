import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, sql } from 'drizzle-orm';
import { testApp, resetDb, seedOrg, seedUser, seedPerson, seedAsset, seedConsumable, seedCategory, seedShelf, post, holder, auth, buildMultipartCsv, uniq, type App } from './helpers.js';
import { db } from '../src/db/index.js';
import { importJobs, importRows } from '../src/db/schema.js';
import { commitImport } from '../src/modules/imports/module.js';

let app: App; let admin: Awaited<ReturnType<typeof seedOrg>>;
before(async () => { app = await testApp(); });
after(async () => { await app.close(); });
beforeEach(async () => { await resetDb(); admin = await seedOrg(app); });
const j = (r: { json: () => any }) => r.json();
const get = (token: string, url: string) => app.inject({ method: 'GET', url, headers: auth(token) });

// ── who sees what ───────────────────────────────────────────────────
test('store staff see only their own activity; admins and supervisors see everyone\'s; holders come back by name', async () => {
  const staff = await seedUser(app, admin, 'store_staff');
  const supervisor = await seedUser(app, admin, 'supervisor');
  const ben = await seedPerson(app, admin.token, 'Ben Okoye');
  const drill = await seedAsset(app, admin.token, { name: 'Makita Drill' });
  const gloves = await seedConsumable(app, admin.token, 100);

  assert.equal((await post(app, admin.token, '/v1/checkouts', { itemId: drill, holder: holder(ben) })).statusCode, 201); // by the admin
  assert.equal((await post(app, staff.token, '/v1/consumptions', { itemId: gloves, quantity: 4 })).statusCode, 201);      // by staff
  assert.equal((await post(app, staff.token, '/v1/checkouts', { itemId: gloves, quantity: 2, holder: holder(ben) })).statusCode, 201);

  const mine = j(await get(staff.token, '/v1/transactions'));
  assert.ok(mine.items.length >= 2);
  assert.ok(mine.items.every((t: any) => t.actor.id === staff.userId), 'staff ledger contains only their own entries');
  assert.ok(!mine.items.some((t: any) => t.itemId === drill), "the admin's drill checkout is invisible to staff");

  const everyone = j(await get(supervisor.token, '/v1/transactions'));
  assert.ok(everyone.items.some((t: any) => t.itemId === drill) && everyone.items.some((t: any) => t.actor.id === staff.userId));

  // the holder is shown by NAME, never as a bare database id
  const out = everyone.items.find((t: any) => t.type === 'checkout' && t.itemId === drill);
  assert.equal(out.holder.name, 'Ben Okoye'); assert.equal(out.item.name, 'Makita Drill'); assert.ok(out.actor.name);

  // staff cannot widen the filter, and cannot fetch someone else's entry by id
  const widened = j(await get(staff.token, `/v1/transactions?actorUserId=${admin.userId}`));
  assert.ok(widened.items.every((t: any) => t.actor.id === staff.userId));
  assert.equal((await get(staff.token, `/v1/transactions/${out.id}`)).statusCode, 404);
  assert.equal((await get(admin.token, `/v1/transactions/${out.id}`)).statusCode, 200);

  const feed = j(await get(staff.token, '/v1/activity'));
  assert.ok(feed.items.length >= 2 && feed.items.every((a: any) => a.actor.id === staff.userId));
  const feedAll = j(await get(admin.token, '/v1/activity'));
  assert.ok(feedAll.items.some((a: any) => a.actor.id === admin.userId));

  const tl = j(await get(staff.token, `/v1/items/${drill}/timeline`));
  assert.ok(tl.items.every((e: any) => e.actor.id === staff.userId), "an item's timeline shows staff only their own entries");
  assert.ok(j(await get(admin.token, `/v1/items/${drill}/timeline`)).items.length >= 2);
});

test('the dashboard and its analytics are closed to store staff and open to admin, supervisor and viewer', async () => {
  const staff = await seedUser(app, admin, 'store_staff'); const viewer = await seedUser(app, admin, 'viewer'); const sup = await seedUser(app, admin, 'supervisor');
  for (const url of ['/v1/dashboard', '/v1/dashboard/analytics']) {
    assert.equal((await get(staff.token, url)).statusCode, 403, `${url} for staff`);
    for (const t of [admin.token, viewer.token, sup.token]) assert.equal((await get(t, url)).statusCode, 200, `${url} for non-staff`);
  }
});

test('dashboard analytics: one row per day, totals add up, top consumed and stock health reflect the ledger', async () => {
  const ben = await seedPerson(app, admin.token, 'Ben');
  const gloves = await seedConsumable(app, admin.token, 100, 10); const bolts = await seedConsumable(app, admin.token, 5, 10);
  await post(app, admin.token, '/v1/consumptions', { itemId: gloves, quantity: 30 });
  await post(app, admin.token, '/v1/checkouts', { itemId: gloves, quantity: 5, holder: holder(ben) });
  const a = j(await get(admin.token, '/v1/dashboard/analytics?days=7'));
  assert.equal(a.daily.length, 7);
  const today = a.daily.at(-1);
  assert.equal(today.consumed, 1); assert.equal(today.checkouts, 1);
  assert.equal(a.summary.checkouts, 1); assert.equal(a.summary.accountableRate, 100);
  assert.equal(a.topConsumed[0].units, 35);
  assert.equal(a.stockHealth.low, 1);   // bolts: 5 of minimum 10
  assert.equal(a.stockHealth.ok, 1);    // gloves: 65
  void bolts;
});

test('the notification rules screen has a label and a plain-language description for every alert', async () => {
  const rules = j(await get(admin.token, '/v1/notifications/rules')).rules;
  assert.ok(rules.length >= 9);
  assert.ok(rules.every((r: any) => r.label && r.description && Array.isArray(r.roles)));
});

// ── colours and icons ───────────────────────────────────────────────
test('shelves, categories and items carry a colour and an icon; only palette and icon keys are accepted', async () => {
  const shelf = await app.inject({ method: 'POST', url: '/v1/shelves', headers: auth(admin.token), payload: { name: 'Safety wall', color: 'amber', icon: 'shield' } });
  assert.equal(shelf.statusCode, 201); assert.equal(shelf.json().color, 'amber'); assert.equal(shelf.json().icon, 'shield');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/shelves', headers: auth(admin.token), payload: { name: 'Bad', color: '#ff0000' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/shelves', headers: auth(admin.token), payload: { name: 'Bad2', icon: '<script>' } })).statusCode, 400);

  const cat = await app.inject({ method: 'POST', url: '/v1/categories', headers: auth(admin.token), payload: { shelfId: shelf.json().id, name: 'Gloves', color: 'teal', icon: 'hard-hat' } });
  assert.equal(cat.statusCode, 201); assert.equal(cat.json().color, 'teal');

  const item = await app.inject({ method: 'POST', url: '/v1/items', headers: auth(admin.token), payload: { type: 'consumable', categoryId: cat.json().id, sku: uniq('S'), name: 'Nitrile gloves', openingQuantity: 10, color: 'rose', icon: 'package' } });
  assert.equal(item.statusCode, 201);
  const view = item.json();
  assert.equal(view.color, 'rose'); assert.equal(view.icon, 'package');
  assert.equal(view.categoryColor, 'teal'); assert.equal(view.shelfColor, 'amber'); assert.equal(view.shelfIcon, 'shield'); // the card can fall back through the hierarchy

  const cleared = await app.inject({ method: 'PATCH', url: `/v1/items/${view.id}`, headers: auth(admin.token), payload: { color: null } });
  assert.equal(cleared.statusCode, 200); assert.equal(cleared.json().color, null);
  const list = j(await get(admin.token, `/v1/categories?shelfId=${shelf.json().id}`));
  assert.equal(list.items[0].shelfColor, 'amber');
});

// ── imports ─────────────────────────────────────────────────────────
const csvOf = (n: number, o: { dupAt?: number; badAt?: number } = {}) => {
  const lines = ['SKU,Name,Kind,Shelf,Category,Qty'];
  for (let i = 1; i <= n; i++) {
    const sku = o.dupAt && i === o.dupAt ? 'SKU-1' : `SKU-${i}`;
    const cat = o.badAt && i === o.badAt ? '' : `Cat ${i % 7}`;
    lines.push(`${sku},Item ${i},consumable,Shelf ${i % 3},${cat},${i % 50}`);
  }
  return lines.join('\n');
};
const upload = async (csv: string) => {
  const mp = buildMultipartCsv('big.csv', csv);
  return app.inject({ method: 'POST', url: '/v1/imports', headers: auth(admin.token, { 'content-type': mp.contentType }), payload: mp.body });
};
const MAPPING = { sku: 'SKU', name: 'Name', type: 'Kind', shelf: 'Shelf', category: 'Category', openingQuantity: 'Qty' };
const validate = (id: string) => app.inject({ method: 'POST', url: `/v1/imports/${id}/validate`, headers: auth(admin.token), payload: { mapping: MAPPING, createMissing: true } });
const status = async (id: string) => j(await get(admin.token, `/v1/imports/${id}`));
/** Inline mode runs the import in the background of the process, exactly like a worker would, so wait for it as a client does. */
const untilDone = async (id: string) => {
  for (let i = 0; i < 600; i++) { const s = await status(id); if (['completed', 'failed'].includes(s.status)) return s; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('import did not finish');
};

test('import: a multi-thousand-row file streams into staging, validates with exact counts, commits in chunks and cleans up', async () => {
  const N = 2300; // more than one staging batch (1000) and several commit chunks (500)
  const up = await upload(csvOf(N, { dupAt: 1500, badAt: 77 }));
  assert.equal(up.statusCode, 201);
  const { id, totalRows, headers, preview } = up.json();
  assert.equal(totalRows, N); assert.deepEqual(headers, ['SKU', 'Name', 'Kind', 'Shelf', 'Category', 'Qty']); assert.equal(preview.length, 5);
  const staged = await db.select({ n: sql<number>`count(*)::int` }).from(importRows).where(eq(importRows.importId, id));
  assert.equal(staged[0].n, N, 'every row is staged, none kept in memory or in one JSON blob');

  const v = await validate(id);
  assert.ok([200, 202].includes(v.statusCode));
  let s = await status(id);
  assert.equal(s.status, 'ready'); assert.equal(s.validRows, N - 2); assert.equal(s.invalidRows, 2);
  assert.ok(s.errors.some((e: any) => e.row === 78 && e.field === 'category'), 'row numbers are CSV line numbers (header = 1)');
  assert.ok(s.errors.some((e: any) => e.row === 1501 && /Duplicate of row 2/.test(e.message)), 'a duplicate SKU is caught across chunks');

  const c = await app.inject({ method: 'POST', url: `/v1/imports/${id}/commit`, headers: auth(admin.token) });
  assert.equal(c.statusCode, 202);
  s = await untilDone(id);
  assert.equal(s.status, 'completed'); assert.equal(s.importedRows, N - 2); assert.equal(s.failedRows, 2); assert.equal(s.percent, 100);
  const items = j(await get(admin.token, '/v1/items?limit=100'));
  assert.equal(items.items.length, 100);
  const total = await db.execute(sql`select count(*)::int as n from items`); assert.equal((total as any)[0].n, N - 2);
  const left = await db.select({ n: sql<number>`count(*)::int` }).from(importRows).where(eq(importRows.importId, id));
  assert.equal(left[0].n, 0, 'staged rows are dropped once processed');
  const shelves = j(await get(admin.token, '/v1/shelves')); assert.equal(shelves.items.filter((x: any) => /^Shelf \d$/.test(x.name)).length, 3);

  // importing the same rows again creates nothing new: every SKU that exists is skipped, not failed. The one exception is
  // SKU-77, which was rejected the first time (empty category) and is valid in this file, so exactly that one is created.
  const up2 = await upload(csvOf(300)); const id2 = up2.json().id; await validate(id2);
  await app.inject({ method: 'POST', url: `/v1/imports/${id2}/commit`, headers: auth(admin.token) });
  const s2 = await untilDone(id2);
  assert.equal(s2.status, 'completed'); assert.equal(s2.importedRows, 1); assert.equal(s2.skippedRows, 299); assert.equal(s2.failedRows, 0);
});

test('import: a commit that stopped part-way resumes from its checkpoint instead of starting over', async () => {
  const N = 1200;
  const { id } = (await upload(csvOf(N))).json(); await validate(id);
  // Simulate a worker that died after committing the first 500 rows: those items exist, the checkpoint says 500.
  await commitImport(db, id).catch(() => undefined);              // not queued yet: must be a no-op
  assert.equal((await status(id)).status, 'ready');
  await app.inject({ method: 'POST', url: `/v1/imports/${id}/commit`, headers: auth(admin.token) });
  const full = await untilDone(id); assert.equal(full.importedRows, N);
  // second job: import the first 500 for real, then hand the rest to a "retry" with the checkpoint in place
  const { id: id2 } = (await upload(csvOf(N).replace(/SKU-/g, 'R-'))).json(); await validate(id2);
  await db.update(importJobs).set({ status: 'queued', processedRows: 0, importedRows: 0 }).where(eq(importJobs.id, id2));
  await db.delete(importRows).where(sql`${importRows.importId} = ${id2} and ${importRows.rowNo} > 500`); // only the first 500 remain to process
  await commitImport(db, id2);
  const half = await status(id2); assert.equal(half.status, 'completed'); assert.equal(half.importedRows, 500);
  // now a mid-run checkpoint: pointer at 300 of 500 staged rows, counters carried over
  const { id: id3 } = (await upload(csvOf(600).replace(/SKU-/g, 'Q-'))).json(); await validate(id3);
  await db.update(importJobs).set({ status: 'committing', processedRows: 400, importedRows: 400, skippedRows: 0, failedRows: 0 }).where(eq(importJobs.id, id3));
  await commitImport(db, id3);
  const resumed = await status(id3);
  assert.equal(resumed.status, 'completed'); assert.equal(resumed.importedRows, 600, 'checkpointed 400 + the 200 that remained');
  const created = await db.execute(sql`select count(*)::int as n from items where sku like 'Q-%'`);
  assert.equal((created as any)[0].n, 200, 'only the rows after the checkpoint were imported this time');
});

test('import: oversized or malformed files are rejected cleanly and leave nothing behind; an upload can be discarded', async () => {
  const empty = await upload('SKU,Name,Kind,Shelf,Category,Qty'); assert.equal(empty.statusCode, 400);
  const ragged = await upload('SKU,Name\nA,B,C'); assert.equal(ragged.statusCode, 400);
  const jobs = await db.execute(sql`select count(*)::int as n from import_jobs`); assert.equal((jobs as any)[0].n, 0, 'a rejected upload leaves no job or staged rows');
  const ok = (await upload(csvOf(10))).json();
  assert.equal((await app.inject({ method: 'DELETE', url: `/v1/imports/${ok.id}`, headers: auth(admin.token) })).statusCode, 204);
  assert.equal((await get(admin.token, `/v1/imports/${ok.id}`)).statusCode, 404);
  const staged = await db.execute(sql`select count(*)::int as n from import_rows`); assert.equal((staged as any)[0].n, 0);
  // only an admin may import
  const staff = await seedUser(app, admin, 'store_staff');
  const mp = buildMultipartCsv('x.csv', csvOf(3));
  assert.equal((await app.inject({ method: 'POST', url: '/v1/imports', headers: auth(staff.token, { 'content-type': mp.contentType }), payload: mp.body })).statusCode, 403);
  void seedCategory; void seedShelf;
});
