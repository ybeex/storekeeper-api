/** File uploads (PRD §23, §52): item photos and transaction snapshots. Validated by content, not by filename or declared type. */
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { and, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { files } from '../../db/schema.js';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { env } from '../../env.js';
import { putObject, signedGetUrl } from '../../lib/storage.js';
import { ForbiddenError, NotFoundError, ValidationError } from '../../lib/errors.js';
import { IdParams } from '../../lib/schemas.js';
import { audit } from '../../lib/audit.js';

type Sniffed = { contentType: 'image/jpeg' | 'image/png' | 'image/webp'; ext: 'jpg' | 'png' | 'webp' };

/** Identify the image by magic bytes. A renamed .exe or an HTML file claiming image/png is rejected. */
export function sniffImage(b: Buffer): Sniffed | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { contentType: 'image/jpeg', ext: 'jpg' };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: 'image/png', ext: 'png' };
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return { contentType: 'image/webp', ext: 'webp' };
  return null;
}

export async function fileRoutes(app: FastifyInstance) {
  // multipart/form-data: field `kind` (item_photo | transaction_snapshot) must precede the `file` part.
  app.post('/', { preHandler: [app.authenticate, requireRole('admin', 'supervisor', 'store_staff')] }, async (req, reply) => {
    const part = await req.file({ limits: { fileSize: env.MAX_IMAGE_BYTES, files: 1 } });
    if (!part) throw new ValidationError('A file part is required');
    const kindField = (part.fields.kind as { value?: string } | undefined)?.value;
    if (kindField !== 'item_photo' && kindField !== 'transaction_snapshot') throw new ValidationError('Form field "kind" must be item_photo or transaction_snapshot (and sent before the file)');
    if (kindField === 'item_photo' && req.user!.role === 'store_staff') throw new ForbiddenError('Only admins and supervisors can upload item photos');

    const buf = await part.toBuffer();
    if (part.file.truncated) throw new ValidationError(`File exceeds ${env.MAX_IMAGE_BYTES} bytes`);
    const sniffed = sniffImage(buf);
    if (!sniffed) throw new ValidationError('Only JPEG, PNG or WebP images are accepted');

    const a = req.user!;
    const key = `${a.orgId}/${kindField}/${randomUUID()}.${sniffed.ext}`;
    await putObject(key, buf, sniffed.contentType); // 503 via circuit breaker if storage is down
    const [row] = await req.server.db.insert(files).values({
      orgId: a.orgId, kind: kindField, storageKey: key, contentType: sniffed.contentType, sizeBytes: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'), uploadedBy: a.id,
    }).returning();
    await audit(req.server.db, { orgId: a.orgId, actorUserId: a.id, action: 'file.uploaded', entityType: 'file', entityId: row.id, metadata: { kind: kindField, bytes: buf.length } });
    reply.code(201);
    return { id: row.id, kind: row.kind, contentType: row.contentType, sizeBytes: row.sizeBytes, url: await signedGetUrl(key) };
  });

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams, response: { 200: Type.Object({ id: Type.String(), url: Type.Union([Type.String(), Type.Null()]), expiresInSeconds: Type.Integer() }) } } }, async (req) => {
    const [f] = await req.server.db.select().from(files).where(and(eq(files.id, req.params.id), eq(files.orgId, req.user!.orgId))).limit(1);
    if (!f) throw new NotFoundError('File');
    return { id: f.id, url: await signedGetUrl(f.storageKey), expiresInSeconds: env.S3_SIGNED_URL_TTL_SECONDS };
  });
}
