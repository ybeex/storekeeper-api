import type { ApiFastifyInstance } from '../../types.js';
import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import QRCode from 'qrcode';
import { requireRole, anyRole } from '../../plugins/rbac.js';
import { IdParams } from '../../lib/schemas.js';
import { CreateItemBody, UpdateItemBody, ListItemsQuery, LookupQuery, TimelineQuery, BulkMoveBody } from './schema.js';
import { bulkMoveItems, createItem, getItem, updateItem, archiveItem, restoreItem, listItems, lookupByCode, itemTimeline } from './service.js';

const ADMIN = requireRole('admin');

export async function itemRoutes(app: ApiFastifyInstance) {
  app.post('/', { preHandler: [app.authenticate, ADMIN], config: { idempotent: true }, schema: { body: CreateItemBody } }, async (req, reply) => {
    reply.code(201);
    return createItem(req.server.db, req.user!, req.body);
  });

  app.get('/', { preHandler: [app.authenticate, anyRole], schema: { querystring: ListItemsQuery } }, async (req) => listItems(req.server.db, req.user!, req.query));

  app.post('/bulk-move', { preHandler: [app.authenticate, ADMIN], schema: { body: BulkMoveBody } }, async (req) => bulkMoveItems(req.server.db, req.user!, req.body.itemIds, req.body.categoryId));

  // Registered before /:id so "lookup" is never parsed as an id.
  app.get('/lookup', { preHandler: [app.authenticate, anyRole], schema: { querystring: LookupQuery } }, async (req) => lookupByCode(req.server.db, req.user!, req.query.code));

  app.get('/:id', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req) => getItem(req.server.db, req.user!, req.params.id));

  app.patch('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, body: UpdateItemBody } }, async (req) => updateItem(req.server.db, req.user!, req.params.id, req.body));

  app.delete('/:id', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams, querystring: Type.Object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }), response: { 204: { type: 'null' } } } }, async (req, reply) => {
    await archiveItem(req.server.db, req.user!, req.params.id, req.query.reason);
    reply.code(204);
  });

  app.post('/:id/restore', { preHandler: [app.authenticate, ADMIN], schema: { params: IdParams } }, async (req) => restoreItem(req.server.db, req.user!, req.params.id));

  app.get('/:id/timeline', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams, querystring: TimelineQuery } }, async (req) => itemTimeline(req.server.db, req.user!, req.params.id, req.query));

  // QR label payload (PRD Phase 1.5). Scanning it yields item.qrCode, which /items/lookup resolves.
  app.get('/:id/qr', { preHandler: [app.authenticate, anyRole], schema: { params: IdParams } }, async (req, reply) => {
    const item = await getItem(req.server.db, req.user!, req.params.id);
    const svg = await QRCode.toString(item.qrCode ?? `sk:${item.id}`, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
    reply.header('content-type', 'image/svg+xml').header('cache-control', 'private, max-age=3600');
    return svg;
  });
}
