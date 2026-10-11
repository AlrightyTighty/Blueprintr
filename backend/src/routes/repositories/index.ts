import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, userActor } from '../../http/context.js';
import { parse, projectParams, uuid } from '../../http/validation.js';
import * as repositories from '../../services/repositories.js';

const linkParams = projectParams.extend({ linkId: uuid });

const routes: FastifyPluginAsync = async (app) => {
  app.get('/projects/:projectId/repositories', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return repositories.listLinks(actorOf(req, { allowShare: true }), projectId);
  });

  app.post('/projects/:projectId/repositories', async (req, reply) => {
    const { projectId } = parse(projectParams, req.params);
    const body = parse(
      z.object({
        connectionId: uuid,
        githubRepoId: z.number().int().positive(),
        branch: z.string().min(1).max(250).optional(),
        rootPath: z.string().max(500).optional(),
      }),
      req.body,
    );
    return reply.code(201).send(await repositories.linkRepository(userActor(req), projectId, body));
  });

  app.patch('/projects/:projectId/repositories/:linkId', async (req) => {
    const { projectId, linkId } = parse(linkParams, req.params);
    const body = parse(
      z
        .object({ branch: z.string().min(1).max(250).optional(), rootPath: z.string().max(500).optional(), connectionId: uuid.optional() })
        .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change'),
      req.body,
    );
    return repositories.updateLink(userActor(req), projectId, linkId, body);
  });

  app.delete('/projects/:projectId/repositories/:linkId', async (req, reply) => {
    const { projectId, linkId } = parse(linkParams, req.params);
    await repositories.unlinkRepository(userActor(req), projectId, linkId);
    return reply.code(204).send();
  });
};

export default routes;
