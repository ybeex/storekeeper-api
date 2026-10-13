/**
 * Background worker entrypoint: `node dist/worker.js`. Runs the BullMQ consumer and registers the
 * repeatable schedules. Scale it independently of the API (usually 1–2 replicas is plenty; handlers
 * are idempotent and email/outbox claims use SKIP LOCKED, so more replicas are safe).
 */
import Fastify from 'fastify';
import { startWorker, scheduleRepeatable, closeQueue } from './lib/jobs.js';
import { registerOpsJobs, scheduleOpsJobs } from './modules/ops/jobs.js';
import './modules/imports/module.js'; // registers the import.validate and import.commit handlers
import { closeDb } from './db/index.js';
import { env } from './env.js';

async function main() {
  const log = Fastify({ logger: { level: env.LOG_LEVEL } }).log;
  registerOpsJobs();
  await scheduleOpsJobs();
  const worker = startWorker(log);
  log.info('worker started');

  const stop = async (sig: string) => {
    log.info({ sig }, 'worker shutting down');
    await worker.close(); // waits for in-flight jobs
    await closeQueue();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}
void scheduleRepeatable;
main().catch((err) => { console.error(err); process.exit(1); });
