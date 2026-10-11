import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../http/context.js';
import { email, pageQuery, parse, password, username, uuid } from '../../http/validation.js';
import * as account from '../../services/account.js';

const routes: FastifyPluginAsync = async (app) => {
  app.get('/me', async (req) => account.getMe(requireUser(req)));

  app.patch('/me', async (req) => {
    const body = parse(
      z
        .object({
          username: username.optional(),
          email: email.optional(),
          displayName: z.string().max(100).nullable().optional(),
          avatarUrl: z.string().url().nullable().optional(),
        })
        .refine((v) => Object.keys(v).length > 0, 'Send at least one field to change'),
      req.body,
    );
    return account.updateMe(requireUser(req), body);
  });

  app.delete('/me', async (req, reply) => {
    const body = parse(z.object({ password: z.string().min(1) }), req.body);
    await account.deleteMe(requireUser(req), body.password);
    return reply.code(204).send();
  });

  app.post('/me/password', async (req, reply) => {
    const body = parse(z.object({ currentPassword: z.string().min(1), newPassword: password }), req.body);
    await account.changePassword(requireUser(req), body);
    return reply.code(204).send();
  });

  app.get('/me/activity', async (req) => account.listMyActivity(requireUser(req), parse(pageQuery, req.query)));

  app.get('/me/github-connections', async (req) => ({ items: await account.listGithubConnections(requireUser(req)) }));

  app.delete('/me/github-connections/:connectionId', async (req, reply) => {
    const { connectionId } = parse(z.object({ connectionId: uuid }), req.params);
    await account.deleteGithubConnection(requireUser(req), connectionId);
    return reply.code(204).send();
  });

  app.get('/me/github-connections/:connectionId/repositories', async (req) => {
    const { connectionId } = parse(z.object({ connectionId: uuid }), req.params);
    const query = parse(z.object({ q: z.string().max(100).optional(), cursor: z.string().max(10).optional() }), req.query);
    return account.listGithubRepositories(requireUser(req), connectionId, query);
  });
};

export default routes;
