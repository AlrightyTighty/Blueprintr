import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { maskEmail } from '../src/lib/maskEmail.js';
import { createFakes } from './fakes.js';
import { createTestDatabase } from './db.js';

// Needs a Postgres server: TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres npm test
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe('maskEmail', () => {
  it('keeps the first letter and the domain, hides the rest', () => {
    expect(maskEmail('jordan@example.com')).toBe('j*****@example.com');
    expect(maskEmail('a@example.com')).toBe('a**@example.com');
    expect(maskEmail('averyveryverylongname@example.com')).toBe('a*****@example.com');
  });
  it('never returns something that looks like an address when the input is not one', () => {
    expect(maskEmail('not-an-email')).toBe('***');
    expect(maskEmail('@example.com')).toBe('***');
  });
});

describe.skipIf(!enabled)('only the invited person can accept an invitation', () => {
  let app: FastifyInstance;
  let dropDatabase: () => Promise<void>;
  const fakes = createFakes();
  let ipCounter = 0;

  async function api(method: 'GET' | 'POST', url: string, options: { token?: string; body?: unknown } = {}) {
    const res = await app.inject({
      method,
      url,
      payload: options.body === undefined ? undefined : (options.body as object),
      headers: {
        'x-forwarded-for': `10.3.0.${(ipCounter++ % 250) + 1}`,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function register(username: string, email = `${username}@example.com`) {
    const res = await api('POST', '/auth/register', { body: { username, email, password: 'correct horse battery' } });
    expect(res.status).toBe(201);
    return res.body.token as string;
  }

  /** The owner makes a project and invites `email`; returns what the tests need. */
  async function inviteTo(ownerToken: string, email: string) {
    const project = await api('POST', '/projects', { token: ownerToken, body: { name: `Project ${ipCounter}` } });
    const invite = await api('POST', `/projects/${project.body.id}/invites`, { token: ownerToken, body: { email, role: 'editor' } });
    expect(invite.status).toBe(201);
    return { projectId: project.body.id as string, token: new URL(invite.body.inviteUrl).pathname.split('/').pop()! };
  }

  const membersOf = async (ownerToken: string, projectId: string) =>
    (await api('GET', `/projects/${projectId}/members`, { token: ownerToken })).body.items.map((m: any) => m.user.username);

  beforeAll(async () => {
    dropDatabase = await createTestDatabase();
    // The tests tell requests apart by faking X-Forwarded-For, so they opt in to trusting it.
    app = buildApp({ integrations: fakes.integrations, logger: false, trustProxy: true });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await dropDatabase?.();
  });
  afterEach(() => {
    fakes.mailer.deliverable = false;
  });

  it('emails the invitation when mail is deliverable, and never fails the invitation when mail is down', async () => {
    const owner = await register('mabel');
    const project = (await api('POST', '/projects', { token: owner, body: { name: 'Mailed' } })).body;
    const invitePath = `/projects/${project.id}/invites`;

    expect((await api('POST', invitePath, { token: owner, body: { email: 'a1@example.com', role: 'viewer' } })).body.emailSent).toBe(false);

    fakes.mailer.deliverable = true;
    const sent = await api('POST', invitePath, { token: owner, body: { email: 'a2@example.com', role: 'viewer' } });
    expect(sent.body.emailSent).toBe(true);
    expect(fakes.mailer.invitations.at(-1)).toMatchObject({ to: 'a2@example.com', projectName: 'Mailed', inviterName: 'mabel', link: sent.body.inviteUrl });

    fakes.mailer.failInvitations = true;
    const failed = await api('POST', invitePath, { token: owner, body: { email: 'a3@example.com', role: 'viewer' } });
    fakes.mailer.failInvitations = false;
    expect(failed.status).toBe(201);
    expect(failed.body.emailSent).toBe(false);
  });

  it('shows only a masked address to someone who just has the link', async () => {
    const owner = await register('olive');
    const { token } = await inviteTo(owner, 'dana@example.com');
    const preview = await api('GET', `/invites/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.email).toBe('d***@example.com');
    expect(JSON.stringify(preview.body)).not.toContain('dana@example.com');
  });

  it('refuses a different account, and the invitation stays usable by the right one', async () => {
    const owner = await register('otto');
    const { projectId, token } = await inviteTo(owner, 'bea@example.com');
    const stranger = await register('stranger', 'stranger@example.com');

    const refused = await api('POST', `/invites/${token}/accept`, { token: stranger });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('invite_email_mismatch');
    expect(refused.body.detail).toContain('b**@example.com');
    expect(refused.body.detail).not.toContain('bea@example.com');
    expect(await membersOf(owner, projectId)).toEqual(['otto']);

    // The refusal did not use the invitation up.
    const invitee = await register('bea');
    const accepted = await api('POST', `/invites/${token}/accept`, { token: invitee });
    expect(accepted.status).toBe(200);
    expect(await membersOf(owner, projectId)).toEqual(expect.arrayContaining(['otto', 'bea']));
  });

  it('matches the address without regard to capital letters', async () => {
    const owner = await register('opal');
    const { token } = await inviteTo(owner, 'Cleo@Example.com');
    const invitee = await register('cleo', 'CLEO@example.com');
    expect((await api('POST', `/invites/${token}/accept`, { token: invitee })).status).toBe(200);
  });

  it('needs a login at all', async () => {
    const owner = await register('orla');
    const { token } = await inviteTo(owner, 'finn@example.com');
    expect((await api('POST', `/invites/${token}/accept`)).status).toBe(401);
  });

  it('once email can really be sent, also needs the address to be verified', async () => {
    const owner = await register('oren');
    const { projectId, token } = await inviteTo(owner, 'gina@example.com');
    const invitee = await register('gina');

    fakes.mailer.deliverable = true;
    const unverified = await api('POST', `/invites/${token}/accept`, { token: invitee });
    expect(unverified.status).toBe(403);
    expect(unverified.body.code).toBe('email_not_verified');
    expect(await membersOf(owner, projectId)).toEqual(['oren']);

    const verifyToken = fakes.mailer.lastToken('verify', 'gina@example.com');
    expect((await api('POST', '/auth/email/verify', { body: { token: verifyToken } })).status).toBe(204);
    expect((await api('POST', `/invites/${token}/accept`, { token: invitee })).status).toBe(200);
  });
});
