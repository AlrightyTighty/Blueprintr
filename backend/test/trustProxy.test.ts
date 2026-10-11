import { describe, expect, it } from 'vitest';
import { buildApp, parseTrustProxy, toFastifyTrustProxy } from '../src/app.js';
import { createFakes } from './fakes.js';

describe('parseTrustProxy', () => {
  it('trusts nothing unless told to', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('nonsense')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('-2')).toBe(false);
  });
  it('accepts "true" or a number of proxy hops', () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });
});

describe('toFastifyTrustProxy', () => {
  it('passes true and false through', () => {
    expect(toFastifyTrustProxy(true)).toBe(true);
    expect(toFastifyTrustProxy(false)).toBe(false);
  });
  it('turns a hop count into "trust the nearest N addresses"', () => {
    const trust = toFastifyTrustProxy(1) as (address: string, hop: number) => boolean;
    expect(trust('10.0.0.1', 0)).toBe(true); // the proxy that connected to us
    expect(trust('203.0.113.9', 1)).toBe(false); // whatever address it says the client had
  });
});

describe('rate limits cannot be dodged with a made-up X-Forwarded-For', () => {
  // Login is limited to 10 attempts a minute per address. The requests below fail for lack of a database,
  // but the limit is applied before that, which is what is being checked.
  const attempt = (app: ReturnType<typeof buildApp>, forwardedFor?: string) =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: '203.0.113.7',
      payload: { identifier: 'nobody', password: 'wrong password' },
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    });

  it('keeps counting one real client however many addresses it claims', async () => {
    const app = buildApp({ integrations: createFakes().integrations, logger: false });
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await attempt(app, `198.51.100.${i + 1}`)).statusCode);
    expect(statuses.slice(10)).toEqual([429, 429, 429, 429]);
  });

  it('only believes the header when a proxy is explicitly trusted', async () => {
    const app = buildApp({ integrations: createFakes().integrations, logger: false, trustProxy: true });
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await attempt(app, `198.51.100.${i + 1}`)).statusCode);
    expect(statuses).not.toContain(429);
  });
});
