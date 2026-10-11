import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../http/context.js';
import { confidenceEnum, nodeKindEnum, pageQuery, parse, projectParams, runRef, uuid } from '../../http/validation.js';
import { QUERY_OPS } from '../../core/graph/query.js';
import * as graph from '../../services/graph.js';

const runParams = projectParams.extend({ runId: runRef });
const nodeParams = runParams.extend({ nodeId: uuid });

const queryBody = z.object({
  op: z.enum(QUERY_OPS),
  node: z.string().min(1).max(300),
  to: z.string().min(1).max(300).optional(),
  runId: runRef.default('current'),
  maxDepth: z.number().int().min(1).max(20).optional(),
  planId: uuid.optional(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.get('/projects/:projectId/runs/:runId/graph', async (req) => {
    const { projectId, runId } = parse(runParams, req.params);
    return graph.getGraph(actorOf(req, { allowShare: true }), projectId, runId);
  });

  app.get('/projects/:projectId/runs/:runId/nodes', async (req) => {
    const { projectId, runId } = parse(runParams, req.params);
    const query = parse(pageQuery.extend({ kind: nodeKindEnum.optional(), terraformType: z.string().max(100).optional(), q: z.string().max(200).optional() }), req.query);
    return graph.searchNodes(actorOf(req, { allowShare: true }), projectId, runId, query);
  });

  app.get('/projects/:projectId/runs/:runId/nodes/:nodeId', async (req) => {
    const { projectId, runId, nodeId } = parse(nodeParams, req.params);
    return graph.getNodeDetail(actorOf(req, { allowShare: true }), projectId, runId, nodeId);
  });

  app.get('/projects/:projectId/runs/:runId/nodes/:nodeId/blast-radius', async (req) => {
    const { projectId, runId, nodeId } = parse(nodeParams, req.params);
    const query = parse(
      z.object({
        direction: z.enum(['dependents', 'dependencies', 'both']).default('dependents'),
        maxDepth: z.coerce.number().int().min(1).max(20).default(10),
        minConfidence: confidenceEnum.optional(),
      }),
      req.query,
    );
    return graph.getBlastRadius(actorOf(req, { allowShare: true }), projectId, runId, nodeId, query);
  });

  app.post('/projects/:projectId/graph/query', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return graph.queryGraph(actorOf(req, { allowShare: true }), projectId, parse(queryBody, req.body));
  });
};

export default routes;
