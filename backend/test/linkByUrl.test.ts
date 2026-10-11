import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { COMMIT, createFakes } from './fakes.js';
import { createTestDatabase } from './db.js';

// Needs a Postgres server: TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres npm test
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('linking a repository by GitHub link', () => {
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
        'x-forwarded-for': `10.2.0.${(ipCounter++ % 250) + 1}`,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  async function register(username: string) {
    const res = await api('POST', '/auth/register', {
      body: { username, email: `${username}@example.com`, password: 'correct horse battery' },
    });
    return res.body.token as string;
  }

  async function connectGithub(token: string, code: string, githubId: number) {
    const start = await api('GET', '/auth/github/authorize?intent=link', { token });
    fakes.github.grantCode(code, { id: githubId, login: `${code}-gh`, name: null, email: null, avatarUrl: null });
    const linked = await api('POST', '/auth/github/callback', { token, body: { code, state: start.body.state } });
    return linked.body.connection.id as string;
  }

  /** Creates a project from links and returns the reply. */
  const createProject = (token: string, name: string, repositories: unknown[], analyze = false) =>
    api('POST', '/projects', { token, body: { name, repositories, analyze } });

  beforeAll(async () => {
    dropDatabase = await createTestDatabase();
    app = buildApp({ integrations: fakes.integrations, logger: false, trustProxy: true });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await dropDatabase?.();
  });
  beforeEach(() => {
    fakes.github.branches = null;
    fakes.github.downloadTokens = [];
  });

  it('links a public repository from its link, with no GitHub account connected', async () => {
    const token = await register('pat');
    const res = await createProject(token, 'Website', [{ url: 'https://github.com/acme/website' }]);
    expect(res.status).toBe(201);
    expect(res.body.repositories[0]).toMatchObject({
      branch: 'main',
      rootPath: '',
      linkedByConnectionId: null,
      repository: { fullName: 'acme/website', isPrivate: false },
    });
  });

  it('understands the usual ways of writing a GitHub link', async () => {
    const token = await register('lee');
    for (const [index, url] of ['github.com/acme/website', 'acme/website', 'git@github.com:acme/website.git', 'https://github.com/acme/website.git/'].entries()) {
      const res = await createProject(token, `Same repo ${index}`, [{ url }]);
      expect(res.status, url).toBe(201);
      expect(res.body.repositories[0].repository.fullName).toBe('acme/website');
    }
  });

  it('reads the branch and folder out of a /tree/ link', async () => {
    const token = await register('ana');
    fakes.github.branches = new Set(['main', 'feature/x']);
    const simple = await createProject(token, 'Folder', [{ url: 'https://github.com/acme/website/tree/main/infra' }]);
    expect(simple.body.repositories[0]).toMatchObject({ branch: 'main', rootPath: 'infra' });

    const slashed = await createProject(token, 'Slashed branch', [{ url: 'https://github.com/acme/website/tree/feature/x/infra/prod' }]);
    expect(slashed.body.repositories[0]).toMatchObject({ branch: 'feature/x', rootPath: 'infra/prod' });
  });

  it('lets an explicit branch and folder override the link', async () => {
    const token = await register('kim');
    const res = await createProject(token, 'Override', [{ url: 'https://github.com/acme/website/tree/main/infra', branch: 'main', rootPath: 'app' }]);
    expect(res.body.repositories[0]).toMatchObject({ branch: 'main', rootPath: 'app' });
  });

  it('explains a branch it cannot find', async () => {
    const token = await register('bobby');
    fakes.github.branches = new Set(['main']);
    const res = await createProject(token, 'Nope', [{ url: 'https://github.com/acme/website/tree/ghost/infra' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'url' });
  });

  it('refuses links that are not GitHub repositories', async () => {
    const token = await register('moe');
    for (const url of ['https://gitlab.com/acme/website', 'https://github.com.evil.example/acme/website', 'not a link', 'https://github.com/acme']) {
      const res = await createProject(token, 'Bad', [{ url }]);
      expect(res.status, url).toBe(422);
      expect(res.body.errors[0].field).toBe('url');
    }
  });

  it('says a private repository is not found when no account can see it', async () => {
    const token = await register('zed');
    const res = await createProject(token, 'Private', [{ url: 'https://github.com/acme/orders' }]);
    expect(res.status).toBe(422);
    expect(res.body.errors[0].message).toMatch(/connect your GitHub account/i);
    expect((await api('GET', '/projects', { token })).body.items).toHaveLength(0); // nothing was created
  });

  it('reads a private repository through the user connected account', async () => {
    const token = await register('eve');
    const connectionId = await connectGithub(token, 'eve-code', 3003);
    const res = await createProject(token, 'Orders', [{ url: 'https://github.com/acme/orders' }]);
    expect(res.status).toBe(201);
    expect(res.body.repositories[0]).toMatchObject({ linkedByConnectionId: connectionId, repository: { fullName: 'acme/orders', isPrivate: true } });
  });

  it('analyzes a public repository with no token at all', async () => {
    const token = await register('ivy');
    const res = await createProject(token, 'Public run', [{ url: 'https://github.com/acme/website' }], true);
    expect(res.status).toBe(201);
    expect(res.body.currentRun).toMatchObject({ status: 'succeeded', commitSha: COMMIT });
    expect(fakes.github.downloadTokens).toEqual([null]);
  });

  it('keeps a private repository linked by a connection analyzable, using that connection', async () => {
    const token = await register('max');
    await connectGithub(token, 'max-code', 4004);
    const res = await createProject(token, 'Private run', [{ url: 'https://github.com/acme/orders' }], true);
    expect(res.body.currentRun).toMatchObject({ status: 'succeeded' });
    expect(fakes.github.downloadTokens).toEqual(['token-max-code']);
  });

  it('fails the run with a clear reason when a repository has nothing to read', async () => {
    const token = await register('dee');
    const original = fakes.github.files;
    fakes.github.files = [];
    try {
      const res = await createProject(token, 'Empty repo', [{ url: 'https://github.com/acme/website' }], true);
      expect(res.status).toBe(201);
      expect(res.body.currentRun).toBeNull(); // a failed run never becomes current
      const runs = await api('GET', `/projects/${res.body.id}/runs`, { token });
      expect(runs.body.items[0]).toMatchObject({ status: 'failed' });
      expect(runs.body.items[0].error).toMatch(/No Terraform, Python or JavaScript\/TypeScript files were found/);
    } finally {
      fakes.github.files = original;
    }
  });

  it('can link a public repository to an existing project with the repositories endpoint', async () => {
    const token = await register('sue');
    const project = await createProject(token, 'Empty', []);
    const linked = await api('POST', `/projects/${project.body.id}/repositories`, { token, body: { url: 'https://github.com/acme/website' } });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({ linkedByConnectionId: null, repository: { fullName: 'acme/website' } });
    const twice = await api('POST', `/projects/${project.body.id}/repositories`, { token, body: { url: 'acme/website' } });
    expect(twice.status).toBe(409);
  });
});
