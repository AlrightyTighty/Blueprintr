import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, corsOriginFor, parseCorsOrigins } from '../src/app.js';
import { resetConfig } from '../src/config.js';
import { closePool } from '../src/db/pool.js';
import { redactUrl } from '../src/lib/redact.js';
import { createFakes } from './fakes.js';
import { createTestDatabase } from './db.js';

describe('redactUrl: secrets in links are kept out of logs', () => {
  it.each([
    ['/invites/AbC123_secret-token', '/invites/[redacted]'],
    ['/shared/AbC123_secret-token', '/shared/[redacted]'],
    ['/invites/tok/accept', '/invites/[redacted]/accept'],
    ['/reset-password?token=abc123', '/reset-password?token=[redacted]'],
    ['/verify-email?token=abc&next=%2Fprojects', '/verify-email?token=[redacted]&next=%2Fprojects'],
    ['/auth/github/callback?code=gh_code&state=xyz', '/auth/github/callback?code=[redacted]&state=[redacted]'],
  ])('%s', (url, expected) => {
    expect(redactUrl(url)).toBe(expected);
  });

  it('leaves ordinary URLs alone', () => {
    expect(redactUrl('/projects?limit=24&q=orders')).toBe('/projects?limit=24&q=orders');
    expect(redactUrl('/projects/8e5978d3-7d00-402d-9e54-e5aa4557212f/invites/9d1f')).toBe('/projects/8e5978d3-7d00-402d-9e54-e5aa4557212f/invites/9d1f');
    expect(redactUrl('/health')).toBe('/health');
  });

  it('keeps everything after a second question mark', () => {
    expect(redactUrl('/search?q=what?is=this')).toBe('/search?q=what?is=this');
  });
});

describe('corsOriginFor: which websites may call the API', () => {
  const base = { NODE_ENV: 'production', FRONTEND_URL: 'https://ripplemap.wiki/some/path' };
  it('uses an explicit setting above all', () => {
    expect(corsOriginFor({ ...base, CORS_ORIGIN: 'https://app.example.com' })).toBe('https://app.example.com');
  });
  it('in production, allows only the frontend itself when nothing is set', () => {
    expect(corsOriginFor(base)).toBe('https://ripplemap.wiki');
  });
  it('on a laptop, allows any origin when nothing is set', () => {
    expect(corsOriginFor({ ...base, NODE_ENV: 'development' })).toBe(true);
    expect(corsOriginFor({ ...base, NODE_ENV: 'test' })).toBe(true);
  });
  it('accepts several comma-separated origins, such as a bare domain and its www form', () => {
    expect(corsOriginFor({ ...base, CORS_ORIGIN: 'https://ripplemap.wiki,https://www.ripplemap.wiki' })).toEqual([
      'https://ripplemap.wiki',
      'https://www.ripplemap.wiki',
    ]);
  });
});

describe('parseCorsOrigins', () => {
  it('ignores spaces, empty entries and repeats, and keeps the order', () => {
    expect(parseCorsOrigins(' https://a.example , ,https://b.example,https://a.example,')).toEqual(['https://a.example', 'https://b.example']);
  });
  it('returns a single origin as a plain string', () => {
    expect(parseCorsOrigins('https://a.example')).toBe('https://a.example');
    expect(parseCorsOrigins('https://a.example, https://a.example')).toBe('https://a.example');
  });
  it('reduces each entry to its origin, as browsers send it', () => {
    expect(parseCorsOrigins('https://A.example/')).toBe('https://a.example');
    expect(parseCorsOrigins('https://a.example/app?x=1, http://localhost:5173/')).toEqual(['https://a.example', 'http://localhost:5173']);
  });
  it('allows a lone * but not mixed with others', () => {
    expect(parseCorsOrigins('*')).toBe('*');
    expect(() => parseCorsOrigins('*,https://a.example')).toThrow(/cannot be combined/);
  });
  it('refuses mistakes loudly instead of silently blocking the site', () => {
    expect(() => parseCorsOrigins(' , ')).toThrow(/lists no origins/);
    expect(() => parseCorsOrigins('ripplemap.wiki')).toThrow(/"ripplemap.wiki" is not a full origin/);
    expect(() => parseCorsOrigins('https://a.example,www.a.example')).toThrow(/"www.a.example"/);
    expect(() => parseCorsOrigins('ftp://a.example')).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe('CORS with several origins, as a browser sees it', () => {
  const originalOrigin = process.env.CORS_ORIGIN;
  const preflight = async (origin: string) => {
    process.env.CORS_ORIGIN = 'https://ripplemap.wiki, https://www.ripplemap.wiki';
    resetConfig();
    const app = buildApp({ integrations: createFakes().integrations, logger: false });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/projects',
      headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
    });
    await app.close();
    return res;
  };

  afterAll(() => {
    if (originalOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalOrigin;
    resetConfig();
  });

  it('answers each listed origin with that origin, so both the apex and www work', async () => {
    for (const origin of ['https://ripplemap.wiki', 'https://www.ripplemap.wiki']) {
      const res = await preflight(origin);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
      expect(res.headers['vary']).toContain('Origin');
    }
  });

  it('gives any other website no permission', async () => {
    const res = await preflight('https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const lookalike = await preflight('https://ripplemap.wiki.evil.example');
    expect(lookalike.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the readiness check', () => {
  it('reports not ready when the database cannot be reached', async () => {
    // No database exists in this test, which is the point.
    const app = buildApp({ integrations: createFakes().integrations, logger: false });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ code: 'database_unavailable' });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200); // liveness does not need it
    // The failed check opened a connection pool to nowhere; drop it so later tests build one for their own database.
    await app.close();
    await closePool();
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('with a database', () => {
  let app: FastifyInstance;
  let dropDatabase: () => Promise<void>;
  const fakes = createFakes();
  let token = '';
  let ipCounter = 0;

  const api = async (method: 'GET' | 'POST', url: string, body?: unknown) => {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: { 'x-forwarded-for': `10.5.0.${(ipCounter++ % 250) + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  beforeAll(async () => {
    dropDatabase = await createTestDatabase();
    app = buildApp({ integrations: fakes.integrations, logger: false, trustProxy: true });
    await app.ready();
    token = (await api('POST', '/auth/register', { username: 'harper', email: 'harper@example.com', password: 'correct horse battery' })).body.token;
  });
  afterAll(async () => {
    await app?.close();
    await dropDatabase?.();
  });

  it('is ready when the database answers', async () => {
    expect(await api('GET', '/health/ready')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('refuses a repository that is too large, before downloading anything', async () => {
    const byLink = await api('POST', '/projects', { name: 'Huge', repositories: [{ url: 'https://github.com/acme/huge' }] });
    expect(byLink.status).toBe(422);
    expect(byLink.body.errors[0]).toMatchObject({ field: 'url' });
    expect(byLink.body.errors[0].message).toMatch(/acme\/huge is too large to analyse \(879 MB; the limit is 488 MB\)/);
    expect((await api('GET', '/projects')).body.items).toHaveLength(0);
    expect(fakes.github.downloads).toBe(0);
  });

  it('still links an ordinary repository', async () => {
    expect((await api('POST', '/projects', { name: 'Fine', repositories: [{ url: 'https://github.com/acme/website' }] })).status).toBe(201);
  });
});
