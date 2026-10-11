import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { routeModules } from '../src/app.js';

const spec = parse(readFileSync(join(import.meta.dirname, '../openapi.yaml'), 'utf8')) as {
  paths: Record<string, Record<string, { operationId: string }>>;
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const specRoutes = new Set(
  Object.entries(spec.paths).flatMap(([path, item]) =>
    Object.keys(item).filter((m) => METHODS.includes(m)).map((m) => `${m.toUpperCase()} ${path}`),
  ),
);

async function registeredRoutes(): Promise<Set<string>> {
  const app = Fastify();
  const found = new Set<string>();
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) {
      if (['HEAD', 'OPTIONS'].includes(method)) continue;
      found.add(`${method} ${route.url.replace(/:(\w+)/g, '{$1}')}`);
    }
  });
  for (const routes of routeModules) app.register(routes);
  await app.ready();
  return found;
}

describe('implementation matches openapi.yaml', () => {
  it('implements every operation in the spec', async () => {
    const implemented = await registeredRoutes();
    expect([...specRoutes].filter((r) => !implemented.has(r))).toEqual([]);
  });

  it('has no routes the spec does not describe', async () => {
    const implemented = await registeredRoutes();
    expect([...implemented].filter((r) => !specRoutes.has(r))).toEqual([]);
  });
});
