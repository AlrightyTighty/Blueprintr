import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { userActor } from '../../http/context.js';
import { pageQuery, parse, projectParams, uuid } from '../../http/validation.js';
import * as activity from '../../services/activity.js';

const routes: FastifyPluginAsync = async (app) => {
  app.get('/projects/:projectId/activity', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    const query = parse(pageQuery.extend({ action: z.string().max(100).optional(), actorId: uuid.optional() }), req.query);
    return activity.listProjectActivity(userActor(req), projectId, query);
  });
};

export default routes;
