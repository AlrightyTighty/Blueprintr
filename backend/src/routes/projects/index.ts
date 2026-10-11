import { perUserLimit } from '../../http/rateLimits.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser, userActor } from '../../http/context.js';
import { pageQuery, parse, projectParams, projectRoleEnum, uuid } from '../../http/validation.js';
import * as projects from '../../services/projects.js';

import { linkRepositorySchema as linkRepository } from '../repositories/linkInput.js';

const routes: FastifyPluginAsync = async (app) => {
  app.get('/projects', async (req) => {
    const query = parse(
      pageQuery.extend({
        scope: z.enum(['active', 'archived', 'trash']).default('active'),
        role: projectRoleEnum.optional(),
        q: z.string().max(100).optional(),
      }),
      req.query,
    );
    return projects.listProjects(requireUser(req), query);
  });

  app.post('/projects', perUserLimit(10), async (req, reply) => {
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(100),
        description: z.string().max(1000).optional(),
        repositories: z.array(linkRepository).max(10).optional(),
        analyze: z.boolean().default(false),
      }),
      req.body,
    );
    return reply.code(201).send(await projects.createProject(requireUser(req), body));
  });

  app.get('/projects/:projectId', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return projects.getProject(actorOf(req, { allowShare: true }), projectId);
  });

  app.patch('/projects/:projectId', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    const body = parse(
      z
        .object({ name: z.string().trim().min(1).max(100).optional(), description: z.string().max(1000).nullable().optional() })
        .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change'),
      req.body,
    );
    return projects.updateProject(userActor(req), projectId, body);
  });

  app.delete('/projects/:projectId', async (req, reply) => {
    const { projectId } = parse(projectParams, req.params);
    await projects.deleteProject(userActor(req), projectId);
    return reply.code(204).send();
  });

  app.post('/projects/:projectId/archive', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return projects.archiveProject(userActor(req), projectId);
  });

  app.post('/projects/:projectId/restore', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return projects.restoreProject(userActor(req), projectId);
  });

  app.delete('/projects/:projectId/permanent', async (req, reply) => {
    const { projectId } = parse(projectParams, req.params);
    await projects.purgeProject(userActor(req), projectId);
    return reply.code(204).send();
  });

  app.post('/projects/:projectId/leave', async (req, reply) => {
    const { projectId } = parse(projectParams, req.params);
    await projects.leaveProject(userActor(req), projectId);
    return reply.code(204).send();
  });

  app.post('/projects/:projectId/transfer-ownership', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    const { userId } = parse(z.object({ userId: uuid }), req.body);
    return projects.transferOwnership(userActor(req), projectId, userId);
  });
};

export default routes;
