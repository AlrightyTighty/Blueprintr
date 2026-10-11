import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { getPool } from '../src/db/pool.js';
import * as runs from '../src/repositories/analysisRuns.js';
import { createFakes } from './fakes.js';
import { createTestDatabase } from './db.js';

// Needs a Postgres server: TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/postgres npm test
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)('analyses that never finish, and starting too many', () => {
  let app: FastifyInstance;
  let dropDatabase: () => Promise<void>;
  const fakes = createFakes();
  let ipCounter = 0;
  let token = '';

  async function api(method: 'GET' | 'POST', url: string, body?: unknown) {
    const res = await app.inject({
      method,
      url,
      payload: body === undefined ? undefined : (body as object),
      headers: { 'x-forwarded-for': `10.4.0.${(ipCounter++ % 250) + 1}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  }

  /** A project with one finished analysis. */
  async function projectWithRun(name: string) {
    const project = await api('POST', '/projects', { name, repositories: [{ url: 'https://github.com/acme/website' }], analyze: true });
    expect(project.status).toBe(201);
    return { projectId: project.body.id as string, runId: project.body.currentRunId as string };
  }

  /** Pretends the run is in the middle of analysing, having begun `minutesAgo` minutes ago. */
  const makeRunning = (runId: string, minutesAgo: number, status: 'pending' | 'running' = 'running') =>
    getPool().query(
      `UPDATE analysis_runs SET status = $2, finished_at = NULL, error = NULL, started_at = now() - make_interval(mins => $3::int), created_at = now() - make_interval(mins => $3::int) WHERE id = $1`,
      [runId, status, minutesAgo],
    );

  beforeAll(async () => {
    dropDatabase = await createTestDatabase();
    app = buildApp({ integrations: fakes.integrations, logger: false, trustProxy: true });
    await app.ready();
    const res = await api('POST', '/auth/register', { username: 'riley', email: 'riley@example.com', password: 'correct horse battery' });
    token = res.body.token;
  });
  afterAll(async () => {
    await app?.close();
    await dropDatabase?.();
  });

  it('fails an analysis that has been "running" for too long, so nobody waits on it forever', async () => {
    const { projectId, runId } = await projectWithRun('Stuck');
    await makeRunning(runId, 60);

    const run = await api('GET', `/projects/${projectId}/runs/${runId}`);
    expect(run.body.status).toBe('failed');
    expect(run.body.error).toMatch(/stopped before it finished/);
  });

  it('also fails one that was queued but never started', async () => {
    const { projectId, runId } = await projectWithRun('Never started');
    await makeRunning(runId, 60, 'pending');

    const list = await api('GET', `/projects/${projectId}/runs?limit=1`);
    expect(list.body.items[0]).toMatchObject({ id: runId, status: 'failed' });
  });

  it('leaves a recent analysis alone', async () => {
    const { projectId, runId } = await projectWithRun('Busy');
    await makeRunning(runId, 1);
    expect((await api('GET', `/projects/${projectId}/runs/${runId}`)).body.status).toBe('running');
  });

  it('lets a new analysis start once the stuck one has been failed', async () => {
    const { projectId, runId } = await projectWithRun('Retry');
    await makeRunning(runId, 60);
    const started = await api('POST', `/projects/${projectId}/runs`, {});
    expect(started.status).toBe(202);
  });

  it('allows only one analysis at a time per project', async () => {
    const { projectId, runId } = await projectWithRun('Crowded');
    await makeRunning(runId, 1);
    const second = await api('POST', `/projects/${projectId}/runs`, {});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('analysis_in_progress');
  });

  it('keeps the previous good analysis as the current one when a newer one dies', async () => {
    const { projectId, runId } = await projectWithRun('Keeps its graph');
    const good = (await runs.findById(getPool(), projectId, runId))!;
    // A newer analysis that started and then got stuck. (It never became current, as only a success does.)
    const newer = await runs.create(getPool(), {
      projectId,
      repositoryId: good.repository?.id ?? null,
      rootPath: good.rootPath,
      commitSha: good.commitSha,
      branch: good.branch,
      parserVersion: good.parserVersion,
      startedBy: good.startedBy!.id,
      stats: {},
    });
    await makeRunning(newer.id, 60);

    expect((await api('GET', `/projects/${projectId}/runs/${newer.id}`)).body.status).toBe('failed');
    expect((await api('GET', `/projects/${projectId}`)).body.currentRunId).toBe(runId);
    expect((await api('GET', `/projects/${projectId}/runs/current/graph`)).status).toBe(200);
  });

  it('fails every unfinished run when the server restarts', async () => {
    const { runId } = await projectWithRun('Restarted');
    await makeRunning(runId, 0);
    const changed = await runs.failAllActive(getPool(), 'The server restarted while this analysis was running. Try again.');
    expect(changed).toBeGreaterThanOrEqual(1);
    const { rows } = await getPool().query('SELECT status, error FROM analysis_runs WHERE id = $1', [runId]);
    expect(rows[0]).toMatchObject({ status: 'failed' });
    expect(rows[0].error).toMatch(/server restarted/);
  });
});
