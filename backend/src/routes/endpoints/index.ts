import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf } from '../../http/context.js';
import { parse, projectParams, runRef, uuid } from '../../http/validation.js';
import * as endpoints from '../../services/endpoints.js';

const runParams = projectParams.extend({ runId: runRef });

const traceBody = z.object({
  method: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3,10}$/, 'An HTTP method such as GET')
    .transform((m) => m.toUpperCase()),
  path: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .transform((p) => (p.startsWith('/') ? p : `/${p}`)),
  endpointId: uuid.optional(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.get('/projects/:projectId/runs/:runId/endpoints', async (req) => {
    const { projectId, runId } = parse(runParams, req.params);
    return endpoints.listEndpoints(actorOf(req, { allowShare: true }), projectId, runId);
  });

  app.post('/projects/:projectId/runs/:runId/endpoints/trace', async (req) => {
    const { projectId, runId } = parse(runParams, req.params);
    return endpoints.traceEndpoint(actorOf(req, { allowShare: true }), projectId, runId, parse(traceBody, req.body));
  });
};

export default routes;
