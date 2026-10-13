/**
 * Prometheus metrics (PRD §39, §55). Operational errors must be diagnosable
 * without touching user data, so labels are enums (type, outcome, route
 * pattern) — never ids, emails, or free text.
 */
import client from 'prom-client';

export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds', help: 'API request latency',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [registry],
});
export const apiErrors = new client.Counter({
  name: 'api_errors_total', help: '5xx responses', labelNames: ['route', 'code'] as const, registers: [registry],
});
export const transactionsTotal = new client.Counter({
  name: 'transactions_total', help: 'Ledger transactions by type and outcome',
  labelNames: ['type', 'outcome'] as const, registers: [registry], // outcome: committed | replayed | rejected | failed
});
export const transactionDuration = new client.Histogram({
  name: 'transaction_duration_seconds', help: 'Ledger write latency',
  labelNames: ['type'] as const, buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry],
});
export const syncActions = new client.Counter({
  name: 'sync_actions_total', help: 'Offline-queue replays', labelNames: ['outcome'] as const, registers: [registry], // applied | replayed | conflict | failed
});
export const authFailures = new client.Counter({
  name: 'auth_failures_total', help: 'Authentication failures', labelNames: ['reason'] as const, registers: [registry],
});
export const inventoryDiscrepancies = new client.Gauge({
  name: 'inventory_discrepancies', help: 'Read-model rows disagreeing with the ledger (integrity job)', registers: [registry],
});
export const breakerStateGauge = new client.Gauge({
  name: 'circuit_breaker_state', help: '0=closed 1=half-open 2=open', labelNames: ['name'] as const, registers: [registry],
});
export const breakerRejections = new client.Counter({
  name: 'circuit_breaker_rejections_total', help: 'Calls rejected while open', labelNames: ['name'] as const, registers: [registry],
});
export const jobsTotal = new client.Counter({
  name: 'jobs_total', help: 'Background jobs', labelNames: ['name', 'outcome'] as const, registers: [registry],
});
export const emailsTotal = new client.Counter({
  name: 'emails_total', help: 'Outbox deliveries', labelNames: ['outcome'] as const, registers: [registry],
});
