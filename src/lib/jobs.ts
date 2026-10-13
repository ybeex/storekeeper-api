/**
 * Background jobs on BullMQ (Redis). The API process only *enqueues*; a
 * separate worker process (src/worker.ts) consumes, so slow work (CSV import,
 * report generation, email, overdue scans) never competes with request
 * handling for CPU or connections — see references/performance-and-scale.md §8.
 *
 * Rules every handler must follow:
 *  - Idempotent. BullMQ is at-least-once; a job may run twice.
 *  - Carries ids, not payload copies — it re-reads current state from Postgres,
 *    which stays the source of truth (Redis may be flushed).
 *
 * JOBS_MODE=inline runs the handler synchronously in the caller; used by tests
 * and single-process dev so no worker is needed.
 */
import { Queue, Worker, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../env.js';
import { jobsTotal } from './metrics.js';

export type JobHandler<T = unknown> = (data: T) => Promise<void>;

const handlers = new Map<string, JobHandler<never>>();
export function registerJob<T>(name: string, handler: JobHandler<T>) {
  handlers.set(name, handler as JobHandler<never>);
}

const QUEUE = 'storekeeper';
let queue: Queue | null = null;
let producerConn: Redis | null = null;

function getQueue(): Queue {
  if (!queue) {
    producerConn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue(QUEUE, {
      connection: producerConn,
      defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 5_000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    });
  }
  return queue;
}

export async function enqueue<T>(name: string, data: T, opts: JobsOptions = {}): Promise<void> {
  if (env.JOBS_MODE === 'inline') {
    const h = handlers.get(name);
    if (!h) throw new Error(`No handler registered for job "${name}"`);
    await (h as JobHandler<T>)(data);
    return;
  }
  await getQueue().add(name, data, opts);
}

/** Cron-style repeatable job; jobId makes re-registration on every worker boot a no-op. */
export async function scheduleRepeatable(name: string, pattern: string): Promise<void> {
  if (env.JOBS_MODE === 'inline') return;
  await getQueue().add(name, {}, { repeat: { pattern }, jobId: `repeat:${name}`, removeOnComplete: 100 });
}

export function startWorker(log: FastifyBaseLogger): Worker {
  const conn = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const worker = new Worker(QUEUE, async (job) => {
    const h = handlers.get(job.name);
    if (!h) throw new Error(`No handler registered for job "${job.name}"`);
    await h(job.data as never);
  }, { connection: conn, concurrency: env.JOBS_CONCURRENCY });
  worker.on('completed', (job) => jobsTotal.inc({ name: job.name, outcome: 'ok' }));
  worker.on('failed', (job, err) => {
    jobsTotal.inc({ name: job?.name ?? 'unknown', outcome: 'failed' });
    log.error({ err, job: job?.name, attempt: job?.attemptsMade }, 'job failed');
  });
  return worker;
}

export async function closeQueue() {
  await queue?.close();
  await producerConn?.quit().catch(() => {});
  queue = null; producerConn = null;
}
