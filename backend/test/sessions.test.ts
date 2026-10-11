import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createFakes } from './fakes.js';
import { createTestDatabase } from './db.js';

// Needs a Postgres server: TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres npm test
const enabled = Boolean(process.env.TEST_DATABASE_URL);
const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'a brand new passphrase';

describe.skipIf(!enabled)('ending sign-ins when a password changes', () => {
  let app: FastifyInstance;
  let dropDatabase: () => Promise<void>;
  const fakes = createFakes();
  let ipCounter = 0;

  async function api(method: 'GET' | 'POST', url: string, options: { token?: string; body?: unknown } = {}) {
    const res = await app.inject({
      method,
      url,
      payload: options.body === undefined ? undefined : (options.body as object),
      headers: { 'x-forwarded-for': `10.6.0.${(ipCounter++ % 250) + 1}`, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  const register = async (username: string) =>
    (await api('POST', '/auth/register', { body: { username, email: `${username}@example.com`, password: PASSWORD } })).body.token as string;
  const login = async (username: string, password = PASSWORD) =>
    (await api('POST', '/auth/login', { body: { identifier: username, password } })).body.token as string;
  const whoAmI = (token: string) => api('GET', '/me', { token });

  beforeAll(async () => {
    dropDatabase = await createTestDatabase();
    app = buildApp({ integrations: fakes.integrations, logger: false, trustProxy: true });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await dropDatabase?.();
  });

  it('leaves everyone alone until a password changes', async () => {
    const token = await register('quinn');
    expect((await whoAmI(token)).status).toBe(200);
    expect((await whoAmI(await login('quinn'))).status).toBe(200);
  });

  it('changing the password ends other sign-ins but keeps this device signed in', async () => {
    const phone = await register('rae');
    const laptop = await login('rae');

    const changed = await api('POST', '/me/password', { token: laptop, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect(changed.status).toBe(200);

    const stolenPhone = await whoAmI(phone);
    expect(stolenPhone.status).toBe(401);
    expect(stolenPhone.body.code).toBe('session_revoked');
    expect((await whoAmI(laptop)).status).toBe(401); // the token that made the request is also old...
    expect((await whoAmI(changed.body.token)).status).toBe(200); // ...so the response carries a new one
  });

  it('signing in after the change works straight away', async () => {
    const token = await register('sam');
    await api('POST', '/me/password', { token, body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD } });
    expect((await whoAmI(await login('sam', NEW_PASSWORD))).status).toBe(200);
  });

  it('resetting a forgotten password ends every existing sign-in', async () => {
    const attackerHasThis = await register('tess');
    expect((await api('POST', '/auth/password/forgot', { body: { email: 'tess@example.com' } })).status).toBe(202);
    const resetToken = fakes.mailer.lastToken('reset', 'tess@example.com');

    expect((await api('POST', '/auth/password/reset', { body: { token: resetToken, password: NEW_PASSWORD } })).status).toBe(204);

    const afterReset = await whoAmI(attackerHasThis);
    expect(afterReset.status).toBe(401);
    expect(afterReset.body.code).toBe('session_revoked');
    expect((await whoAmI(await login('tess', NEW_PASSWORD))).status).toBe(200);
  });

  it('"sign out everywhere" ends every sign-in and returns a fresh one', async () => {
    const first = await register('uma');
    const second = await login('uma');

    const revoked = await api('POST', '/me/sessions/revoke', { token: first });
    expect(revoked.status).toBe(200);
    expect((await whoAmI(first)).status).toBe(401);
    expect((await whoAmI(second)).status).toBe(401);
    expect((await whoAmI(revoked.body.token)).status).toBe(200);
  });

  it("does not touch other people's sign-ins", async () => {
    const vic = await register('vic');
    const wren = await register('wren');
    await api('POST', '/me/sessions/revoke', { token: vic });
    expect((await whoAmI(wren)).status).toBe(200);
  });

  it('needs to be signed in', async () => {
    expect((await api('POST', '/me/sessions/revoke')).status).toBe(401);
  });
});
