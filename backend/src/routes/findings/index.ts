import type { FastifyPluginAsync } from 'fastify';
import { actorOf, userActor } from '../../http/context.js';
import { findingKindEnum, findingSeverityEnum, pageQuery, parse, projectParams, queryBoolean, runRef, uuid } from '../../http/validation.js';
import * as findings from '../../services/findings.js';

const findingParams = projectParams.extend({ findingId: uuid });

const routes: FastifyPluginAsync = async (app) => {
  app.get('/projects/:projectId/runs/:runId/findings', async (req) => {
    const { projectId, runId } = parse(projectParams.extend({ runId: runRef }), req.params);
    const query = parse(
      pageQuery.extend({ kind: findingKindEnum.optional(), severity: findingSeverityEnum.optional(), dismissed: queryBoolean.optional() }),
      req.query,
    );
    return findings.listFindings(actorOf(req, { allowShare: true }), projectId, runId, query);
  });

  app.post('/projects/:projectId/findings/:findingId/dismiss', async (req) => {
    const { projectId, findingId } = parse(findingParams, req.params);
    return findings.dismissFinding(userActor(req), projectId, findingId);
  });

  app.post('/projects/:projectId/findings/:findingId/restore', async (req) => {
    const { projectId, findingId } = parse(findingParams, req.params);
    return findings.restoreFinding(userActor(req), projectId, findingId);
  });
};

export default routes;
