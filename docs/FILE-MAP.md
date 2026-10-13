# File and build map

## Repository hierarchy

```text
.
├── src/                         TypeScript application (compiled to dist/)
│   ├── app.ts                   Fastify composition root; registers plugins and routes
│   ├── server.ts                HTTP process entrypoint
│   ├── worker.ts                Background job process entrypoint
│   ├── env.ts                   Validates and exports environment configuration
│   ├── db/                      Drizzle tables, Postgres client and database types
│   ├── plugins/                 Fastify adapters for DB, Redis, auth, RBAC, security,
│   │                             idempotency, errors and activity logging
│   ├── lib/                     Shared domain and infrastructure helpers: ledger,
│   │                             jobs, storage, auth, validation, audit and metrics
│   └── modules/                 Feature routes and domain operations
│       ├── transactions/        Movement, lifecycle, batch operations and schemas
│       ├── approvals/           Approval policy and queued operation execution
│       ├── items/ auth/ users/  Feature groups with routes, schemas and services
│       └── shelves/ categories/ people/ teams/ jobs/ locations/ organization/
│           files/ imports/ sync/ reconciliation/ notifications/ views/ reports/
│           analytics/ audit/ activity/ ops/
├── drizzle/                     Generated migrations, metadata and manual SQL
├── scripts/                     Operational scripts, including seed data
├── test/                        Integration tests and test/unit/ unit tests
├── docs/                        Architecture and operating notes
├── package.json                 Scripts and dependency manifest
├── pnpm-workspace.yaml           Workspace configuration
├── pnpm-lock.yaml                Locked dependency graph
├── tsconfig.json                 TypeScript compilation configuration
├── drizzle.config.ts             Drizzle Kit configuration
├── Dockerfile                    API container build
├── docker-compose.yml             Local service dependencies
└── .github/workflows/ci.yml      Continuous integration workflow
```

## How the files connect

```text
server.ts ──▶ app.ts ──▶ plugins/ ──▶ lib/ ──▶ db/index.ts ──▶ db/schema.ts
                         │            ▲                         ▲
                         └──▶ modules/┘─────────────────────────┘

worker.ts ──▶ lib/jobs.ts + modules/ops/jobs.ts
                  └── registers background handlers from feature modules
```

`server.ts` starts the API using validated settings from `env.ts`. `app.ts` is the
composition boundary: it registers cross-cutting Fastify plugins and feature routes.
Routes validate input, apply authentication and authorization, then call feature logic.
Modules use shared `lib/` helpers and `db/index.ts`; queries and mutations target the
tables and relations in `db/schema.ts`. Shared libraries do not import feature modules.

The main inventory write path goes through `lib/ledger.ts`: transaction rows and stock
or custody read models are updated in one database transaction. SQL migrations in
`drizzle/` enforce database-level constraints and triggers. The approvals engine is a
deliberate dependency exception: approved work invokes the same transaction operation
functions as direct route requests.

## Build and runtime

- `pnpm build` runs `tsc -p tsconfig.json`. The TypeScript root is `src/`, so production
  output goes to `dist/`; tests and scripts are outside that build.
- `pnpm start` runs `dist/server.js`; `pnpm start:worker` runs `dist/worker.js`.
- `pnpm db:generate` derives migrations from `src/db/schema.ts`; `pnpm db:migrate`
  applies generated migrations. `pnpm db:setup` also applies required manual SQL.
- `pnpm test` runs integration tests in `test/*.test.ts`; `pnpm test:unit` runs the
  unit tests under `test/unit/`.

## Test grouping

- `test/security.test.ts`, `test/governance.test.ts` and
  `test/scope-and-imports.test.ts` cover cross-cutting security, governance and wiring.
- `test/checkout.concurrency.test.ts`, `test/ledger.integrity.test.ts`,
  `test/approvals.test.ts`, `test/reconciliation.test.ts`, `test/sync.test.ts`,
  `test/shelves.test.ts` and `test/web-readiness.test.ts` exercise feature behavior.
- `test/unit/` tests pure helpers and the circuit breaker; `test/helpers.ts` and
  `test/env-setup.ts` provide shared fixtures and test setup.
