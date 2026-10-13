import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { db, dbRead, closeDb, type Db } from '../db/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** Read replica when DATABASE_READ_URL is set, otherwise the primary. For heavy reads that can be a moment behind. */
    dbRead: Db;
  }
}

export default fp(async function dbPlugin(app: FastifyInstance) {
  app.decorate('db', db);
  app.decorate('dbRead', dbRead);
  app.addHook('onClose', async () => {
    await closeDb();
  });
});
