import { perUserLimit } from '../../http/rateLimits.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, userActor } from '../../http/context.js';
import { pageQuery, parse, projectParams, runRef, runStatusEnum, uuid } from '../../http/validation.js';
import * as analysis from '../../services/analysis.js';

const runParams = projectParams.extend({ runId: runRef });

const routes: FastifyPluginAsync = async (app) => {
  app.get('/projects/:projectId/runs', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    const query = parse(pageQuery.extend({ commitSha: z.string().max(64).optional(), status: runStatusEnum.optional() }), req.query);
    return analysis.listRuns(actorOf(req, { allowShare: true }), projectId, query);
  });

  app.post('/projects/:projectId/runs', perUserLimit(6), async (req, reply) => {
    const { projectId } = parse(projectParams, req.params);
    const body = parse(
      z.object({
        repositoryLinkId: uuid.optional(),
        commitSha: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, 'A full commit SHA').optional(),
        setAsCurrent: z.boolean().default(true),
      }),
      req.body ?? {},
    );
    const run = await analysis.startRun(userActor(req), projectId, body);
    return reply.code(202).header('Location', `/projects/${projectId}/runs/${run.id}`).send(run);
  });

  app.get('/projects/:projectId/runs/:runId', async (req) => {
    const { projectId, runId } = parse(runParams, req.params);
    return analysis.getRun(actorOf(req, { allowShare: true }), projectId, runId);
  });

  app.delete('/projects/:projectId/runs/:runId', async (req, reply) => {
    const { projectId, runId } = parse(runParams, req.params);
    await analysis.deleteRun(userActor(req), projectId, runId);
    return reply.code(204).send();
  });

  app.put('/projects/:projectId/current-run', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    const { runId } = parse(z.object({ runId: uuid }), req.body);
    return analysis.setCurrentRun(userActor(req), projectId, runId);
  });

  app.get('/projects/:projectId/runs/:runId/diff', async (req) => {
    const { projectId, runId } = parse(runParams, req.params);
    const { against } = parse(z.object({ against: uuid }), req.query);
    return analysis.diffRuns(actorOf(req, { allowShare: true }), projectId, runId, against);
  });
};

export default routes;
