# StoreKeeper API (ventrix)

Backend for **StoreKeeper PRD v3** — accountable inventory for stores and job sites: every movement of a tracked asset or consumable is an immutable, attributable ledger entry.

Node 20+ · Fastify 5 · PostgreSQL (Drizzle) · Redis · BullMQ · S3-compatible storage · nodemailer (Mailgun SMTP)

## Run it

```bash
cp .env.example .env
docker compose up -d db redis minio minio-init mailpit
npm ci
npm run db:generate          # drizzle-kit: creates the tables from src/db/schema.ts
npm run db:setup             # extensions → migrations → ledger immutability triggers (order matters)
npm run dev                  # API  :3000   (Swagger UI at /docs outside production)
npm run dev:worker           # background worker (email outbox, overdue scan, imports, integrity check)
npm test                     # integration tests need db + redis up; npm run test:unit needs nothing
```

`JOBS_MODE=inline` runs jobs inside the API process (no worker needed for quick local work). Production must use `queue`.

## Architecture

```
src/
  app.ts, server.ts, worker.ts     composition root · API entrypoint · worker entrypoint
  env.ts                           the only reader of process.env (validated, fails closed in production)
  db/schema.ts                     the domain model, documented decision-by-decision
  plugins/                         cross-cutting Fastify plugins: auth, rbac, security, idempotency, redis, db, errors
  lib/                             framework-free building blocks
    ledger.ts                      THE write path: claim idempotency key → guarded mutation (stock/custody/status CAS)
    circuit-breaker.ts             closed/open/half-open breaker with timeouts, used for every outbound dependency
    jobs.ts · mailer.ts · storage.ts · notify.ts · audit.ts · metrics.ts · holders.ts · locations.ts
  modules/<feature>/               one folder per PRD capability; routes → service → lib
    transactions/  movement.ts (checkout/checkin/consume/restock) · lifecycle.ts (adjust/loss/damage/condition/status/transfer/correct) · batch.ts
    approvals/     policy engine shared by every gated operation
    items/ files/ people/ teams/ jobs/ categories/ locations/ organization/ users/ auth/
    reconciliation/ sync/ imports/ notifications/ views/ reports/ analytics/ ops/
```

Dependency direction is one-way: `modules → lib`, `plugins → lib`, nothing in `lib` imports a module. The one deliberate exception is `modules/approvals/engine.ts`, which *executes* queued operations by calling the same `do*` functions the routes call — that is what guarantees an approved request and a direct request produce identical ledger rows.

### The five ideas everything rests on

1. **Immutable ledger.** `transactions` is append-only, enforced by a Postgres trigger (`drizzle/manual/0002_ledger_immutability.sql`), not by convention. Mistakes are fixed by a *new* reversing row linked via `corrects_transaction_id` (a unique index makes "corrected at most once" race-free).
2. **State is derived and provable.** `stock_levels` and `custody` are read models updated in the *same DB transaction* as the ledger row. Every ledger row carries a signed `stock_delta` / `custody_delta`; the nightly `integrity.check` job proves `SUM(delta) == read model` and raises an admin alert (and a Prometheus gauge) on any drift.
3. **Claim-first idempotency.** Every write inserts its ledger row (claiming the `Idempotency-Key` via a unique index inside a savepoint) *before* touching any state. A duplicate is turned away before it can mutate anything; a request that loses a race rolls back its claim too, so retries are judged on current state. Reusing a key for a different operation is a `409 IDEMPOTENCY_KEY_REUSED`.
4. **The WHERE clause is the lock.** Stock/custody changes are single guarded statements (`UPDATE … WHERE quantity >= n`); assets use a status compare-and-swap. No read-then-write gaps, no application locks; CHECK constraints are the backstop.
5. **Actor ≠ Holder; Location-aware from day one.** Actors are login `users`; Holders are `people` (most never log in), `teams`/departments, or `jobs`. Stock lives in `stock_levels(item, location)`, so multi-location needs no migration.

## PRD coverage

| PRD | Where |
|---|---|
| §6–7 Items, tracked assets vs consumables, scan lookup, QR | `items/` (`GET /items/lookup?code=`, `GET /items/:id/qr`) |
| Shelf → category → item hierarchy | `shelves/`, `categories/`, `items/` — see "Shelves" below |
| §8 Holders (person/team/department/job) | `people/`, `teams/`, `jobs/`, `lib/holders.ts` |
| §9 Locations (+ Phase 2 location-scoped permissions) | `locations/`, `lib/locations.ts`, `PUT /users/:id/locations` |
| §10 Job context | `jobId` on any movement |
| §11 Transaction model | `db/schema.ts` `transactions`, `GET /transactions` |
| §12 State derived from ledger; asset states | read models + integrity job; `assetStatus` ∈ available/checked_out/lost/damaged/under_repair/retired |
| §13–14 Checkout / batch / return | `POST /checkouts`, `/checkouts/batch`, `/checkins` |
| §15 Adjustments, condition | `/adjustments`, `/items/:id/condition`, `/items/:id/status` |
| §16 Consume / restock | `/consumptions`, `/restocks` |
| §17 Loss & damage as explicit events | `/losses`, `/damages` |
| §18, §32 Approval policy | `/organization/approval-policies`, `/approvals` |
| §19 Reconciliation (+ scheduled counts) | `/reconciliation-sessions`, `/reconciliation-sessions/schedules` |
| §21 Offline sync, conflicts | `POST /sync/batch`, `/sync/conflicts` |
| §22 CSV import | `/imports` (upload → validate → queued commit → `errors.csv`) |
| §23 Photos/snapshots (private, signed URLs) | `/files`, `org_settings.photo_required_for` |
| §24, §50 Audit, corrections | `audit_events` (immutable), `/transactions/:id/corrections` |
| §25 Timeline | `GET /items/:id/timeline` |
| §26–27 Outstanding & overdue | `GET /outstanding`, `custody.due_at`, `overdue.scan` job |
| §28 Low stock | `GET /low-stock`, `low_stock` notifications |
| §30 Notifications (in-app + email) | `/notifications`, `email_outbox`, `outbox.process` job |
| §31 Roles | admin · supervisor · store_staff · viewer, `plugins/rbac.ts` |
| §37–39, §55 Security, ops, observability | below |
| §40 Reports + export | `/reports/*?format=csv` (streamed) |
| §41 Success metrics | `GET /analytics/accountability` |
| Phase 2 transfers / analytics | `POST /transfers`; `/analytics/{loss-damage,consumption,asset-utilization,reorder-recommendations}` |

## Shelves, categories, items

`location → shelf → category → item`. Shelves and categories are created through separate endpoints (`POST /shelves`, `POST /categories`); a category **must** name an existing shelf, an item **must** name an existing category. A shelf has many categories, a category has many items; names are unique per parent. A shelf belongs to one location and that location is immutable, because an item's home location is *derived* from its shelf (so the two can never disagree). Moves (`PATCH /categories/:id {shelfId}`, `POST /items/bulk-move`) are allowed within a location only. Shelves/categories with active children cannot be archived. `GET /shelves` and `GET /categories` return roll-ups for the UI's "Collections" cards (assets, out, overdue, under repair, products, units, low stock, needs attention). Stock counts can be scoped to a shelf (`scope: "shelf"`). CSV import takes `shelf` and `category` columns (or a default shelf) and can create missing ones with `createMissing`.

## Governance

- **Logs:** `GET /audit-logs` (admin/supervisor; filter by action prefix, entity, actor, date; `/entity/:type/:id` for one thing's history; `/export.csv` for admins). Services write domain events with before/after state; `plugins/activity-log.ts` is the safety net underneath — every authenticated write, every export and every permission denial is recorded (never request bodies). Failed logins are logged. The table is append-only in the database.
- **Notifications:** org-wide rules per type — which roles receive it, in-app on/off, email on/off (`GET/PUT /notifications/rules`, admin). Callers can only narrow an audience, never widen it. `POST /notifications/announcements` broadcasts to chosen roles (supervisors can reach store staff and viewers only).
- **Invites:** role-based. Admins invite any role; supervisors invite store staff and viewers; others cannot. Invites carry name and location access, can be resent (supersedes the old link) or revoked; supervisors see and manage only their own.
- **Accounts:** profile name, session list/sign-out-device, last-admin protection, immediate cut-off on deactivation.

## UI kit support (`StoreKeeper_UI_kit.html`)

| Screen | Endpoint |
|---|---|
| Scan / item detail, status language (available · checked out · low stock · overdue · retired) | `GET /items/lookup?code=`, `GET /items/:id` (`stockState`: ok · near_minimum · low · out; holder with `overdueDays`) |
| Check out / in / consume / restock / batch | `POST /checkouts`, `/checkouts/batch`, `/checkins`, `/consumptions`, `/restocks` |
| Holder picker (person · team · job) | `GET /holders?q=` (with what each currently holds) |
| Outstanding table (Overdue · On time · Partial return; check in / send for inspection / declare lost) | `GET /outstanding` (`state`, `overdueDays`, `issuedQuantity`), `POST /checkins {condition:"needs_inspection"}`, `POST /losses` |
| Count against the shelf (system 100 / physical 93 / −7, reason, photo, supervisor approves) | `POST /reconciliation-sessions {scope:"shelf"}` + `/counts` |
| Store views: Items · Low stock · Activity · Sync problems | `GET /items`, `/low-stock`, `/activity`, `/sync/conflicts` |
| Collections | `GET /shelves`, `GET /shelves/:id`, `GET /categories` |
| Works without signal | `POST /sync/batch` |

## Web app integration (Next.js, httpOnly-cookie sessions)

The browser never talks to this API and never sees a token. The Next.js server is a backend-for-frontend:

1. `POST /api/login` (Next route handler) calls `POST /v1/auth/login`, then sets the API token in a cookie: `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age` from `expiresAt`. Return only the user/role to the client.
2. Server components, route handlers and server actions read the cookie and call the API with `Authorization: Bearer <token>`. Nothing about the API URL or token is exposed to client bundles.
3. Sliding sessions: when `expiresAt` is within ~30 minutes, call `POST /v1/auth/refresh` and re-set the cookie. Logout calls `POST /v1/auth/logout` and clears the cookie. A 401 from the API means clear the cookie and redirect to login.
4. **CSRF:** `SameSite=Lax` plus an `Origin` check on every mutating route handler (server actions already do this). Do not accept state-changing GETs.
5. **Idempotency:** generate one `Idempotency-Key` (UUID) per user submission and reuse it if the BFF retries; every create/POST route requires one.
6. **Client IP:** forward the end user's address as `X-Forwarded-For`, and set the API's `TRUST_PROXY` to the Next.js server's proxy IP or CIDR. Otherwise every login attempt appears to come from the BFF and shares one rate-limit bucket (and `true` would let anyone spoof it). Numeric hop counts are rejected because they cannot verify the immediate proxy. `CORS_ORIGINS` can stay narrow because browsers don't call the API.
7. **Offline:** a service worker can't read the httpOnly cookie, so queue actions in IndexedDB on the client and flush them through a Next.js route handler that forwards to `POST /v1/sync/batch`; prime the cache from `GET /v1/sync/bootstrap` (pass the previous `serverTime` as `since`).

Local data: `npm run seed` builds a realistic crib (shelves, overdue and partial returns, a low-stock item, a pending loss, a shelf count) and prints a login for each role.

## Security

- **AuthN:** 256-bit opaque bearer tokens, only SHA-256 hashes stored; argon2id passwords; 12-char minimum policy; account lockout after repeated failures (even a correct password is refused while locked); uniform timing for unknown users; password change/reset revokes all sessions; deactivation cuts off cached sessions immediately; max concurrent sessions per user.
- **AuthZ:** per-route `requireRole`; tenant (`org_id`) predicate on every query; cross-tenant access answers **404**, never 403; location-scoped users are confined in `lib/locations.ts`. `test/security.test.ts` walks the route table and fails if any non-public route is reachable without a token.
- **Input:** TypeBox schemas on every route, `additionalProperties: false` on writes, bounded lists/strings, magic-byte image sniffing, CSV formula-injection neutralised on export, request-size limits.
- **Transport/headers/limits:** helmet, strict CORS allow-list (required in production), Redis-backed rate limiting (tight on auth routes; fails open), event-loop load shedding.
- **Data:** private bucket + short-lived signed URLs; logs redact credentials and tokens; reset/invite tokens single-use, hashed, expiring; account-enumeration-safe forgot-password; append-only ledger and audit trail enforced in the database.
- **Secrets:** env-only; production boot refuses to start with insecure combinations (`inline` jobs, missing CORS origins/storage keys).

## Resilience

Circuit breakers (`lib/circuit-breaker.ts`, state exported as `circuit_breaker_state{name}`):

| Dependency | Breaker | When open |
|---|---|---|
| Mailgun SMTP | `smtp-mailgun` | worker pauses sending; emails stay safely in `email_outbox`; attempts are *not* burned |
| Object storage | `object-storage` | uploads answer `503 DEPENDENCY_UNAVAILABLE` immediately; reads degrade to `url: null` |
| Redis session cache | `redis-session-cache` | auth falls back to Postgres; rate limiter fails open |

Postgres deliberately has **no** breaker (no fallback exists; a tripped breaker would turn a blip into an outage) — it is protected by small per-process pools, PgBouncer, role-level statement/lock timeouts, deadlock/serialization retry (`lib/retry.ts`) and load shedding. `/healthz` (liveness) never touches dependencies; `/readyz` gates on Postgres only.

## Scaling notes

Stateless API (scale horizontally behind a load balancer → PgBouncer in transaction mode); keyset pagination everywhere (`seq` for the ledger); worker scales independently (SKIP LOCKED outbox, idempotent jobs); hot-path indexes are partial where possible. Known next steps if volumes demand: partition `transactions` by month, make the integrity check incremental, and add Postgres row-level security as defence-in-depth for tenancy.

## Decisions that deviate from the starter kit or the PRD's literal text

Agreed with the product owner: `people` separate from `users`; `stock_levels(item, location)`; one item row per physical asset (option A); `locations` vs `jobs`; `occurred_at` (clamped client time) vs `created_at` vs `seq`; Loss/Damage/Reconciliation built now (PRD §17/§19 override §11.1's "Future"); analytics pulled into Phase 2.

Judgement calls worth reviewing: offline-eligible = checkout/check-in/consume/restock only; "large" approval threshold is configurable per operation (`largeThreshold`); consumable due dates are not tracked (assets only); the PRD §13.3 "authorized override" for exceeding stock is **not** implemented (it would create negative stock, which §38 forbids) — over-*return* override (§56.2) is.

## Known gaps (deliberately deferred)

- **Response schemas:** only ~20 of ~135 routes declare them, so the OpenAPI document is weak on response shapes and unintended fields aren't stripped. Fastify serialises through these schemas and silently drops anything not listed, so adding them blind risks hiding real fields from the UI. Add them after the first green test run, route group by route group, with the tests guarding the shapes; then generate the web client's types from `/docs/json`.
- Inspection schedules, purchase orders, kits/bundles, saved filters, web push, webhooks/API keys, admin MFA (see the roadmap discussion).

## Status — read this

This codebase was written without network access: dependencies could not be installed, so it has **not been compiled against the real library types and the test suite has not been executed**. It has been syntax-checked and cross-checked for missing local exports only. Expect a short first pass of `npm run lint` fixes (mostly Drizzle/BullMQ typing nits) and run `npm test` against real Postgres before trusting any guarantee above. The tests were written to *prove* the concurrency/idempotency/immutability claims — if one fails, treat it as a real finding.
