import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { routeModules } from '../src/app.js';
import { perUserLimit } from '../src/http/rateLimits.js';

describe('perUserLimit', () => {
  async function buildLimitedApp() {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, { global: false });
    app.decorateRequest('userId', null);
    // Stands in for the real auth hook: the "account" is whatever the x-user header says.
    app.addHook('onRequest', async (req) => {
      const user = req.headers['x-user'];
      req.userId = typeof user === 'string' ? user : null;
    });
    app.get('/costly', perUserLimit(2), async () => ({ ok: true }));
    await app.ready();
    return app;
  }
  const call = (app: Awaited<ReturnType<typeof buildLimitedApp>>, user: string | null, address: string) =>
    app.inject({ method: 'GET', url: '/costly', remoteAddress: address, headers: user ? { 'x-user': user } : {} });

  it('counts an account across every address it uses', async () => {
    const app = await buildLimitedApp();
    const statuses = [];
    for (const address of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) statuses.push((await call(app, 'ana', address)).statusCode);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it('gives each account its own allowance, even from the same address', async () => {
    const app = await buildLimitedApp();
    for (let i = 0; i < 3; i++) await call(app, 'ana', '10.0.0.9');
    expect((await call(app, 'ana', '10.0.0.9')).statusCode).toBe(429);
    expect((await call(app, 'ben', '10.0.0.9')).statusCode).toBe(200);
  });

  it('falls back to the address for signed-out callers', async () => {
    const app = await buildLimitedApp();
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await call(app, null, '10.0.0.7')).statusCode);
    expect(statuses).toEqual([200, 200, 429]);
    expect((await call(app, null, '10.0.0.8')).statusCode).toBe(200);
  });
});

describe('the routes that cost money or use an outside quota are all rate limited', () => {
  async function limitedRoutes(): Promise<Set<string>> {
    const app = Fastify();
    const limited = new Set<string>();
    app.addHook('onRoute', (route) => {
      const config = route.config as { rateLimit?: unknown } | undefined;
      for (const method of [route.method].flat()) if (config?.rateLimit) limited.add(`${method} ${route.url}`);
    });
    for (const routes of routeModules) app.register(routes);
    await app.ready();
    return limited;
  }

  it.each([
    // Gemini and ElevenLabs
    'POST /projects/:projectId/ask',
    'POST /projects/:projectId/plans/:planId/explain',
    'POST /projects/:projectId/plans/:planId/briefing',
    'POST /projects/:projectId/voice/session',
    'POST /voice/tools/graph-query',
    'POST /narrate',
    // analyses and GitHub
    'POST /projects/:projectId/runs',
    'POST /projects',
    'POST /projects/:projectId/repositories',
    'GET /me/github-connections/:connectionId/repositories',
    'POST /projects/:projectId/runs/:runId/plans',
    // handing out access
    'POST /projects/:projectId/invites',
    'POST /projects/:projectId/sharing/rotate',
    // sign-in
    'POST /auth/login',
    'POST /auth/register',
    'POST /auth/password/forgot',
  ])('%s', async (route) => {
    expect(await limitedRoutes()).toContain(route);
  });
});
