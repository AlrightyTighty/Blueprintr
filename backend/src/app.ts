import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/hello', async () => ({ message: 'Hello from Orion' }));

  return app;
}
