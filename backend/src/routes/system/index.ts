import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../../db/pool.js';
import * as resourceTypes from '../../repositories/resourceTypes.js';

const routes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok' }));

  // Unlike /health, this proves the database answers, so a load balancer or deploy check can tell "up" from "usable".
  app.get('/health/ready', async (_req, reply) => {
    try {
      await getPool().query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).type('application/problem+json').send({
        type: 'about:blank',
        title: 'Not ready',
        status: 503,
        detail: 'The database is not reachable.',
        code: 'database_unavailable',
      });
    }
  });

  app.get('/resource-types', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return { items: await resourceTypes.list(getPool()) };
  });
};

export default routes;
