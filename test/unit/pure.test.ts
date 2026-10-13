import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOccurredAt } from '../../src/lib/occurred-at.js';
import { passwordProblems } from '../../src/lib/password.js';
import { validateRows } from '../../src/modules/imports/module.js';
import { sniffImage } from '../../src/modules/files/module.js';
import { holderKey, holderColumns } from '../../src/lib/holders.js';

test('offline timestamps: future clamps to now, ancient clamps to the oldest accepted instant, sane passes through', () => {
  const now = new Date('2026-10-03T12:00:00Z');
  assert.equal(resolveOccurredAt('2026-10-03T11:00:00Z', now).adjusted, false);
  const future = resolveOccurredAt('2026-10-04T12:00:00Z', now);
  assert.equal(future.adjusted, true); assert.equal(future.occurredAt.getTime(), now.getTime());
  const ancient = resolveOccurredAt('2020-01-01T00:00:00Z', now);
  assert.equal(ancient.adjusted, true); assert.ok(ancient.occurredAt.getTime() > Date.parse('2026-09-01'));
  assert.equal(ancient.clientOccurredAt, '2020-01-01T00:00:00Z');
});

test('password policy', () => {
  assert.ok(passwordProblems('short').length > 0);
  assert.ok(passwordProblems('aaaaaaaaaaaaaaaa').length > 0);
  assert.ok(passwordProblems('johnsmith-is-great-1', 'johnsmith@x.com').length > 0);
  assert.deepEqual(passwordProblems('correct-horse-battery-staple', 'a@b.com'), []);
});

test('csv validation reports every problem per row and never throws', () => {
  const rows = [
    { SKU: 'A1', Name: 'Hammer', Kind: 'asset', Qty: '', Cat: 'Hand tools' },
    { SKU: '', Name: '', Kind: 'widget', Qty: '-3', Cat: 'Hand tools' },
    { SKU: 'a1', Name: 'Dup', Kind: 'asset', Qty: '', Cat: 'Hand tools' },
    { SKU: 'G1', Name: 'Gloves', Kind: 'consumable', Qty: '40', Cat: 'Safety' },
    { SKU: 'T1', Name: 'Tool', Kind: 'asset', Qty: '5', Cat: 'Hand tools' },
    { SKU: 'N1', Name: 'No category', Kind: 'asset', Qty: '', Cat: '' },
  ];
  const { valid, errors } = validateRows(rows, { sku: 'SKU', name: 'Name', type: 'Kind', openingQuantity: 'Qty', category: 'Cat' });
  assert.deepEqual(valid.map((v) => v.sku), ['A1', 'G1']);
  const row3 = errors.filter((e) => e.row === 3).map((e) => e.field);
  assert.ok(row3.includes('sku') && row3.includes('name') && row3.includes('type') && row3.includes('openingQuantity'));
  assert.ok(errors.some((e) => e.row === 4 && /Duplicate of row 2/.test(e.message)), 'case-insensitive duplicate within file');
  assert.ok(errors.some((e) => e.row === 6 && /consumables only/.test(e.message)), 'quantity on an asset');
  assert.ok(errors.some((e) => e.row === 7 && e.field === 'category'), 'an item without a category is rejected');
  assert.equal(valid.find((v) => v.sku === 'G1')?.categoryName, 'Safety');
});

test('image sniffing trusts bytes, not names or declared types', () => {
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.ext, 'jpg');
  assert.equal(sniffImage(Buffer.from('<html><script>alert(1)</script>'))?.ext, undefined);
  assert.equal(sniffImage(Buffer.from('MZ\x90\x00exe')), null);
});

test('holder helpers', () => {
  assert.equal(holderKey({ type: 'team', id: 'abc' }), 'team:abc');
  assert.deepEqual(holderColumns({ type: 'job', id: 'j' }), { holderType: 'job', holderPersonId: null, holderTeamId: null, holderJobId: 'j' });
});

import { stockState } from '../../src/modules/items/service.js';
import { DEFAULT_RULES } from '../../src/lib/notify.js';

test('stock state matches the UI kit status language', () => {
  assert.equal(stockState(0, 50), 'out');
  assert.equal(stockState(37, 50), 'low');
  assert.equal(stockState(52, 50), 'near_minimum'); // "52 of 50 · Close to minimum"
  assert.equal(stockState(200, 50), 'ok');
  assert.equal(stockState(10, null), 'ok');
});

test('default notification rules never send admin-only alerts to staff, and every type has a rule', () => {
  assert.deepEqual(DEFAULT_RULES.integrity_alert.roles, ['admin']);
  assert.ok(!DEFAULT_RULES.sync_failure.roles.includes('store_staff'));
  assert.ok(Object.values(DEFAULT_RULES).every((r) => r.roles.length > 0));
});
