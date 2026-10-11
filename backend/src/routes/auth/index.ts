import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../../http/context.js';
import { email, parse, password, username } from '../../http/validation.js';
import * as auth from '../../services/auth.js';

// Sign-in and recovery endpoints are the obvious targets for guessing, so they get a tight limit.
const limited = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

const routes: FastifyPluginAsync = async (app) => {
  app.post('/auth/register', limited(10), async (req, reply) => {
    const body = parse(z.object({ username, email, password, displayName: z.string().max(100).optional() }), req.body);
    return reply.code(201).send(await auth.register(body));
  });

  app.post('/auth/login', limited(10), async (req) => {
    const body = parse(z.object({ identifier: z.string().min(1).max(254), password: z.string().min(1).max(128) }), req.body);
    return auth.login(body);
  });

  app.get('/auth/github/authorize', limited(30), async (req) => {
    const { intent } = parse(z.object({ intent: z.enum(['login', 'signup', 'link']) }), req.query);
    return auth.githubAuthorize(intent, req.userId);
  });

  app.post('/auth/github/callback', limited(20), async (req) => {
    const body = parse(z.object({ code: z.string().min(1), state: z.string().min(1) }), req.body);
    return auth.githubCallback(body, req.userId);
  });

  app.post('/auth/github/complete', limited(10), async (req, reply) => {
    const body = parse(
      z.object({ registrationToken: z.string().min(1), username, email, password, displayName: z.string().max(100).optional() }),
      req.body,
    );
    return reply.code(201).send(await auth.githubComplete(body));
  });

  app.post('/auth/email/verify', limited(20), async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(1) }), req.body);
    await auth.verifyEmail(token);
    return reply.code(204).send();
  });

  app.post('/auth/email/resend', limited(5), async (req, reply) => {
    await auth.resendVerification(requireUser(req));
    return reply.code(202).send();
  });

  app.post('/auth/password/forgot', limited(5), async (req, reply) => {
    const { email: address } = parse(z.object({ email }), req.body);
    await auth.forgotPassword(address);
    return reply.code(202).send();
  });

  app.post('/auth/password/reset', limited(10), async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(1), password }), req.body);
    await auth.resetPassword(body);
    return reply.code(204).send();
  });
};

export default routes;
