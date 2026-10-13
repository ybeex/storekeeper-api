/**
 * Process entrypoint. Kept separate from app.ts so tests can build and
 * exercise the app without ever calling `listen` or touching signal
 * handlers.
 *
 * Graceful shutdown matters specifically because of how this app
 * scales: a rolling deploy across many instances behind a load
 * balancer sends SIGTERM to old instances while they may still have
 * in-flight requests (including ones mid-way through a DB transaction).
 * `app.close()` waits for in-flight requests to finish and runs every
 * plugin's `onClose` hook (closing the Postgres pool and Redis
 * connection cleanly) before the process exits — killing the process
 * immediately instead would occasionally abort a transaction mid-commit.
 */
import { buildApp } from './app.js';
import { env } from './env.js';

async function main() {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
  } catch (err) {
    app.log.error({ err }, 'failed to start');
    process.exit(1);
  }
}

void main();
