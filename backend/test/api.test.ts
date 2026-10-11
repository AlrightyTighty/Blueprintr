import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getPool } from '../src/db/pool.js';
import { COMMIT, createFakes } from './fakes.js';
import { createTestDatabase } from './db.js';

// Needs a Postgres server: TEST_DATABASE_URL=postgres://postgres:test@localhost:54329/postgres npm test
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('API (end to end against Postgres)', () => {
  let app: FastifyInstance;
  let dropDatabase: () => Promise<void>;
  const fakes = createFakes();
  let ipCounter = 0;

  interface Reply {
    status: number;
    body: any;
    headers: Record<string, any>;
  }
  async function api(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options: { token?: string; body?: unknown; shareToken?: string; ip?: string; headers?: Record<string, string> } = {},
  ): Promise<Reply> {
    const res = await app.inject({
      method,
      url,
      payload: options.body === undefined ? undefined : (options.body as object),
      headers: {
        // Each call comes from a fresh IP so the auth rate limits don't trip unrelated tests.
        'x-forwarded-for': options.ip ?? `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        ...(options.shareToken ? { 'x-share-token': options.shareToken } : {}),
        ...options.headers,
      },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
  }

  const register = async (username: string, extra: Record<string, unknown> = {}) => {
    const res = await api('POST', '/auth/register', {
      body: { username, email: `${username}@example.com`, password: 'correct horse battery', ...extra },
    });
    expect(res.status).toBe(201);
    return { token: res.body.token as string, id: res.body.user.id as string };
  };

  beforeAll(async () => {
    dropDatabase = await createTestDatabase();
    app = buildApp({ integrations: fakes.integrations, logger: false, trustProxy: true });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await dropDatabase?.();
  });

  const alice = { token: '', id: '' };
  const bob = { token: '', id: '' };
  const carol = { token: '', id: '' };
  let aliceConnectionId = '';
  let projectId = '';
  let runId = '';

  // ---------------------------------------------------------------------------------------------------------
  describe('accounts', () => {
    it('registers with username, email and password and returns a session', async () => {
      const res = await api('POST', '/auth/register', {
        body: { username: 'alice', email: 'Alice@Example.com', password: 'correct horse battery', displayName: 'Alice A' },
      });
      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ username: 'alice', email: 'alice@example.com', emailVerified: false, displayName: 'Alice A' });
      expect(res.body.user.passwordHash).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('scrypt');
      alice.token = res.body.token;
      alice.id = res.body.user.id;
    });

    it('rejects duplicate usernames (case-insensitive) and emails', async () => {
      const dupUser = await api('POST', '/auth/register', { body: { username: 'ALICE', email: 'other@example.com', password: 'correct horse battery' } });
      expect(dupUser).toMatchObject({ status: 409, body: { code: 'username_taken' } });
      expect(dupUser.headers['content-type']).toContain('application/problem+json');
      const dupEmail = await api('POST', '/auth/register', { body: { username: 'alice2', email: 'ALICE@example.com', password: 'correct horse battery' } });
      expect(dupEmail).toMatchObject({ status: 409, body: { code: 'email_taken' } });
    });

    it('requires username, email and password, with field errors', async () => {
      const res = await api('POST', '/auth/register', { body: { username: 'x', password: 'short' } });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.map((e: any) => e.field).sort()).toEqual(['email', 'password', 'username']);
    });

    it('logs in by username or email, and refuses a wrong password', async () => {
      const byName = await api('POST', '/auth/login', { body: { identifier: 'alice', password: 'correct horse battery' } });
      expect(byName.status).toBe(200);
      const byEmail = await api('POST', '/auth/login', { body: { identifier: 'ALICE@example.com', password: 'correct horse battery' } });
      expect(byEmail.status).toBe(200);
      const wrong = await api('POST', '/auth/login', { body: { identifier: 'alice', password: 'nope nope nope' } });
      expect(wrong).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } });
      const unknown = await api('POST', '/auth/login', { body: { identifier: 'ghost', password: 'nope nope nope' } });
      expect(unknown).toMatchObject({ status: 401, body: { code: 'invalid_credentials' } });
    });

    it('protects /me', async () => {
      expect((await api('GET', '/me')).status).toBe(401);
      expect((await api('GET', '/me', { token: 'garbage' }))).toMatchObject({ status: 401, body: { code: 'invalid_token' } });
      expect((await api('GET', '/me', { token: alice.token })).body.username).toBe('alice');
    });

    it('verifies email with a one-time token', async () => {
      const token = fakes.mailer.lastToken('verify', 'alice@example.com');
      expect((await api('POST', '/auth/email/verify', { body: { token } })).status).toBe(204);
      expect((await api('GET', '/me', { token: alice.token })).body.emailVerified).toBe(true);
      expect((await api('POST', '/auth/email/verify', { body: { token } })).status).toBe(400);
    });

    it('resets a forgotten password, once', async () => {
      const bobAccount = await register('bob');
      Object.assign(bob, bobAccount);
      expect((await api('POST', '/auth/password/forgot', { body: { email: 'nobody@example.com' } })).status).toBe(202);
      expect((await api('POST', '/auth/password/forgot', { body: { email: 'bob@example.com' } })).status).toBe(202);
      const token = fakes.mailer.lastToken('reset', 'bob@example.com');
      expect((await api('POST', '/auth/password/reset', { body: { token, password: 'a brand new passphrase' } })).status).toBe(204);
      expect((await api('POST', '/auth/password/reset', { body: { token, password: 'another passphrase here' } })).status).toBe(400);
      expect((await api('POST', '/auth/login', { body: { identifier: 'bob', password: 'correct horse battery' } })).status).toBe(401);
      const login = await api('POST', '/auth/login', { body: { identifier: 'bob', password: 'a brand new passphrase' } });
      expect(login.status).toBe(200);
      bob.token = login.body.token;
    });

    it('updates the profile and rejects taken usernames', async () => {
      expect((await api('PATCH', '/me', { token: alice.token, body: { displayName: 'Alice Anderson' } })).body.displayName).toBe('Alice Anderson');
      expect((await api('PATCH', '/me', { token: alice.token, body: { username: 'BOB' } }))).toMatchObject({ status: 409, body: { code: 'username_taken' } });
      expect((await api('PATCH', '/me', { token: alice.token, body: {} })).status).toBe(422);
    });

    it('changes the password after checking the current one', async () => {
      expect((await api('POST', '/me/password', { token: alice.token, body: { currentPassword: 'wrong', newPassword: 'a long new passphrase' } })).status).toBe(401);
      const changed = await api('POST', '/me/password', { token: alice.token, body: { currentPassword: 'correct horse battery', newPassword: 'a long new passphrase' } });
      expect(changed.status).toBe(200);
      alice.token = changed.body.token; // changing the password ends the old sign-in; this is the fresh one
      expect((await api('POST', '/auth/login', { body: { identifier: 'alice', password: 'a long new passphrase' } })).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('GitHub', () => {
    it('links a GitHub account to an existing user, without exposing tokens', async () => {
      expect((await api('GET', '/auth/github/authorize?intent=link')).status).toBe(401);
      const start = await api('GET', '/auth/github/authorize?intent=link', { token: alice.token });
      expect(start.status).toBe(200);
      expect(start.body.authorizeUrl).toContain(start.body.state);

      fakes.github.grantCode('alice-code', { id: 1001, login: 'alice-gh', name: 'Alice', email: 'alice@example.com', avatarUrl: null });
      const linked = await api('POST', '/auth/github/callback', { token: alice.token, body: { code: 'alice-code', state: start.body.state } });
      expect(linked.body.status).toBe('linked');
      expect(Object.keys(linked.body.connection).sort()).toEqual(['createdAt', 'githubLogin', 'githubUserId', 'id', 'scopes']);
      aliceConnectionId = linked.body.connection.id;

      const list = await api('GET', '/me/github-connections', { token: alice.token });
      expect(list.body.items).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain('token-alice-code');
    });

    it('rejects a state token that was issued for someone else', async () => {
      const start = await api('GET', '/auth/github/authorize?intent=link', { token: alice.token });
      fakes.github.grantCode('x', { id: 1999, login: 'x', name: null, email: null, avatarUrl: null });
      const res = await api('POST', '/auth/github/callback', { token: bob.token, body: { code: 'x', state: start.body.state } });
      expect(res.status).toBe(401);
    });

    it('lists repositories visible to a connection', async () => {
      const res = await api('GET', `/me/github-connections/${aliceConnectionId}/repositories?q=orders`, { token: alice.token });
      expect(res.body.items.map((r: any) => r.fullName)).toEqual(['acme/orders']);
      expect((await api('GET', `/me/github-connections/${aliceConnectionId}/repositories`, { token: bob.token })).status).toBe(404);
    });

    it('signs up with GitHub: prefills username and email, still requires a password', async () => {
      fakes.github.grantCode('carol-code', { id: 2002, login: 'carol-gh', name: 'Carol C', email: 'carol@example.com', avatarUrl: 'https://img.test/c.png' });
      const start = await api('GET', '/auth/github/authorize?intent=signup');
      const callback = await api('POST', '/auth/github/callback', { body: { code: 'carol-code', state: start.body.state } });
      expect(callback.body.status).toBe('registration_required');
      expect(callback.body.prefill).toMatchObject({ username: 'carol-gh', email: 'carol@example.com', displayName: 'Carol C' });

      const noPassword = await api('POST', '/auth/github/complete', { body: { registrationToken: callback.body.registrationToken, username: 'carol', email: 'carol@example.com' } });
      expect(noPassword.status).toBe(422);

      const done = await api('POST', '/auth/github/complete', {
        body: { registrationToken: callback.body.registrationToken, username: 'carol', email: 'carol@example.com', password: 'carol has a passphrase' },
      });
      expect(done.status).toBe(201);
      expect(done.body.user).toMatchObject({ username: 'carol', emailVerified: true }); // GitHub already verified it
      Object.assign(carol, { token: done.body.token, id: done.body.user.id });
      expect(fakes.mailer.sent.some((m) => m.to === 'carol@example.com')).toBe(false);

      // The same GitHub account now signs straight in.
      const again = await api('GET', '/auth/github/authorize?intent=login');
      const signedIn = await api('POST', '/auth/github/callback', { body: { code: 'carol-code', state: again.body.state } });
      expect(signedIn.body).toMatchObject({ status: 'authenticated', session: { user: { username: 'carol' } } });
    });

    it('does not let a GitHub account be linked to two users', async () => {
      const start = await api('GET', '/auth/github/authorize?intent=link', { token: bob.token });
      const res = await api('POST', '/auth/github/callback', { token: bob.token, body: { code: 'carol-code', state: start.body.state } });
      expect(res).toMatchObject({ status: 409, body: { code: 'github_account_taken' } });
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('projects and analysis', () => {
    it('creates a project, links a repository and analyzes it', async () => {
      const res = await api('POST', '/projects', {
        token: alice.token,
        body: { name: 'Orders platform', description: 'demo', repositories: [{ connectionId: aliceConnectionId, githubRepoId: 5000 }], analyze: true },
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Orders platform', myRole: 'owner', memberCount: 1 });
      expect(res.body.shareToken).toBeUndefined();
      expect(res.body.repositories[0]).toMatchObject({ branch: 'main', rootPath: '', repository: { fullName: 'acme/orders' } });
      expect(res.body.currentRun).toMatchObject({ status: 'succeeded', commitSha: COMMIT, isCurrent: true });
      expect(res.body.openFindingCounts).toMatchObject({ high: 2, medium: 1 });
      projectId = res.body.id;
      runId = res.body.currentRunId;
    });

    it('rejects a repository the connection cannot see', async () => {
      const res = await api('POST', '/projects', {
        token: alice.token,
        body: { name: 'bad', repositories: [{ connectionId: aliceConnectionId, githubRepoId: 424242 }] },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect((await api('GET', '/projects', { token: alice.token })).body.items).toHaveLength(1); // nothing was created
    });

    it('lists my projects with their current run', async () => {
      const res = await api('GET', '/projects', { token: alice.token });
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({ id: projectId, myRole: 'owner', currentRun: { status: 'succeeded' } });
      expect((await api('GET', '/projects?role=viewer', { token: alice.token })).body.items).toHaveLength(0);
      expect((await api('GET', '/projects?q=ORDERS', { token: alice.token })).body.items).toHaveLength(1);
    });

    it('serves the graph with names, icons and a confidence on every edge', async () => {
      const res = await api('GET', `/projects/${projectId}/runs/current/graph`, { token: alice.token });
      expect(res.status).toBe(200);
      expect(res.body.runId).toBe(runId);
      const table = res.body.nodes.find((n: any) => n.address === 'aws_dynamodb_table.orders');
      expect(table.resourceType).toMatchObject({ displayName: 'DynamoDB Table', iconKey: 'aws/dynamodb', category: 'database' });
      expect(res.body.edges.every((e: any) => ['certain', 'high', 'inferred'].includes(e.confidence))).toBe(true);
      const fn = res.body.nodes.find((n: any) => n.address === 'src/api/app.js::cancelOrder');
      expect(fn).toMatchObject({ kind: 'code_function', filePath: 'src/api/app.js' });
      expect(fn.parentId).toBe(res.body.nodes.find((n: any) => n.address === 'src/api/app.js').id);
    });

    it('reports the planted findings', async () => {
      const res = await api('GET', `/projects/${projectId}/runs/${runId}/findings`, { token: alice.token });
      expect(res.body.items.map((f: any) => f.kind).sort()).toEqual(['over_broad_iam', 'permission_gap', 'unmanaged_resource']);
      expect(res.body.items[0].severity).toBe('high'); // most severe first
      expect((await api('GET', `/projects/${projectId}/runs/${runId}/findings?kind=permission_gap`, { token: alice.token })).body.items).toHaveLength(1);
      expect((await api('GET', `/projects/${projectId}/runs/${runId}/findings?severity=critical`, { token: alice.token })).body.items).toHaveLength(0);
    });

    it('shows a resource its code and the roles that grant access', async () => {
      const graph = (await api('GET', `/projects/${projectId}/runs/current/graph`, { token: alice.token })).body;
      const table = graph.nodes.find((n: any) => n.address === 'aws_dynamodb_table.orders');
      const detail = await api('GET', `/projects/${projectId}/runs/current/nodes/${table.id}`, { token: alice.token });
      expect(detail.body.incoming.map((i: any) => i.node.address)).toEqual(expect.arrayContaining(['src/api/app.js::getOrder', 'aws_iam_role.api_role']));
      expect(detail.body.grants).toHaveLength(2);
      const apiRole = detail.body.grants.find((g: any) => g.role.address === 'aws_iam_role.api_role');
      expect(apiRole.allowedActions).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem']));
      expect(apiRole.allowedActions).not.toContain('dynamodb:DeleteItem');
      expect(apiRole.policy.address).toBe('aws_iam_role_policy.api_access');
    });

    it('computes blast radius in both directions', async () => {
      const graph = (await api('GET', `/projects/${projectId}/runs/current/graph`, { token: alice.token })).body;
      const table = graph.nodes.find((n: any) => n.address === 'aws_dynamodb_table.orders');
      const dependents = await api('GET', `/projects/${projectId}/runs/current/nodes/${table.id}/blast-radius`, { token: alice.token });
      const addresses = dependents.body.reached.map((r: any) => r.node.address);
      expect(addresses).toEqual(expect.arrayContaining(['src/api/app.js::getOrder', 'aws_iam_role.api_role', 'aws_lambda_function.api', 'src/worker/main.py::process']));
      expect(addresses).not.toContain('aws_s3_bucket.site');
      expect(dependents.body.reached.every((r: any) => r.distance >= 1)).toBe(true);

      const fn = graph.nodes.find((n: any) => n.address === 'src/api/app.js::getOrder');
      const deps = await api('GET', `/projects/${projectId}/runs/current/nodes/${fn.id}/blast-radius?direction=dependencies`, { token: alice.token });
      expect(deps.body.reached.map((r: any) => r.node.address)).toEqual(expect.arrayContaining(['aws_dynamodb_table.orders', 'aws_lambda_function.api']));
      const shallow = await api('GET', `/projects/${projectId}/runs/current/nodes/${table.id}/blast-radius?maxDepth=1`, { token: alice.token });
      expect(shallow.body.reached.every((r: any) => r.distance === 1)).toBe(true);
    });

    it('answers structured graph queries', async () => {
      const res = await api('POST', `/projects/${projectId}/graph/query`, { token: alice.token, body: { op: 'touches', node: 'orders' } });
      expect(res.body.summary).toMatch(/things touch aws_dynamodb_table\.orders/);
      expect(res.body.results.length).toBeGreaterThan(2);
      const path = await api('POST', `/projects/${projectId}/graph/query`, { token: alice.token, body: { op: 'path', node: 'src/worker/main.py::process', to: 'aws_dynamodb_table.orders' } });
      expect(path.body.results.map((r: any) => r.node.address)).toEqual(['aws_dynamodb_table.orders']);
      const findings = await api('POST', `/projects/${projectId}/graph/query`, { token: alice.token, body: { op: 'findings', node: 'cancelOrder' } });
      expect(findings.body.findings[0].kind).toBe('permission_gap');
      expect((await api('POST', `/projects/${projectId}/graph/query`, { token: alice.token, body: { op: 'nonsense', node: 'x' } })).status).toBe(422);
    });

    it('lists the endpoints the infrastructure exposes', async () => {
      const res = await api('GET', `/projects/${projectId}/runs/current/endpoints`, { token: alice.token });
      expect(res.status).toBe(200);
      expect(res.body.items.map((e: any) => `${e.method} ${e.path}`)).toEqual([
        'POST /orders',
        'DELETE /orders/{id}',
        'GET /orders/{id}',
        'POST /reports',
        'PUT /uploads/{key}',
      ]);
      expect(res.body.items[0]).toMatchObject({ kind: 'http_api', apiNodeId: expect.any(String), functionNodeId: expect.any(String) });
    });

    it('"calls" an endpoint: follows the request from the API through the code to the data and into the worker', async () => {
      const res = await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { token: alice.token, body: { method: 'post', path: 'orders?dry=1' } });
      expect(res.status).toBe(200);
      const graph = (await api('GET', `/projects/${projectId}/runs/current/graph`, { token: alice.token })).body;
      const addressOf = (id: string) => graph.nodes.find((n: any) => n.id === id).address;
      expect(res.body.request).toEqual({ method: 'POST', path: '/orders' });
      expect(res.body.match).toMatchObject({ method: 'POST', path: '/orders', kind: 'http_api' });
      const steps = res.body.steps.map((s: any) => [s.phase, addressOf(s.nodeId), s.async]);
      expect(steps.slice(0, 5)).toEqual([
        ['api', 'aws_apigatewayv2_api.http', false],
        ['route', 'aws_apigatewayv2_route.post_order', false],
        ['integration', 'aws_apigatewayv2_integration.api', false],
        ['compute', 'aws_lambda_function.api', false],
        ['code', 'src/api/app.js::handler', false],
      ]);
      expect(steps.filter((s: any) => s[2]).map((s: any) => s[1])).toEqual(['aws_lambda_function.worker', 'src/worker/main.py::handler', 'src/worker/main.py::process']);
      expect(res.body.codeScope).toBe('shared_handler');
      expect(res.body.gaps[0]).toContain('serves 5 endpoints through one handler');
      expect(res.body.edges.length).toBeGreaterThan(5);
      // 'calls' is a stored edge relation (migration 009), so the graph a viewer loads has the call graph too.
      expect(graph.edges.filter((e: any) => e.relation === 'calls').length).toBe(6);
    });

    it('fills in path parameters and honours a chosen endpoint', async () => {
      const res = await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { token: alice.token, body: { method: 'GET', path: '/orders/abc-123' } });
      expect(res.body.match).toMatchObject({ path: '/orders/{id}', pathParams: { id: 'abc-123' } });
      const listed = (await api('GET', `/projects/${projectId}/runs/current/endpoints`, { token: alice.token })).body.items;
      const put = listed.find((e: any) => e.method === 'PUT');
      const chosen = await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { token: alice.token, body: { method: 'GET', path: '/x', endpointId: put.id } });
      expect(chosen.body.match.endpointId).toBe(put.id);
    });

    it('answers 404 with the nearest endpoints when nothing matches, and validates the request', async () => {
      const miss = await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { token: alice.token, body: { method: 'GET', path: '/orderz/1' } });
      expect(miss).toMatchObject({ status: 404, body: { code: 'no_matching_endpoint' } });
      expect(miss.body.detail).toContain('Closest:');
      expect((await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { token: alice.token, body: { method: 'GET!', path: '/x' } })).status).toBe(422);
      expect((await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { token: alice.token, body: { path: '/x' } })).status).toBe(422);
      expect((await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { body: { method: 'GET', path: '/orders/1' } })).status).toBe(401);
    });

    it('lets the Ask and voice tools follow an endpoint too', async () => {
      const res = await api('POST', `/projects/${projectId}/graph/query`, { token: alice.token, body: { op: 'endpoint', node: 'DELETE /orders/9' } });
      expect(res.status).toBe(200);
      expect(res.body.summary).toContain('DELETE /orders/9 is handled by DELETE /orders/{id}');
      expect(res.body.results.map((r: any) => r.node.address)).toContain('aws_dynamodb_table.orders');
    });

    it('searches nodes', async () => {
      const res = await api('GET', `/projects/${projectId}/runs/current/nodes?q=orders&kind=resource`, { token: alice.token });
      expect(res.body.items.map((n: any) => n.address)).toContain('aws_dynamodb_table.orders');
      const page = await api('GET', `/projects/${projectId}/runs/current/nodes?limit=5`, { token: alice.token });
      expect(page.body.items).toHaveLength(5);
      expect(page.body.nextCursor).toBeTruthy();
      const next = await api('GET', `/projects/${projectId}/runs/current/nodes?limit=5&cursor=${page.body.nextCursor}`, { token: alice.token });
      expect(next.body.items[0].address > page.body.items[4].address).toBe(true);
    });

    it('keeps one analysis per commit run, diffs them, and carries dismissals over', async () => {
      const findings = (await api('GET', `/projects/${projectId}/runs/${runId}/findings?kind=unmanaged_resource`, { token: alice.token })).body.items;
      const dismissed = await api('POST', `/projects/${projectId}/findings/${findings[0].id}/dismiss`, { token: alice.token });
      expect(dismissed.body.dismissedAt).toBeTruthy();
      expect(dismissed.body.dismissedBy.username).toBe('alice');

      const second = await api('POST', `/projects/${projectId}/runs`, { token: alice.token, body: { setAsCurrent: false } });
      expect(second.status).toBe(202);
      expect(second.headers.location).toContain(`/projects/${projectId}/runs/`);
      const secondId = second.body.id;
      const polled = await api('GET', `/projects/${projectId}/runs/${secondId}`, { token: alice.token });
      expect(polled.body).toMatchObject({ status: 'succeeded', isCurrent: false, commitSha: COMMIT, stage: null });
      expect((await api('GET', `/projects/${projectId}`, { token: alice.token })).body.currentRunId).toBe(runId);

      const carried = await api('GET', `/projects/${projectId}/runs/${secondId}/findings?dismissed=true`, { token: alice.token });
      expect(carried.body.items.map((f: any) => f.kind)).toEqual(['unmanaged_resource']);

      const runs = await api('GET', `/projects/${projectId}/runs?commitSha=${COMMIT}`, { token: alice.token });
      expect(runs.body.items).toHaveLength(2);

      const diff = await api('GET', `/projects/${projectId}/runs/${secondId}/diff?against=${runId}`, { token: alice.token });
      expect(diff.body).toMatchObject({ addedNodes: [], removedNodes: [], changedNodes: [], addedEdges: [], removedEdges: [] });

      // Change the code, analyze again, and the diff shows what moved.
      const original = fakes.github.files;
      fakes.github.files = original.filter((f) => f.path !== 'src/worker/main.py');
      const third = await api('POST', `/projects/${projectId}/runs`, { token: alice.token, body: {} });
      fakes.github.files = original;
      const changed = await api('GET', `/projects/${projectId}/runs/${secondId}/diff?against=${third.body.id}`, { token: alice.token });
      expect(changed.body.addedNodes.map((n: any) => n.address)).toContain('src/worker/main.py::handler');

      expect((await api('DELETE', `/projects/${projectId}/runs/${third.body.id}`, { token: alice.token })).status).toBe(409); // now current
      expect((await api('PUT', `/projects/${projectId}/current-run`, { token: alice.token, body: { runId } })).body.currentRunId).toBe(runId);
      expect((await api('DELETE', `/projects/${projectId}/runs/${third.body.id}`, { token: alice.token })).status).toBe(204);
      expect((await api('DELETE', `/projects/${projectId}/runs/${secondId}`, { token: alice.token })).status).toBe(204);
      expect((await api('GET', `/projects/${projectId}/runs/${secondId}`, { token: alice.token })).status).toBe(404);
    });

    it('records a failed run when the repository cannot be read', async () => {
      const original = fakes.github.downloadFiles.bind(fakes.github);
      fakes.github.downloadFiles = async () => {
        throw new Error('boom');
      };
      const res = await api('POST', `/projects/${projectId}/runs`, { token: alice.token, body: { setAsCurrent: true } });
      fakes.github.downloadFiles = original;
      expect(res.status).toBe(202);
      const run = await api('GET', `/projects/${projectId}/runs/${res.body.id}`, { token: alice.token });
      expect(run.body).toMatchObject({ status: 'failed', error: 'The analysis failed unexpectedly.' });
      expect((await api('GET', `/projects/${projectId}/runs/${res.body.id}/graph`, { token: alice.token })).body.code).toBe('run_not_ready');
      expect((await api('GET', `/projects/${projectId}`, { token: alice.token })).body.currentRunId).toBe(runId); // a failure never replaces the good run
      await api('DELETE', `/projects/${projectId}/runs/${res.body.id}`, { token: alice.token });
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('terraform plans, explanations and voice', () => {
    let planId = '';
    const plan = {
      format_version: '1.2',
      terraform_version: '1.9.5',
      resource_changes: [
        { address: 'aws_dynamodb_table.orders', type: 'aws_dynamodb_table', change: { actions: ['delete', 'create'], before: { name: 'orders-prod', secret_note: 'HUNTER2' }, after: { name: 'orders-v2', secret_note: 'HUNTER3' }, after_unknown: { arn: true } } },
        { address: 'aws_s3_bucket.site', type: 'aws_s3_bucket', change: { actions: ['update'], before: { tags: {} }, after: { tags: { a: 'b' } } } },
        { address: 'aws_sqs_queue.jobs', type: 'aws_sqs_queue', change: { actions: ['no-op'] } },
      ],
    };

    it('overlays a plan: red for replace/destroy, amber for everything downstream', async () => {
      const res = await api('POST', `/projects/${projectId}/runs/current/plans`, { token: alice.token, body: plan });
      expect(res.status).toBe(201);
      planId = res.body.id;
      expect(res.body.summary).toMatchObject({ replace: 1, update: 1, create: 0, destroy: 0 });
      const direct = res.body.changes.filter((c: any) => c.impact === 'direct');
      expect(direct.map((c: any) => [c.address, c.action])).toEqual(expect.arrayContaining([['aws_dynamodb_table.orders', 'replace'], ['aws_s3_bucket.site', 'update']]));
      expect(direct.find((c: any) => c.address === 'aws_dynamodb_table.orders').changedAttributes).toEqual(['arn', 'name', 'secret_note']);
      const downstream = res.body.changes.filter((c: any) => c.impact === 'downstream').map((c: any) => c.address);
      expect(downstream).toEqual(expect.arrayContaining(['src/api/app.js::getOrder', 'src/api/app.js::cancelOrder', 'src/worker/main.py::process', 'aws_lambda_function.api']));
      expect(downstream).not.toContain('aws_s3_bucket.site');
      // Plan values are never stored or returned.
      expect(JSON.stringify(res.body)).not.toContain('HUNTER');
      const stored = await getPool().query("SELECT count(*)::int AS n FROM plan_changes WHERE changed_attributes::text LIKE '%HUNTER%' OR address LIKE '%HUNTER%'");
      expect(stored.rows[0].n).toBe(0);
    });

    it('rejects something that is not a plan', async () => {
      expect((await api('POST', `/projects/${projectId}/runs/current/plans`, { token: alice.token, body: { hello: 'world' } })).status).toBe(422);
    });

    it('lists and fetches plans', async () => {
      expect((await api('GET', `/projects/${projectId}/plans`, { token: alice.token })).body.items[0]).toMatchObject({ id: planId, hasExplanation: false, hasBriefing: false });
      expect((await api('GET', `/projects/${projectId}/plans/${planId}`, { token: alice.token })).body.changes.length).toBeGreaterThan(3);
    });

    it('explains the plan (rule-based when Gemini is not configured) and caches it', async () => {
      const first = await api('POST', `/projects/${projectId}/plans/${planId}/explain`, { token: alice.token });
      expect(first.status).toBe(200);
      expect(first.body.model).toBe('rule-based');
      expect(first.body.explanation).toContain('replaces aws_dynamodb_table.orders');
      expect(first.body.risks[0]).toMatchObject({ address: 'aws_dynamodb_table.orders', severity: 'high' });
      expect(first.body.saferAlternatives[0].suggestion).toMatch(/migrate the data/);
      const second = await api('POST', `/projects/${projectId}/plans/${planId}/explain`, { token: alice.token });
      expect(second.body.generatedAt).toBe(first.body.generatedAt);
      const refreshed = await api('POST', `/projects/${projectId}/plans/${planId}/explain?refresh=true`, { token: alice.token });
      expect(refreshed.body.generatedAt).not.toBe(first.body.generatedAt);
    });

    it('produces a spoken briefing that says to stop', async () => {
      const res = await api('POST', `/projects/${projectId}/plans/${planId}/briefing`, { token: alice.token });
      expect(res.status).toBe(200);
      expect(res.body.recommendation).toBe('stop');
      expect(res.body.script).toContain("I'd stop here");
      expect(res.body.audioUrl).toContain(`briefings/${projectId}/${planId}.mp3`);
      expect(fakes.audioFiles.get(`briefings/${projectId}/${planId}.mp3`)?.toString()).toContain('mp3:');
      expect((await api('GET', `/projects/${projectId}/plans`, { token: alice.token })).body.items[0].hasBriefing).toBe(true);
    });

    it('needs Gemini for free-form questions, and says so', async () => {
      const res = await api('POST', `/projects/${projectId}/ask`, { token: alice.token, body: { question: 'what touches orders?' } });
      expect(res).toMatchObject({ status: 503, body: { code: 'integration_not_configured' } });
    });

    it('answers questions with Gemini function calling over the graph', async () => {
      let turn = 0;
      fakes.gemini.configured = true;
      fakes.gemini.generate = (async (request: any) => {
        turn++;
        if (turn === 1) {
          return { text: null, functionCalls: [{ name: 'graph_query', args: { op: 'touches', node: 'orders' } }], content: { role: 'model', parts: [{ functionCall: { name: 'graph_query', args: { op: 'touches', node: 'orders' } } }] } };
        }
        const toolResult = request.contents.at(-1).parts[0].functionResponse.response;
        return { text: `It is touched by ${toolResult.nodes.length} things.`, functionCalls: [], content: { role: 'model', parts: [] } };
      }) as never;
      const res = await api('POST', `/projects/${projectId}/ask`, { token: alice.token, body: { question: 'what touches orders?' } });
      fakes.gemini.configured = false;
      expect(res.status).toBe(200);
      expect(res.body.answer).toMatch(/^It is touched by \d+ things\.$/);
      expect(res.body.toolCalls).toEqual([{ op: 'touches', node: 'orders' }]);
      expect(res.body.citedNodeIds.length).toBeGreaterThan(2);
    });

    it('opens a voice session whose tool token only works for graph queries on that project', async () => {
      const session = await api('POST', `/projects/${projectId}/voice/session`, { token: alice.token, body: { planId } });
      expect(session.status).toBe(201);
      expect(session.body).toMatchObject({ signedUrl: 'wss://elevenlabs.test/session', agentId: 'agent-1' });
      expect(session.body.dynamicVariables.project_name).toBe('Orders platform');

      const query = await api('POST', '/voice/tools/graph-query', { token: session.body.toolToken, body: { op: 'dependents', node: 'orders' } });
      expect(query.status).toBe(200);
      expect(query.body.summary).toContain('[plan:'); // the session's plan annotates results
      expect(query.body.summary).toContain('aws_dynamodb_table.orders [plan: replace]');

      expect((await api('POST', '/voice/tools/graph-query', { token: alice.token, body: { op: 'dependents', node: 'orders' } })).status).toBe(401); // a user token is not a tool token
      expect((await api('GET', '/me', { token: session.body.toolToken })).status).toBe(401); // and the reverse
      expect((await api('POST', '/voice/tools/graph-query', { body: { op: 'dependents', node: 'orders' } })).status).toBe(401);
    });

    it('deletes a plan', async () => {
      expect((await api('DELETE', `/projects/${projectId}/plans/${planId}`, { token: alice.token })).status).toBe(204);
      expect((await api('GET', `/projects/${projectId}/plans/${planId}`, { token: alice.token })).status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('sharing and roles', () => {
    let inviteToken = '';

    it('hides projects from non-members', async () => {
      expect((await api('GET', `/projects/${projectId}`, { token: bob.token })).status).toBe(404);
      expect((await api('GET', `/projects/${projectId}/runs/current/graph`, { token: carol.token })).status).toBe(404);
    });

    it('invites by email and lets the invitee join with the right role', async () => {
      const invite = await api('POST', `/projects/${projectId}/invites`, { token: alice.token, body: { email: 'Bob@Example.com', role: 'viewer' } });
      expect(invite.status).toBe(201);
      expect(invite.body.email).toBe('bob@example.com');
      inviteToken = new URL(invite.body.inviteUrl).pathname.split('/').pop()!;

      expect((await api('POST', `/projects/${projectId}/invites`, { token: alice.token, body: { email: 'bob@example.com', role: 'editor' } }))).toMatchObject({ status: 409, body: { code: 'invite_pending' } });
      expect((await api('GET', `/projects/${projectId}/invites`, { token: alice.token })).body.items).toHaveLength(1);
      expect((await api('GET', `/projects/${projectId}/invites`, { token: bob.token })).status).toBe(404);

      const preview = await api('GET', `/invites/${inviteToken}`);
      expect(preview.body).toMatchObject({ projectName: 'Orders platform', role: 'viewer', invitedBy: { username: 'alice' } });
      expect((await api('POST', `/invites/${inviteToken}/accept`)).status).toBe(401);
      const accepted = await api('POST', `/invites/${inviteToken}/accept`, { token: bob.token });
      expect(accepted.body).toMatchObject({ id: projectId, myRole: 'viewer', memberCount: 2 });
      expect((await api('GET', `/invites/${inviteToken}`)).status).toBe(410);
      expect((await api('POST', `/invites/${inviteToken}/accept`, { token: bob.token })).status).toBe(410);
    });

    it('enforces viewer limits: read yes, change no, no activity log', async () => {
      expect((await api('GET', `/projects/${projectId}/runs/current/graph`, { token: bob.token })).status).toBe(200);
      expect((await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { token: bob.token, body: { method: 'GET', path: '/orders/1' } })).status).toBe(200);
      expect((await api('GET', `/projects/${projectId}/members`, { token: bob.token })).body.items.map((m: any) => [m.user.username, m.role])).toEqual([['alice', 'owner'], ['bob', 'viewer']]);
      expect((await api('POST', `/projects/${projectId}/runs`, { token: bob.token, body: {} })).status).toBe(403);
      expect((await api('POST', `/projects/${projectId}/runs/current/plans`, { token: bob.token, body: {} })).status).toBe(403);
      expect((await api('PATCH', `/projects/${projectId}`, { token: bob.token, body: { name: 'hax' } })).status).toBe(403);
      expect((await api('GET', `/projects/${projectId}/activity`, { token: bob.token })).status).toBe(403);
      expect((await api('POST', `/projects/${projectId}/ask`, { token: bob.token, body: { question: 'hi' } })).status).toBe(403);
      expect((await api('GET', `/projects/${projectId}/sharing`, { token: bob.token })).status).toBe(403);
    });

    it('promotes a member to editor, who can analyze but not manage', async () => {
      const res = await api('PATCH', `/projects/${projectId}/members/${bob.id}`, { token: alice.token, body: { role: 'editor' } });
      expect(res.body.role).toBe('editor');
      expect((await api('POST', `/projects/${projectId}/runs`, { token: bob.token, body: { setAsCurrent: false } })).status).toBe(202);
      expect((await api('GET', `/projects/${projectId}/activity`, { token: bob.token })).status).toBe(200);
      expect((await api('POST', `/projects/${projectId}/invites`, { token: bob.token, body: { email: 'x@example.com', role: 'viewer' } })).status).toBe(403);
      expect((await api('PATCH', `/projects/${projectId}/members/${alice.id}`, { token: alice.token, body: { role: 'viewer' } }))).toMatchObject({ status: 409, body: { code: 'owner_role_fixed' } });
      // clean up the extra run so later assertions about the run list stay simple
      const runs = (await api('GET', `/projects/${projectId}/runs`, { token: alice.token })).body.items;
      for (const r of runs.filter((x: any) => !x.isCurrent)) await api('DELETE', `/projects/${projectId}/runs/${r.id}`, { token: alice.token });
    });

    it('shares a read-only link that works without an account until it is rotated', async () => {
      expect((await api('GET', `/projects/${projectId}`, { shareToken: 'whatever' })).status).toBe(404);
      const sharing = await api('PUT', `/projects/${projectId}/sharing`, { token: alice.token, body: { visibility: 'link_view' } });
      expect(sharing.body.visibility).toBe('link_view');
      const token = sharing.body.shareToken as string;
      expect(sharing.body.shareUrl).toContain(token);

      const viaLink = await api('GET', `/projects/${projectId}`, { shareToken: token });
      expect(viaLink.body).toMatchObject({ id: projectId, myRole: null });
      expect((await api('GET', `/projects/${projectId}/runs/current/graph`, { shareToken: token })).status).toBe(200);
      expect((await api('GET', `/projects/${projectId}/runs/current/endpoints`, { shareToken: token })).body.items).toHaveLength(5);
      expect((await api('POST', `/projects/${projectId}/runs/current/endpoints/trace`, { shareToken: token, body: { method: 'GET', path: '/orders/1' } })).status).toBe(200);
      expect((await api('GET', `/projects/${projectId}/runs/current/findings`, { shareToken: token })).body.items.length).toBeGreaterThan(0);
      expect((await api('GET', `/shared/${token}`)).body.id).toBe(projectId);
      // read-only, and nothing about people or history
      expect((await api('POST', `/projects/${projectId}/runs`, { shareToken: token, body: {} })).status).toBe(401);
      expect((await api('GET', `/projects/${projectId}/members`, { shareToken: token })).status).toBe(401);
      expect((await api('GET', `/projects/${projectId}/activity`, { shareToken: token })).status).toBe(401);

      const rotated = await api('POST', `/projects/${projectId}/sharing/rotate`, { token: alice.token });
      expect(rotated.body.shareToken).not.toBe(token);
      expect((await api('GET', `/projects/${projectId}`, { shareToken: token })).status).toBe(404);
      expect((await api('GET', `/shared/${token}`)).status).toBe(404);
      expect((await api('GET', `/projects/${projectId}`, { shareToken: rotated.body.shareToken })).status).toBe(200);

      await api('PUT', `/projects/${projectId}/sharing`, { token: alice.token, body: { visibility: 'private' } });
      expect((await api('GET', `/projects/${projectId}`, { shareToken: rotated.body.shareToken })).status).toBe(404);
    });

    it('transfers ownership, which demotes the old owner', async () => {
      expect((await api('POST', `/projects/${projectId}/transfer-ownership`, { token: alice.token, body: { userId: carol.id } })).status).toBe(404); // not a member
      const res = await api('POST', `/projects/${projectId}/transfer-ownership`, { token: alice.token, body: { userId: bob.id } });
      expect(res.body.items.map((m: any) => [m.user.username, m.role])).toEqual([['bob', 'owner'], ['alice', 'editor']]);
      expect((await api('GET', `/projects/${projectId}/sharing`, { token: alice.token })).status).toBe(403);
      expect((await api('GET', `/projects/${projectId}/sharing`, { token: bob.token })).status).toBe(200);
      expect((await api('POST', `/projects/${projectId}/leave`, { token: bob.token }))).toMatchObject({ status: 409, body: { code: 'owner_cannot_leave' } });
    });

    it('lets members leave and owners remove members', async () => {
      expect((await api('POST', `/projects/${projectId}/leave`, { token: alice.token })).status).toBe(204);
      expect((await api('GET', `/projects/${projectId}`, { token: alice.token })).status).toBe(404);
      const invite = await api('POST', `/projects/${projectId}/invites`, { token: bob.token, body: { email: 'carol@example.com', role: 'viewer' } });
      const token = new URL(invite.body.inviteUrl).pathname.split('/').pop()!;
      await api('POST', `/invites/${token}/accept`, { token: carol.token });
      expect((await api('DELETE', `/projects/${projectId}/members/${bob.id}`, { token: bob.token }))).toMatchObject({ status: 409, body: { code: 'cannot_remove_owner' } });
      expect((await api('DELETE', `/projects/${projectId}/members/${carol.id}`, { token: bob.token })).status).toBe(204);
      expect((await api('GET', `/projects/${projectId}`, { token: carol.token })).status).toBe(404);
      const revoked = await api('POST', `/projects/${projectId}/invites`, { token: bob.token, body: { email: 'dave@example.com', role: 'viewer' } });
      const pending = await api('GET', `/projects/${projectId}/invites`, { token: bob.token });
      expect((await api('DELETE', `/projects/${projectId}/invites/${pending.body.items[0].id}`, { token: bob.token })).status).toBe(204);
      expect(revoked.status).toBe(201);
      expect((await api('GET', `/invites/${new URL(revoked.body.inviteUrl).pathname.split('/').pop()}`)).status).toBe(410);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('activity log', () => {
    it('recorded who did what, in order, for project members to read', async () => {
      const res = await api('GET', `/projects/${projectId}/activity?limit=100`, { token: bob.token });
      const actions = res.body.items.map((e: any) => e.action);
      for (const expected of [
        'project.created', 'repository.linked', 'analysis.started', 'analysis.succeeded', 'analysis.failed', 'analysis.deleted',
        'finding.dismissed', 'plan.uploaded', 'plan.deleted', 'invite.created', 'invite.accepted', 'member.added', 'member.role_changed',
        'project.visibility_changed', 'project.share_link_rotated', 'project.ownership_transferred', 'member.left', 'member.removed', 'invite.revoked',
      ]) {
        expect(actions, expected).toContain(expected);
      }
      const ids = res.body.items.map((e: any) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a)); // newest first
      expect(res.body.items.find((e: any) => e.action === 'member.role_changed')).toMatchObject({ actor: { username: 'alice' }, metadata: { user: 'bob', from: 'viewer', to: 'editor' } });
      expect(JSON.stringify(res.body)).not.toMatch(/token|password|HUNTER/i);

      const filtered = await api('GET', `/projects/${projectId}/activity?action=member.*`, { token: bob.token });
      expect(filtered.body.items.every((e: any) => e.action.startsWith('member.'))).toBe(true);
      const byActor = await api('GET', `/projects/${projectId}/activity?actorId=${alice.id}&limit=2`, { token: bob.token });
      expect(byActor.body.items).toHaveLength(2);
      expect(byActor.body.nextCursor).toBeTruthy();
    });

    it('keeps account-level events for the user', async () => {
      const res = await api('GET', '/me/activity', { token: alice.token });
      expect(res.body.items.map((e: any) => e.action)).toEqual(expect.arrayContaining(['user.signed_in', 'user.password_changed', 'github.connected']));
      expect(res.body.items.every((e: any) => e.projectId === null)).toBe(true);
    });

    it('cannot be edited', async () => {
      await expect(getPool().query("UPDATE activity_log SET action = 'x.y'")).rejects.toThrow(/append-only/);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('project lifecycle and account deletion', () => {
    it('archives, trashes, restores and permanently deletes (owner only)', async () => {
      expect((await api('POST', `/projects/${projectId}/archive`, { token: alice.token })).status).toBe(404); // alice left; she is nobody here
      expect((await api('POST', `/projects/${projectId}/archive`, { token: bob.token })).body.archivedAt).toBeTruthy();
      expect((await api('POST', `/projects/${projectId}/archive`, { token: bob.token })).status).toBe(409);
      expect((await api('GET', '/projects', { token: bob.token })).body.items).toHaveLength(0);
      expect((await api('GET', '/projects?scope=archived', { token: bob.token })).body.items).toHaveLength(1);
      expect((await api('GET', `/projects/${projectId}`, { token: bob.token })).status).toBe(200); // archived is still viewable
      expect((await api('POST', `/projects/${projectId}/restore`, { token: bob.token })).body.archivedAt).toBeNull();
      expect((await api('POST', `/projects/${projectId}/restore`, { token: bob.token })).status).toBe(409);

      expect((await api('DELETE', `/projects/${projectId}/permanent`, { token: bob.token })).status).toBe(409); // not in the trash yet
      expect((await api('DELETE', `/projects/${projectId}`, { token: bob.token })).status).toBe(204);
      expect((await api('GET', `/projects/${projectId}`, { token: bob.token })).status).toBe(404);
      expect((await api('GET', '/projects?scope=trash', { token: bob.token })).body.items.map((p: any) => p.id)).toEqual([projectId]);
      expect((await api('POST', `/projects/${projectId}/restore`, { token: bob.token })).body.deletedAt).toBeNull();
      expect((await api('GET', `/projects/${projectId}`, { token: bob.token })).status).toBe(200);

      await api('DELETE', `/projects/${projectId}`, { token: bob.token });
      expect((await api('DELETE', `/projects/${projectId}/permanent`, { token: bob.token })).status).toBe(204);
      const gone = await getPool().query('SELECT (SELECT count(*) FROM projects)::int AS projects, (SELECT count(*) FROM graph_nodes)::int AS nodes, (SELECT count(*) FROM analysis_runs)::int AS runs');
      expect(gone.rows[0]).toEqual({ projects: 0, nodes: 0, runs: 0 });
      const kept = await getPool().query("SELECT count(*)::int AS n FROM activity_log WHERE project_id IS NULL AND metadata->>'name' = 'Orders platform' AND action = 'project.deleted'");
      expect(kept.rows[0].n).toBeGreaterThanOrEqual(2); // the trash and purge entries survive the purge
    });

    it('refuses to delete an account that still owns projects, then soft-deletes it', async () => {
      const created = await api('POST', '/projects', { token: carol.token, body: { name: 'Carol project' } });
      expect(created.status).toBe(201);
      expect((await api('DELETE', '/me', { token: carol.token, body: { password: 'wrong' } })).status).toBe(401);
      expect((await api('DELETE', '/me', { token: carol.token, body: { password: 'carol has a passphrase' } }))).toMatchObject({ status: 409, body: { code: 'owns_projects' } });
      await api('DELETE', `/projects/${created.body.id}`, { token: carol.token });
      expect((await api('DELETE', `/projects/${created.body.id}/permanent`, { token: carol.token })).status).toBe(204);

      expect((await api('DELETE', '/me', { token: carol.token, body: { password: 'carol has a passphrase' } })).status).toBe(204);
      expect((await api('GET', '/me', { token: carol.token })).status).toBe(401); // the old token stops working
      expect((await api('POST', '/auth/login', { body: { identifier: 'carol', password: 'carol has a passphrase' } })).status).toBe(401);
      // The username and the GitHub account are free to use again.
      const row = await getPool().query("SELECT count(*)::int AS n FROM github_connections WHERE github_login = 'carol-gh'");
      expect(row.rows[0].n).toBe(0);
      expect((await register('carol')).id).not.toBe(carol.id);
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  describe('platform behaviour', () => {
    it('serves health and the resource catalog publicly', async () => {
      expect((await api('GET', '/health')).body).toEqual({ status: 'ok' });
      const types = await api('GET', '/resource-types');
      expect(types.headers['cache-control']).toContain('max-age');
      expect(types.body.items.find((t: any) => t.terraformType === 'aws_lambda_function')).toMatchObject({ iconKey: 'aws/lambda', displayName: 'Lambda Function' });
    });

    it('answers unknown routes and bad JSON with problem details', async () => {
      const missing = await api('GET', '/nope');
      expect(missing).toMatchObject({ status: 404, body: { code: 'route_not_found' } });
      const bad = await app.inject({ method: 'POST', url: '/auth/login', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.9' }, payload: '{not json' });
      expect(bad.statusCode).toBe(400);
      expect(JSON.parse(bad.body).code).toBe('bad_request');
      expect((await api('GET', '/projects/not-a-uuid', { token: bob.token })).status).toBe(422);
    });

    it('rate-limits the sign-in endpoints', async () => {
      const statuses: number[] = [];
      let limited: Reply | undefined;
      for (let i = 0; i < 14; i++) {
        const res = await api('POST', '/auth/login', { ip: '10.77.0.1', body: { identifier: 'ghost', password: 'nope nope nope' } });
        statuses.push(res.status);
        if (res.status === 429) limited ??= res;
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(limited?.body.code).toBe('rate_limited');
      expect(limited?.headers['retry-after']).toBeTruthy();
    });

    it('uses CORS headers that allow the Authorization header and PATCH/DELETE', async () => {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/projects/x',
        headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'authorization,x-share-token' },
      });
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-methods']).toContain('DELETE');
      expect(res.headers['access-control-allow-headers']).toContain('authorization');
    });
  });
});
