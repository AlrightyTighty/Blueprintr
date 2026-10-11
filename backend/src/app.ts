import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { getConfig } from './config.js';
import { getPool } from './db/pool.js';
import { AppError, tooManyRequests, unauthorized } from './http/errors.js';
import { createDefaultIntegrations, setIntegrations, type Integrations } from './integrations/registry.js';
import { verifyToken } from './lib/jwt.js';
import * as users from './repositories/users.js';
import accountRoutes from './routes/account/index.js';
import activityRoutes from './routes/activity/index.js';
import aiRoutes from './routes/ai/index.js';
import analysisRoutes from './routes/analysis/index.js';
import authRoutes from './routes/auth/index.js';
import findingsRoutes from './routes/findings/index.js';
import graphRoutes from './routes/graph/index.js';
import plansRoutes from './routes/plans/index.js';
import projectsRoutes from './routes/projects/index.js';
import repositoriesRoutes from './routes/repositories/index.js';
import sharingRoutes from './routes/sharing/index.js';
import systemRoutes from './routes/system/index.js';
import { executeRun } from './services/analysis.js';

export interface BuildAppOptions {
  /** Replace the outside world (GitHub, Gemini, ElevenLabs, S3, mail, job dispatch). Used by tests. */
  integrations?: Integrations;
  logger?: boolean;
}

/** One module per API area; see src/routes. */
export const routeModules = [
  systemRoutes,
  authRoutes,
  accountRoutes,
  projectsRoutes,
  sharingRoutes,
  repositoriesRoutes,
  analysisRoutes,
  graphRoutes,
  findingsRoutes,
  plansRoutes,
  aiRoutes,
  activityRoutes,
];

const PROBLEM_TYPE = 'application/problem+json';

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = getConfig();
  const app = Fastify({
    logger: options.logger ?? true,
    trustProxy: true, // behind API Gateway / CloudFront; needed for per-IP rate limits
  });

  setIntegrations(
    options.integrations ?? createDefaultIntegrations({ executeRun, log: (message) => app.log.info(message) }),
  );

  app.register(cors, {
    origin: config.CORS_ORIGIN ?? true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposedHeaders: ['Location', 'Retry-After'],
  });
  // Opt-in per route (the auth endpoints); everything else is unlimited.
  app.register(rateLimit, { global: false, errorResponseBuilder: () => tooManyRequests() });

  // ---- authentication ------------------------------------------------------------------------------------
  app.decorateRequest('userId', null);
  app.decorateRequest('authFailure', null);
  app.decorateRequest('shareToken', null);
  app.addHook('onRequest', async (req) => {
    const share = req.headers['x-share-token'];
    req.shareToken = typeof share === 'string' && share.length > 0 ? share : null;

    const header = req.headers.authorization;
    if (!header) return;
    // A bad token must not break public endpoints; it is held back and reported by routes that need a user.
    try {
      if (!header.startsWith('Bearer ')) throw unauthorized('Use an "Authorization: Bearer <token>" header.', 'invalid_token');
      const claims = await verifyToken(header.slice(7), 'access');
      const user = claims.sub ? await users.findById(getPool(), claims.sub) : null;
      if (!user) throw unauthorized('This account no longer exists.', 'invalid_token');
      req.userId = user.id;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      req.authFailure = err;
    }
  });

  // ---- errors: always RFC 9457 problem details -----------------------------------------------------------------
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      return reply
        .code(err.status)
        .type(PROBLEM_TYPE)
        .send({ type: 'about:blank', title: err.title, status: err.status, detail: err.detail, code: err.code, ...(err.errors ? { errors: err.errors } : {}) });
    }
    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      // Fastify's own client errors: malformed JSON, oversized body, unsupported media type.
      const code = status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request';
      return reply.code(status).type(PROBLEM_TYPE).send({ type: 'about:blank', title: code.replace(/_/g, ' '), status, detail: err.message, code });
    }
    req.log.error({ err }, 'unhandled error');
    return reply
      .code(500)
      .type(PROBLEM_TYPE)
      .send({ type: 'about:blank', title: 'Internal server error', status: 500, detail: 'Something went wrong on our side.', code: 'internal_error' });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.code(404).type(PROBLEM_TYPE).send({ type: 'about:blank', title: 'Not found', status: 404, detail: 'No such route.', code: 'route_not_found' }),
  );

  // ---- routes: one folder per area, see src/routes ----------------------------------------------------------------
  for (const routes of routeModules) app.register(routes);

  return app;
}
