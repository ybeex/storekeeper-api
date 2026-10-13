/**
 * One place that turns any thrown error into the response envelope
 * documented in references/api-conventions.md:
 *
 *   { "error": { "code": "...", "message": "...", "requestId": "...", "details": ... } }
 *
 * Handled, in order:
 *
 *  1. AppError (lib/errors.ts) — the expected case. We wrote the
 *     message, so it's safe to show.
 *  2. Fastify schema-validation errors — mapped to the same
 *     VALIDATION_ERROR shape as our own ValidationError, so clients
 *     never special-case "did this fail my check or Fastify's?".
 *  3. Transient database conditions — lock timeout, statement timeout,
 *     deadlock, serialization failure. These mean "the database was
 *     busy or two transactions collided", not "your request was wrong",
 *     so they become a retryable 503 with a Retry-After header instead
 *     of an opaque 500. (With the role-level timeouts in
 *     drizzle/manual/0001_role_settings.sql these will occur, rarely,
 *     under real contention — that's the timeouts doing their job.)
 *  4. Fastify-native client errors (malformed JSON, oversized body,
 *     unsupported media type) — anything carrying a 4xx `statusCode`
 *     passes through as that status. Without this, a client sending
 *     bad JSON would be told the *server* failed.
 *  5. A 503 from the load-shedding plugin — must stay a 503. Collapsing
 *     it into a 500 would defeat the whole point of shedding load:
 *     clients and load balancers treat 503 + Retry-After as "back off
 *     and retry", and a 500 as "the server is broken".
 *  6. Anything else — a real bug or infra failure. Logged in full
 *     (stack, request context), but the client gets a generic 500 with
 *     no message or stack. Returning exception text in an API response
 *     is a routine way to hand an attacker your ORM, schema, or file
 *     paths — see security.md.
 */
import fp from 'fastify-plugin';
import { apiErrors } from '../lib/metrics.js';
import type { FastifyInstance, FastifyRequest, FastifyReply, FastifyError } from 'fastify';
import { AppError } from '../lib/errors.js';
import { pgError } from '../lib/db-errors.js';

const TRANSIENT_DB_CODES = new Set([
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

export default fp(async function errorHandlerPlugin(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | AppError, req: FastifyRequest, reply: FastifyReply) => {
    const send = (status: number, code: string, message: string, details?: unknown) => {
      if (status >= 500) apiErrors.inc({ route: req.routeOptions?.url ?? 'unmatched', code });
      return reply.code(status).send({ error: { code, message, requestId: req.id, details } });
    };

    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'internal app error');
      return send(err.statusCode, err.code, err.message, err.details);
    }

    if ((err as FastifyError).validation) {
      return send(400, 'VALIDATION_ERROR', 'Request failed validation', (err as FastifyError).validation);
    }

    const pg = pgError(err);
    if (pg && TRANSIENT_DB_CODES.has(pg.code)) {
      req.log.warn({ err, sqlstate: pg.code }, 'transient database condition');
      reply.header('retry-after', '1');
      return send(503, 'TEMPORARILY_UNAVAILABLE', 'The service is busy; please retry shortly');
    }

    const status = (err as FastifyError).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return send(status, (err as FastifyError).code ?? 'BAD_REQUEST', err.message);
    }
    if (status === 503) {
      // under-pressure has already set Retry-After on the reply.
      return send(503, 'SERVICE_UNAVAILABLE', 'The service is temporarily overloaded');
    }

    req.log.error({ err }, 'unhandled error');
    return send(500, 'INTERNAL_ERROR', 'Something went wrong');
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found`, requestId: req.id },
    });
  });
});
