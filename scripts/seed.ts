/**
 * Demo data for UI development: a realistic tool crib driven entirely through the public API (so it exercises
 * the same validation, ledger and approval paths as real use). Refuses to run in production.
 *
 *   npm run seed            # creates a fresh organisation each run; prints logins
 */
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';

if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed a production database.'); process.exit(1); }
process.env.JOBS_MODE ??= 'inline';

const PASSWORD = 'demo-passphrase-2026';
const run = Math.random().toString(36).slice(2, 6);

async function main() {
  const app = await buildApp(); await app.ready();
  type Json = Record<string, any>;
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, token: string | null, payload?: unknown): Promise<Json> => {
    const res = await app.inject({ method, url, payload: payload as object, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'idempotency-key': randomUUID() } });
    if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
    return res.body ? res.json() : {};
  };

  // Organisation + admin
  const reg = await call('POST', '/v1/auth/register', null, { organizationName: `Demo Crib ${run}`, fullName: 'Ada Admin', email: `ada.${run}@demo.storekeeper.test`, password: PASSWORD, firstLocationName: 'Main crib' });
  const admin = reg.token as string;
  await call('PATCH', '/v1/organization/settings', admin, { timezone: 'Africa/Lagos' });

  // Team: one of each role, through the real invite flow
  const logins: Array<[string, string]> = [[`ada.${run}@demo.storekeeper.test`, 'admin']];
  const addUser = async (name: string, role: string, handle: string) => {
    const email = `${handle}.${run}@demo.storekeeper.test`;
    const inv = await call('POST', '/v1/users/invites', admin, { email, role, fullName: name });
    const acc = await call('POST', '/v1/auth/accept-invite', null, { token: inv.devToken, password: PASSWORD });
    logins.push([email, role]); return acc.token as string;
  };
  const sup = await addUser('Sam Supervisor', 'supervisor', 'sam');
  const staff = await addUser('Ben Storekeeper', 'store_staff', 'ben');
  await addUser('Vera Viewer', 'viewer', 'vera');

  // Hierarchy: shelf -> category -> item
  const shelf = async (name: string) => (await call('POST', '/v1/shelves', admin, { name })).id as string;
  const cat = async (shelfId: string, name: string, extra: Json = {}) => (await call('POST', '/v1/categories', admin, { shelfId, name, ...extra })).id as string;
  const [safetyWall, toolsRack, fixingsBay] = [await shelf('Safety wall'), await shelf('Power tools rack'), await shelf('Fixings bay')];
  const [gloves, headgear, drills, grinders, gens, cables, bolts, ties] = [
    await cat(safetyWall, 'Gloves', { defaultMinThreshold: 50 }), await cat(safetyWall, 'Helmets and eyewear'),
    await cat(toolsRack, 'Drills', { defaultExpectedReturnHours: 48 }), await cat(toolsRack, 'Grinders', { defaultExpectedReturnHours: 48 }), await cat(toolsRack, 'Generators'),
    await cat(toolsRack, 'Extension cables', { defaultExpectedReturnHours: 72 }), await cat(fixingsBay, 'Bolts and screws'), await cat(fixingsBay, 'Cable ties'),
  ];
  const asset = async (categoryId: string, sku: string, name: string) => (await call('POST', '/v1/items', admin, { type: 'asset', categoryId, sku, name, assetTag: sku })).id as string;
  const stock = async (categoryId: string, sku: string, name: string, unit: string, openingQuantity: number, extra: Json = {}) => (await call('POST', '/v1/items', admin, { type: 'consumable', categoryId, sku, name, unit, openingQuantity, ...extra })).id as string;
  const d41 = await asset(drills, 'DRL-0041', 'Makita drill'); const d42 = await asset(drills, 'DRL-0042', 'Makita drill'); await asset(drills, 'DRL-0043', 'Makita drill');
  const g11 = await asset(grinders, 'GRD-0011', 'Angle grinder'); const g12 = await asset(grinders, 'GRD-0012', 'Angle grinder'); await asset(grinders, 'GRD-0013', 'Angle grinder');
  const gen4 = await asset(gens, 'GEN-04', 'Generator 5kVA'); await asset(gens, 'GEN-12', 'Generator 5kVA');
  const gl = await stock(gloves, 'GLV-100', 'Safety gloves', 'pairs', 37, { minThreshold: 50, reorderQuantity: 200 }); // already low
  await stock(headgear, 'HLM-200', 'Hard hat', 'pcs', 60, { minThreshold: 20 });
  const cable = await stock(cables, 'EXT-30', 'Extension cable 30m', 'pcs', 10);
  await stock(bolts, 'BLT-M8', 'M8 bolt', 'pcs', 137, { minThreshold: 50 }); await stock(ties, 'TIE-300', 'Cable ties 300mm', 'pcs', 400, { minThreshold: 100 });

  // Holders
  const person = async (fullName: string, employeeCode: string) => (await call('POST', '/v1/people', admin, { fullName, employeeCode })).id as string;
  const john = await person('John Okafor', 'W-014'); const mary = await person('Mary Eze', 'W-021'); await person('Tunde Bello', 'W-033'); await person('Grace Obi', 'W-040');
  const elec = (await call('POST', '/v1/teams', admin, { name: 'Electrical team' })).id as string;
  const alpha = (await call('POST', '/v1/jobs', admin, { name: 'Project Alpha', code: 'ALPHA', kind: 'project' })).id as string;

  // Activity: overdue, partial return, damaged return, low stock, loss awaiting approval, a count
  const past = new Date(Date.now() - 3 * 86_400_000).toISOString();
  await call('POST', '/v1/checkouts', staff, { itemId: d42, holder: { type: 'person', id: john }, jobId: alpha, purpose: 'Concrete works', expectedReturnAt: past }); // overdue
  await call('POST', '/v1/checkouts', staff, { itemId: g12, holder: { type: 'team', id: elec }, jobId: alpha });
  await call('POST', '/v1/checkouts', staff, { itemId: cable, quantity: 3, holder: { type: 'team', id: elec } });
  await call('POST', '/v1/checkins', staff, { itemId: cable, quantity: 1, holder: { type: 'team', id: elec } });             // partial return
  await call('POST', '/v1/checkouts', staff, { itemId: gen4, holder: { type: 'person', id: mary }, jobId: alpha });             // on time
  await call('POST', '/v1/checkouts', staff, { itemId: d41, holder: { type: 'person', id: mary } });
  await call('POST', '/v1/checkins', staff, { itemId: d41, condition: 'needs_inspection', note: 'Chuck wobbles' });             // under repair
  await call('POST', '/v1/consumptions', staff, { itemId: gl, quantity: 12, jobId: alpha, purpose: 'Block work' });
  await call('POST', '/v1/losses', staff, { itemId: g11, reason: 'Not returned from site B' });                                 // queued for approval
  const sess = await call('POST', '/v1/reconciliation-sessions', sup, { scope: 'shelf', scopeId: safetyWall });
  await call('POST', `/v1/reconciliation-sessions/${sess.id}/counts`, sup, { itemId: gl, physicalQuantity: 22, reason: 'Unrecorded consumption' });
  await call('POST', '/v1/notifications/announcements', admin, { title: 'Stock count Friday', body: 'Shelf counts start at 8am.', roles: ['store_staff', 'supervisor'] });

  console.log(`\nSeeded "Demo Crib ${run}". Organisation slug: ${reg.organizationSlug}\nPassword for every account: ${PASSWORD}\n`);
  for (const [email, role] of logins) console.log(`  ${role.padEnd(12)} ${email}`);
  console.log('');
  await app.close(); process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
