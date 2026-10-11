import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../../config.js';
import { userActor } from '../../http/context.js';
import { perUserLimit } from '../../http/rateLimits.js';
import { unauthorized } from '../../http/errors.js';
import { parse, projectParams, queryBoolean, runRef, uuid } from '../../http/validation.js';
import { verifyToken } from '../../lib/jwt.js';
import * as ai from '../../services/ai.js';
import * as narration from '../../services/narration.js';

const planParams = projectParams.extend({ planId: uuid });
const refresh = z.object({ refresh: queryBoolean.default(false) });

const toolRequest = z.object({
  op: z.enum(['touches', 'dependents', 'dependencies', 'path', 'findings']),
  node: z.string().min(1).max(300),
  to: z.string().min(1).max(300).optional(),
  runId: runRef.optional(),
  maxDepth: z.number().int().min(1).max(20).optional(),
  planId: uuid.optional(),
});

const routes: FastifyPluginAsync = async (app) => {
  app.post('/projects/:projectId/plans/:planId/explain', perUserLimit(10), async (req) => {
    const { projectId, planId } = parse(planParams, req.params);
    return ai.explainPlan(userActor(req), projectId, planId, parse(refresh, req.query).refresh);
  });

  app.post('/projects/:projectId/plans/:planId/briefing', perUserLimit(5), async (req) => {
    const { projectId, planId } = parse(planParams, req.params);
    return ai.createBriefing(userActor(req), projectId, planId, parse(refresh, req.query).refresh);
  });

  app.post('/projects/:projectId/ask', perUserLimit(20), async (req) => {
    const { projectId } = parse(projectParams, req.params);
    const body = parse(z.object({ question: z.string().trim().min(1).max(1000), runId: runRef.default('current'), planId: uuid.optional() }), req.body);
    return ai.ask(userActor(req), projectId, body);
  });

  // Public on purpose: the demo works without an account. The daily character budget and a per-IP
  // rate limit keep it from being used to spend the ElevenLabs credits.
  app.post('/narrate', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { text } = parse(z.object({ text: z.string().trim().min(1).max(getConfig().NARRATION_MAX_CHARACTERS) }), req.body);
    const audio = await narration.narrate(text);
    return reply.type('audio/mpeg').header('Cache-Control', 'private, max-age=86400').send(audio);
  });

  app.post('/projects/:projectId/voice/session', perUserLimit(10), async (req, reply) => {
    const { projectId } = parse(projectParams, req.params);
    const body = parse(z.object({ runId: runRef.default('current'), planId: uuid.optional() }), req.body ?? {});
    return reply.code(201).send(await ai.createVoiceSession(userActor(req), projectId, body));
  });

  // Called by the ElevenLabs agent with the project-scoped token from createVoiceSession (not a user access token).
  app.post('/voice/tools/graph-query', perUserLimit(120), async (req) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const claims = await verifyToken<ai.VoiceToolClaims>(header.slice(7), 'voice_tool');
    return ai.voiceGraphQuery(claims as ai.VoiceToolClaims, parse(toolRequest, req.body));
  });
};

export default routes;
