import { perUserLimit } from '../../http/rateLimits.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { actorOf, requireUser, userActor } from '../../http/context.js';
import { email, invitableRoleEnum, parse, projectParams, uuid } from '../../http/validation.js';
import * as sharing from '../../services/sharing.js';

const tokenParams = z.object({ token: z.string().min(1).max(200) });

const routes: FastifyPluginAsync = async (app) => {
  // Share link
  app.get('/projects/:projectId/sharing', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return sharing.getSharing(userActor(req), projectId);
  });

  app.put('/projects/:projectId/sharing', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    const { visibility } = parse(z.object({ visibility: z.enum(['private', 'link_view']) }), req.body);
    return sharing.setSharing(userActor(req), projectId, visibility);
  });

  app.post('/projects/:projectId/sharing/rotate', perUserLimit(10), async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return sharing.rotateShareToken(userActor(req), projectId);
  });

  app.get('/shared/:shareToken', async (req) => {
    const { shareToken } = parse(z.object({ shareToken: z.string().min(1).max(200) }), req.params);
    return sharing.getSharedProject(shareToken);
  });

  // Members
  app.get('/projects/:projectId/members', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return sharing.listMembers(actorOf(req), projectId);
  });

  app.patch('/projects/:projectId/members/:userId', async (req) => {
    const { projectId, userId } = parse(projectParams.extend({ userId: uuid }), req.params);
    const { role } = parse(z.object({ role: invitableRoleEnum }), req.body);
    return sharing.updateMemberRole(userActor(req), projectId, userId, role);
  });

  app.delete('/projects/:projectId/members/:userId', async (req, reply) => {
    const { projectId, userId } = parse(projectParams.extend({ userId: uuid }), req.params);
    await sharing.removeMember(userActor(req), projectId, userId);
    return reply.code(204).send();
  });

  // Invitations
  app.get('/projects/:projectId/invites', async (req) => {
    const { projectId } = parse(projectParams, req.params);
    return sharing.listInvites(userActor(req), projectId);
  });

  app.post('/projects/:projectId/invites', perUserLimit(20), async (req, reply) => {
    const { projectId } = parse(projectParams, req.params);
    const body = parse(z.object({ email, role: invitableRoleEnum }), req.body);
    return reply.code(201).send(await sharing.createInvite(userActor(req), projectId, body));
  });

  app.delete('/projects/:projectId/invites/:inviteId', async (req, reply) => {
    const { projectId, inviteId } = parse(projectParams.extend({ inviteId: uuid }), req.params);
    await sharing.revokeInvite(userActor(req), projectId, inviteId);
    return reply.code(204).send();
  });

  app.get('/invites/:token', async (req) => sharing.previewInvite(parse(tokenParams, req.params).token));

  app.post('/invites/:token/accept', async (req) => sharing.acceptInvite(requireUser(req), parse(tokenParams, req.params).token));
};

export default routes;
