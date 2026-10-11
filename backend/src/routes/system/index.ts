import type { FastifyPluginAsync } from 'fastify';
import { getPool } from '../../db/pool.js';
import * as resourceTypes from '../../repositories/resourceTypes.js';

const routes: FastifyPluginAsync = async (app) => {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/resource-types', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=3600');
    return { items: await resourceTypes.list(getPool()) };
  });
};

export default routes;
