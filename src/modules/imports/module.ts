import type { ApiFastifyInstance } from '../../types.js';
/**
 * CSV import (PRD §22): upload → map columns → validate → commit.
 *
 * Built for big files. The upload is STREAMED through the CSV parser into the `import_rows` staging table in batches,
 * so memory stays flat whether the file has 500 rows or 200,000. Validation and commit both page through the staged
 * rows in chunks, report progress as they go, and keep a checkpoint, so a crash or a retry resumes where it stopped
 * instead of starting over. Validation and commit run in the worker; the request that starts them returns at once and
 * the browser polls GET /imports/:id.
 *
 * The parse + validation core is pure (`validateRows` / `validateRecords`) so it is unit-testable without a database.
 */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { parse } from 'csv-parse';
import { pipeline, type Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/index.js';
import { importJobs, importRows, items, categories, shelves, users } from '../../db/schema.js';
import { db as rootDb } from '../../db/index.js';
import { requireRole } from '../../plugins/rbac.js';
import { env } from '../../env.js';
import { ConflictError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { isUniqueViolation } from '../../lib/db-errors.js';
import { audit } from '../../lib/audit.js';
import { enqueue, registerJob } from '../../lib/jobs.js';
import { IdParams, Uuid } from '../../lib/schemas.js';
import { AppError } from '../../lib/errors.js';
import { createItemInTx } from '../items/service.js';

const FIELDS = ['sku', 'name', 'type', 'shelf', 'category', 'assetTag', 'description', 'openingQuantity', 'unit', 'minThreshold', 'reorderQuantity', 'expectedReturnHours', 'qrCode'] as const;
type Field = typeof FIELDS[number];
export type Mapping = Partial<Record<Field, string>>;
export interface RowError { row: number; field: string; message: string }
export interface ParsedItem {
  row: number; type: 'asset' | 'consumable'; sku: string; name: string; shelfName?: string; categoryName: string; assetTag?: string; description?: string;
  openingQuantity?: number; unit?: string; minThreshold?: number; reorderQuantity?: number; expectedReturnHours?: number; qrCode?: string;
}
interface ImportOptions { mapping: Mapping; defaultType?: 'asset' | 'consumable'; defaultShelfId?: string; createMissing?: boolean }

const MAX_ERRORS_KEPT = 5000; // the report is capped; the counts stay exact
const STAGE_BATCH = 1000;     // rows per INSERT while staging an upload
const VALIDATE_CHUNK = 2000;  // rows read per step while validating

const Body = Type.Object({
  mapping: Type.Record(Type.String(), Type.String({ maxLength: 200 })),
  defaultType: Type.Optional(Type.Union([Type.Literal('asset'), Type.Literal('consumable')])),
  /** Shelf for rows without a shelf column. Required unless the location has exactly one shelf. */
  defaultShelfId: Type.Optional(Uuid),
  /** Create shelves/categories that don't exist yet (otherwise such rows fail with a clear message). */
  createMissing: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const intField = (raw: string | undefined, field: string, row: number, errs: RowError[], min = 0): number | undefined => {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) < min || Number(raw) > 100_000_000) { errs.push({ row, field, message: `${field} must be a whole number ≥ ${min}` }); return undefined; }
  return Number(raw);
};

/** Carried between chunks so a SKU repeated anywhere in the file is caught, not just within one chunk. */
export interface ValidationState { seenSku: Map<string, number> }
export const newValidationState = (): ValidationState => ({ seenSku: new Map() });

/**
 * Pure: apply a column mapping to a slice of records. `row` is the CSV line number (header = line 1, so the first data
 * row is 2). Collects EVERY problem per row (IMP-02), never throws on bad data.
 */
export function validateRecords(entries: Array<{ row: number; rec: Record<string, string> }>, mapping: Mapping, defaultType: 'asset' | 'consumable' | undefined, state: ValidationState): { valid: ParsedItem[]; errors: RowError[] } {
  const valid: ParsedItem[] = []; const errors: RowError[] = [];
  for (const { row, rec } of entries) {
    const get = (f: Field) => { const col = mapping[f]; const v = col ? rec[col]?.trim() : undefined; return v === '' ? undefined : v; };
    const before = errors.length;
    const sku = get('sku'); const name = get('name'); const categoryName = get('category');
    if (!categoryName) errors.push({ row, field: 'category', message: 'Category is required (every item lives under a category)' });
    else if (categoryName.length > 100) errors.push({ row, field: 'category', message: 'Category is longer than 100 characters' });
    if (!sku) errors.push({ row, field: 'sku', message: 'SKU is required' });
    else if (sku.length > 100) errors.push({ row, field: 'sku', message: 'SKU is longer than 100 characters' });
    if (!name) errors.push({ row, field: 'name', message: 'Name is required' });
    else if (name.length > 200) errors.push({ row, field: 'name', message: 'Name is longer than 200 characters' });
    let type = (get('type')?.toLowerCase() ?? defaultType) as ParsedItem['type'] | undefined;
    if (type && !['asset', 'consumable'].includes(type)) { errors.push({ row, field: 'type', message: 'Type must be "asset" or "consumable"' }); type = undefined; }
    if (!type && !errors.some((e) => e.row === row && e.field === 'type')) errors.push({ row, field: 'type', message: 'Type is required (map a column or choose a default)' });
    if (sku) {
      const key = sku.toLowerCase();
      if (state.seenSku.has(key)) errors.push({ row, field: 'sku', message: `Duplicate of row ${state.seenSku.get(key)} in this file` });
      else state.seenSku.set(key, row);
    }
    const openingQuantity = intField(get('openingQuantity'), 'openingQuantity', row, errors);
    const minThreshold = intField(get('minThreshold'), 'minThreshold', row, errors);
    const reorderQuantity = intField(get('reorderQuantity'), 'reorderQuantity', row, errors, 1);
    const expectedReturnHours = intField(get('expectedReturnHours'), 'expectedReturnHours', row, errors, 1);
    if (type === 'asset' && (openingQuantity !== undefined || minThreshold !== undefined || reorderQuantity !== undefined)) errors.push({ row, field: 'type', message: 'Quantity and threshold columns apply to consumables only' });
    if (type === 'consumable' && (get('assetTag') || expectedReturnHours !== undefined)) errors.push({ row, field: 'type', message: 'Asset tag and expected return apply to assets only' });
    if (errors.length === before && sku && name && type && categoryName) {
      valid.push({ row, type, sku, name, shelfName: get('shelf'), categoryName, assetTag: get('assetTag'), description: get('description'), openingQuantity, unit: get('unit'), minThreshold, reorderQuantity, expectedReturnHours, qrCode: get('qrCode') });
    }
  }
  return { valid, errors };
}

/** Pure and whole-file: the original entry point, kept for tests and small callers. */
export function validateRows(records: Record<string, string>[], mapping: Mapping, defaultType?: 'asset' | 'consumable'): { valid: ParsedItem[]; errors: RowError[] } {
  return validateRecords(records.map((rec, idx) => ({ row: idx + 2, rec })), mapping, defaultType, newValidationState());
}

const jobOf = async (db: Db, orgId: string, id: string) => {
  const [j] = await db.select().from(importJobs).where(and(eq(importJobs.id, id), eq(importJobs.orgId, orgId))).limit(1);
  if (!j) throw new NotFoundError('Import');
  return j;
};

/** Streams an upload through the CSV parser into import_rows. Never holds more than one batch in memory. */
async function stageUpload(db: Db, jobId: string, source: Readable): Promise<{ headers: string[]; total: number; preview: Record<string, string>[] }> {
  const parser = parse({ columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: false, max_record_size: 20_000 });
  pipeline(source, parser, () => undefined); // a failing source (client hang-up, size limit) destroys the parser, which ends the loop below with an error
  let batch: Array<typeof importRows.$inferInsert> = []; let n = 0; let headers: string[] = []; const preview: Record<string, string>[] = [];
  try {
    for await (const rec of parser as AsyncIterable<Record<string, string>>) {
      n++;
      if (n > env.IMPORT_MAX_ROWS) throw new ValidationError(`The file has more than ${env.IMPORT_MAX_ROWS.toLocaleString('en')} rows. Split it into smaller files.`);
      if (n === 1) headers = Object.keys(rec);
      if (preview.length < 5) preview.push(rec);
      batch.push({ importId: jobId, rowNo: n, data: rec });
      if (batch.length >= STAGE_BATCH) { await db.insert(importRows).values(batch); batch = []; }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new ValidationError(`The file could not be read as CSV: ${(err as Error).message}`);
  }
  if (batch.length) await db.insert(importRows).values(batch);
  return { headers, total: n, preview };
}

const failJob = (db: Db, id: string, reason: string) => db.update(importJobs).set({ status: 'failed', failureReason: reason.slice(0, 500) }).where(eq(importJobs.id, id));

// ── Validate (runs in the worker) ───────────────────────────────────
export async function validateImport(db: Db, importJobId: string): Promise<void> {
  const [job] = await db.select().from(importJobs).where(and(eq(importJobs.id, importJobId), eq(importJobs.status, 'validating'))).limit(1);
  if (!job) return; // already finished or discarded: at-least-once delivery makes this a no-op
  const opts = (job.columnMapping ?? {}) as ImportOptions;
  const state = newValidationState();
  const errors: RowError[] = []; const badRows = new Set<number>();
  let valid = 0; let after = 0;
  try {
    for (;;) {
      const chunk = await db.select({ rowNo: importRows.rowNo, data: importRows.data }).from(importRows)
        .where(and(eq(importRows.importId, importJobId), gt(importRows.rowNo, after))).orderBy(asc(importRows.rowNo)).limit(VALIDATE_CHUNK);
      if (chunk.length === 0) break;
      const r = validateRecords(chunk.map((c) => ({ row: c.rowNo + 1, rec: c.data as Record<string, string> })), opts.mapping ?? {}, opts.defaultType, state);
      valid += r.valid.length;
      for (const e of r.errors) { badRows.add(e.row); if (errors.length < MAX_ERRORS_KEPT) errors.push(e); }
      after = chunk[chunk.length - 1].rowNo;
      await db.update(importJobs).set({ processedRows: after }).where(eq(importJobs.id, importJobId));
    }
    await db.update(importJobs).set({ status: 'ready', processedRows: after, validRows: valid, invalidRows: badRows.size, errorReport: errors as never, failureReason: null }).where(eq(importJobs.id, importJobId));
  } catch (err) {
    await failJob(db, importJobId, `Validation stopped: ${(err as Error).message}`);
  }
}
registerJob<{ importJobId: string }>('import.validate', ({ importJobId }) => validateImport(rootDb, importJobId));

// ── Commit (runs in the worker) ─────────────────────────────────────
/**
 * Imports the staged rows a chunk at a time. Each chunk is ONE database transaction that also writes the checkpoint
 * (rows processed, counts, errors so far), so progress and data can never disagree: if the worker dies mid-chunk the
 * chunk rolls back, and the retry resumes from the last checkpoint. Inside a chunk every row still gets its own
 * savepoint, so one bad row fails alone and never takes its neighbours with it.
 */
export async function commitImport(db: Db, importJobId: string): Promise<void> {
  const [claimed] = await db.update(importJobs).set({ status: 'committing' }).where(and(eq(importJobs.id, importJobId), inArray(importJobs.status, ['queued', 'committing']))).returning();
  if (!claimed) return; // already completed/failed: at-least-once delivery makes this a no-op
  const [actor] = await db.select({ id: users.id, orgId: users.orgId, role: users.role }).from(users).where(eq(users.id, claimed.startedBy)).limit(1);
  const opts = (claimed.columnMapping ?? {}) as ImportOptions;

  // name → id caches so a big file doesn't do two lookups per row. Keys are lowercased.
  const shelfCache = new Map<string, string>(); const catCache = new Map<string, string>();
  const locShelves = await db.select({ id: shelves.id, name: shelves.name }).from(shelves).where(and(eq(shelves.orgId, actor.orgId), eq(shelves.locationId, claimed.locationId), isNull(shelves.archivedAt)));
  for (const sh of locShelves) shelfCache.set(sh.name.toLowerCase(), sh.id);
  const soleShelf = locShelves.length === 1 ? locShelves[0].id : undefined;
  const catRows = await db.select({ id: categories.id, name: categories.name, shelfId: categories.shelfId }).from(categories).where(and(eq(categories.orgId, actor.orgId), isNull(categories.archivedAt)));
  for (const c of catRows) catCache.set(`${c.shelfId}|${c.name.toLowerCase()}`, c.id);

  const state = newValidationState(); // repeats inside the file; after a resume the database's unique SKU index is the backstop
  let after = claimed.processedRows ?? 0; // resume pointer (the route zeroes it when the commit is queued)
  let imported = claimed.importedRows ?? 0; let skipped = claimed.skippedRows ?? 0; let failedRows = claimed.failedRows ?? 0;
  let failures = ((claimed.errorReport ?? []) as RowError[]).slice(0, MAX_ERRORS_KEPT);

  for (;;) {
    const chunk = await db.select({ rowNo: importRows.rowNo, data: importRows.data }).from(importRows)
      .where(and(eq(importRows.importId, importJobId), gt(importRows.rowNo, after))).orderBy(asc(importRows.rowNo)).limit(env.IMPORT_CHUNK_ROWS);
    if (chunk.length === 0) break;
    const { valid, errors } = validateRecords(chunk.map((c) => ({ row: c.rowNo + 1, rec: c.data as Record<string, string> })), opts.mapping ?? {}, opts.defaultType, state);

    // One query finds every SKU in this chunk that already exists, so those rows are skipped without a failed insert.
    const taken = valid.length ? new Set((await db.select({ sku: items.sku }).from(items).where(and(eq(items.orgId, actor.orgId), isNull(items.archivedAt), inArray(items.sku, valid.map((v) => v.sku))))).map((r) => r.sku)) : new Set<string>();

    const chunkFailures: RowError[] = [...errors];
    let chunkImported = 0; let chunkSkipped = 0; let chunkFailedRows = new Set(errors.map((e) => e.row)).size;
    const newShelves: Array<[string, string]> = []; const newCats: Array<[string, string]> = [];

    await db.transaction(async (tx0) => {
      const tx = tx0 as unknown as Db;
      for (const row of valid) {
        if (taken.has(row.sku)) { chunkSkipped++; chunkFailures.push({ row: row.row, field: 'sku', message: 'An active item with this SKU already exists (skipped)' }); continue; }
        const pendingShelf: Array<[string, string]> = []; const pendingCat: Array<[string, string]> = [];
        try {
          await tx.transaction(async (sp0) => { // a SAVEPOINT: a failing row undoes only itself
            const sp = sp0 as unknown as Db;
            let shelfId: string | undefined;
            if (row.shelfName) {
              const key = row.shelfName.toLowerCase();
              shelfId = shelfCache.get(key) ?? newShelves.find(([k]) => k === key)?.[1];
              if (!shelfId) {
                if (!opts.createMissing) throw new ValidationError(`Shelf "${row.shelfName}" does not exist in this location`);
                const [sh] = await sp.insert(shelves).values({ orgId: actor.orgId, locationId: claimed.locationId, name: row.shelfName }).onConflictDoNothing().returning({ id: shelves.id });
                shelfId = sh?.id ?? (await sp.select({ id: shelves.id }).from(shelves).where(and(eq(shelves.locationId, claimed.locationId), sql`lower(${shelves.name}) = lower(${row.shelfName})`, isNull(shelves.archivedAt))).limit(1))[0]?.id;
                if (shelfId) pendingShelf.push([key, shelfId]);
              }
            } else shelfId = opts.defaultShelfId ?? soleShelf;
            if (!shelfId) throw new ValidationError('No shelf for this row: add a shelf column, choose a default shelf, or create a shelf first');

            const catKey = `${shelfId}|${row.categoryName.toLowerCase()}`;
            let categoryId = catCache.get(catKey) ?? newCats.find(([k]) => k === catKey)?.[1];
            if (!categoryId) {
              if (!opts.createMissing) throw new ValidationError(`Category "${row.categoryName}" does not exist on that shelf`);
              const [c] = await sp.insert(categories).values({ orgId: actor.orgId, shelfId, name: row.categoryName }).onConflictDoNothing().returning({ id: categories.id });
              categoryId = c?.id ?? (await sp.select({ id: categories.id }).from(categories).where(and(eq(categories.shelfId, shelfId), sql`lower(${categories.name}) = lower(${row.categoryName})`, isNull(categories.archivedAt))).limit(1))[0]?.id;
              if (categoryId) pendingCat.push([catKey, categoryId]);
            }
            if (!categoryId) throw new ValidationError('Could not resolve the category');
            await createItemInTx(sp, actor, {
              type: row.type, sku: row.sku, name: row.name, description: row.description, categoryId, qrCode: row.qrCode, assetTag: row.assetTag,
              expectedReturnHours: row.expectedReturnHours, unit: row.unit, openingQuantity: row.openingQuantity, minThreshold: row.minThreshold, reorderQuantity: row.reorderQuantity,
            }, { source: 'import', importJobId });
          });
          // Remember new shelves/categories only once their row has really committed to the chunk.
          newShelves.push(...pendingShelf); newCats.push(...pendingCat);
          chunkImported++;
        } catch (err) {
          if (err instanceof ConflictError && ['SKU_TAKEN', 'QR_TAKEN', 'ASSET_TAG_TAKEN'].includes(err.code)) { chunkSkipped++; chunkFailures.push({ row: row.row, field: err.code === 'SKU_TAKEN' ? 'sku' : 'code', message: `${err.message} (skipped)` }); }
          else if (err instanceof AppError) { chunkFailedRows++; chunkFailures.push({ row: row.row, field: 'row', message: err.message }); }
          else if (isUniqueViolation(err)) { chunkSkipped++; chunkFailures.push({ row: row.row, field: 'row', message: 'Duplicate value (skipped)' }); }
          else throw err; // infrastructure failure: roll the chunk back; the retry resumes from the last checkpoint
        }
      }
      const nextFailures = [...failures, ...chunkFailures].slice(0, MAX_ERRORS_KEPT);
      await tx.update(importJobs).set({
        processedRows: chunk[chunk.length - 1].rowNo, importedRows: imported + chunkImported, skippedRows: skipped + chunkSkipped,
        failedRows: failedRows + chunkFailedRows, errorReport: nextFailures as never,
      }).where(eq(importJobs.id, importJobId));
      failures = nextFailures;
    });
    // The chunk is durable now: fold it into the running totals and make its shelves/categories visible to later chunks.
    imported += chunkImported; skipped += chunkSkipped; failedRows += chunkFailedRows;
    for (const [k, v] of newShelves) shelfCache.set(k, v);
    for (const [k, v] of newCats) catCache.set(k, v);
    after = chunk[chunk.length - 1].rowNo;
  }

  await db.transaction(async (tx) => {
    await tx.update(importJobs).set({ status: 'completed', totalRows: after, importedRows: imported, skippedRows: skipped, failedRows, errorReport: failures as never, completedAt: new Date(), rows: null }).where(eq(importJobs.id, importJobId));
    await tx.delete(importRows).where(eq(importRows.importId, importJobId)); // the raw staged data is dropped once processed
    await audit(tx, { orgId: actor.orgId, actorUserId: actor.id, action: 'import.completed', entityType: 'import', entityId: importJobId, next: { imported, skipped, failed: failedRows } });
  });
}
registerJob<{ importJobId: string }>('import.commit', ({ importJobId }) => commitImport(rootDb, importJobId));

/** Housekeeping: unstick jobs whose worker vanished, and drop uploads nobody went on to use. */
export async function sweepImports(db: Db): Promise<{ stuck: number; discarded: number }> {
  const stuck = await db.update(importJobs).set({ status: 'failed', failureReason: 'This import stopped making progress. Upload the file again.' })
    .where(and(inArray(importJobs.status, ['validating', 'committing']), sql`${importJobs.startedAt} < now() - interval '6 hours'`)).returning({ id: importJobs.id });
  const old = await db.delete(importJobs).where(and(inArray(importJobs.status, ['uploaded', 'ready', 'failed']), sql`${importJobs.startedAt} < now() - interval '2 days'`)).returning({ id: importJobs.id });
  return { stuck: stuck.length, discarded: old.length };
}

const progressOf = (j: typeof importJobs.$inferSelect) => ({
  processedRows: j.processedRows, totalRows: j.totalRows,
  percent: j.totalRows ? Math.min(100, Math.floor((100 * (j.status === 'completed' ? j.totalRows : j.processedRows)) / j.totalRows)) : 0,
});

export async function importRoutes(app: ApiFastifyInstance) {
  const ADMIN = requireRole('admin');

  app.post('/', { preHandler: [app.authenticate, ADMIN] }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: env.IMPORT_MAX_MB * 1024 * 1024, files: 1 } });
    if (!part) throw new ValidationError('A CSV file is required');
    if (!/\.csv$/i.test(part.filename ?? '')) throw new ValidationError('Only .csv files are accepted');
    const a = req.user!;
    const { resolveLocationId } = await import('../../lib/locations.js');
    const locationId = await resolveLocationId(req.server.db, a, (part.fields.locationId as { value?: string } | undefined)?.value);
    const [j] = await req.server.db.insert(importJobs).values({ orgId: a.orgId, locationId, fileName: part.filename.slice(0, 200), startedBy: a.id }).returning({ id: importJobs.id });
    try {
      const staged = await stageUpload(req.server.db, j.id, part.file);
      if (part.file.truncated) throw new ValidationError(`The file is larger than ${env.IMPORT_MAX_MB} MB. Split it into smaller files.`);
      if (staged.total === 0) throw new ValidationError('The file contains no data rows');
      await req.server.db.update(importJobs).set({ headers: staged.headers as never, totalRows: staged.total, fileBytes: part.file.bytesRead }).where(eq(importJobs.id, j.id));
      reply.code(201);
      return { id: j.id, headers: staged.headers, totalRows: staged.total, preview: staged.preview, mappableFields: FIELDS };
    } catch (err) {
      await req.server.db.delete(importJobs).where(eq(importJobs.id, j.id)).catch(() => undefined); // staged rows go with it (ON DELETE CASCADE)
      throw err;
    }
  });

  // Starts validation and returns immediately; poll GET /:id for progress and the report.
  app.post('/:id/validate', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, body: Body } }, async (req, reply) => {
    const j = await jobOf(req.server.db, req.user!.orgId, req.params.id);
    if (!['uploaded', 'ready', 'failed'].includes(j.status) || (j.status === 'failed' && (j.importedRows ?? 0) > 0)) throw new ConflictError('IMPORT_NOT_EDITABLE', `This import is ${j.status}`);
    const headers = new Set((j.headers ?? []) as string[]);
    for (const [field, col] of Object.entries(req.body.mapping)) {
      if (!(FIELDS as readonly string[]).includes(field)) throw new ValidationError(`Unknown field "${field}"`);
      if (!headers.has(col)) throw new ValidationError(`Column "${col}" is not in the file`);
    }
    await req.server.db.update(importJobs).set({ columnMapping: req.body as never, status: 'validating', processedRows: 0, validRows: null, invalidRows: null, errorReport: null, failureReason: null }).where(eq(importJobs.id, j.id));
    await enqueue('import.validate', { importJobId: j.id }, { jobId: `validate:${j.id}:${randomUUID()}` });
    const done = await jobOf(req.server.db, req.user!.orgId, j.id); // inline mode has finished by now; queue mode is still 'validating'
    reply.code(done.status === 'validating' ? 202 : 200);
    return { id: done.id, status: done.status, ...progressOf(done), validRows: done.validRows, invalidRows: done.invalidRows, errors: ((done.errorReport ?? []) as RowError[]).slice(0, 200) };
  });

  app.post('/:id/commit', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams } }, async (req, reply) => {
    const [j] = await req.server.db.update(importJobs).set({ status: 'queued', processedRows: 0, importedRows: 0, skippedRows: 0, failedRows: 0, errorReport: [] as never, failureReason: null })
      .where(and(eq(importJobs.id, req.params.id), eq(importJobs.orgId, req.user!.orgId), eq(importJobs.status, 'ready'))).returning({ id: importJobs.id });
    if (!j) { await jobOf(req.server.db, req.user!.orgId, req.params.id); throw new ConflictError('IMPORT_NOT_READY', 'Validate the import before committing it'); }
    const started = enqueue('import.commit', { importJobId: j.id }, { jobId: `import:${j.id}` });
    // With a worker the enqueue is instant. In inline mode (local dev) it would run the whole import inside this request and
    // outlast any proxy timeout, so let it run in the background of the process and report progress the same way.
    if (env.JOBS_MODE === 'inline') started.catch((err) => req.log.error({ err, importJobId: j.id }, 'inline import failed')); else await started;
    reply.code(202);
    return { id: j.id, status: 'queued' };
  });

  app.get('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams } }, async (req) => {
    const j = await jobOf(req.server.db, req.user!.orgId, req.params.id);
    return {
      id: j.id, fileName: j.fileName, status: j.status, ...progressOf(j), validRows: j.validRows, invalidRows: j.invalidRows,
      importedRows: j.importedRows, skippedRows: j.skippedRows, failedRows: j.failedRows, failureReason: j.failureReason,
      startedAt: j.startedAt.toISOString(), completedAt: j.completedAt?.toISOString() ?? null, errors: ((j.errorReport ?? []) as RowError[]).slice(0, 200),
    };
  });

  // Discard an upload that was never committed ("Start over"). Staged rows are removed with it.
  app.delete('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, response: { 204: { type: 'null' } } } }, async (req, reply) => {
    const j = await jobOf(req.server.db, req.user!.orgId, req.params.id);
    if (!['uploaded', 'ready', 'failed'].includes(j.status)) throw new ConflictError('IMPORT_IN_PROGRESS', 'This import is running and cannot be discarded');
    await req.server.db.delete(importJobs).where(eq(importJobs.id, j.id));
    reply.code(204);
  });

  // PRD §22 "downloadable error report"
  app.get('/:id/errors.csv', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams } }, async (req, reply) => {
    const j = await jobOf(req.server.db, req.user!.orgId, req.params.id);
    const esc = (s: string) => `"${s.replace(/"/g, '""').replace(/^([=+\-@\t\r])/, "'$1")}"`; // neutralise CSV formula injection
    const lines = ['row,field,message', ...((j.errorReport ?? []) as RowError[]).map((e) => `${e.row},${esc(e.field)},${esc(e.message)}`)];
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="import-${j.id}-errors.csv"`);
    return lines.join('\n');
  });

  app.get('/', { preHandler: [app.authenticate, ADMIN] }, async (req) => {
    const rows = await req.server.db.select({ id: importJobs.id, fileName: importJobs.fileName, status: importJobs.status, totalRows: importJobs.totalRows, importedRows: importJobs.importedRows, skippedRows: importJobs.skippedRows, failedRows: importJobs.failedRows, startedAt: importJobs.startedAt })
      .from(importJobs).where(eq(importJobs.orgId, req.user!.orgId)).orderBy(desc(importJobs.startedAt)).limit(50);
    return { items: rows.map((r) => ({ ...r, startedAt: r.startedAt.toISOString() })) };
  });
}
void Uuid;
