/**
 * A small typed error hierarchy. Every handler throws one of these
 * instead of calling reply.code().send() directly — that's what lets
 * the global error handler (plugins/error-handler.ts) turn any error,
 * expected or not, into the same JSON envelope documented in
 * references/api-conventions.md:
 *
 *   { "error": { "code": "ITEM_NOT_AVAILABLE", "message": "...",
 *                "requestId": "...", "details": { ... } } }
 *
 * `code` is a stable machine-readable string a client can branch on;
 * `message` is for humans/logs and may change wording over time.
 */

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'UNAUTHORIZED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

/** 409 — the request was well-formed but the current state won't allow it
 *  (item already checked out, stock insufficient, idempotency key reused
 *  with a different payload, sync conflict). This is the status code
 *  clients should treat as "retry is not the fix, re-check state first". */
export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(409, code, message, details);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSeconds });
  }
}
