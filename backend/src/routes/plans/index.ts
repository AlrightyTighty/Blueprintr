import type { FastifyPluginAsync } from 'fastify';
import { getConfig } from '../../config.js';
import { actorOf, userActor } from '../../http/context.js';
import { pageQuery, parse, projectParams, runRef, uuid } from '../../http/validation.js';
import * as plans from '../../services/plans.js';

const planParams = projectParams.extend({ planId: uuid });

const routes: FastifyPluginAsync = async (app) => {
  // Plans can be several MB, so this route alone accepts a larger body than the default.
  app.post('/projects/:projectId/runs/:runId/plans', { bodyLimit: getConfig().MAX_PLAN_BYTES }, async (req, reply) => {
    const { projectId, runId } = parse(projectParams.extend({ runId: runRef }), req.params);
    return reply.code(201).send(await plans.uploadPlan(userActor(req), projectId, runId, req.body));
  });

  app.get('/projects/:projectId/plans', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return plans.listPlans(actorOf(req, { allowShare: true }), projectId, parse(pageQuery, req.query));
  });

  app.get('/projects/:projectId/plans/:planId', async (req) => {
    const { projectId, planId } = parse(planParams, req.params);
    return plans.getPlan(actorOf(req, { allowShare: true }), projectId, planId);
  });

  app.delete('/projects/:projectId/plans/:planId', async (req, reply) => {
    const { projectId, planId } = parse(planParams, req.params);
    await plans.deletePlan(userActor(req), projectId, planId);
    return reply.code(204).send();
  });
};

export default routes;
