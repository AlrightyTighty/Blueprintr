import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { getConfig } from './config.js';
import { getPool } from './db/pool.js';
import { AppError, tooManyRequests, unauthorized } from './http/errors.js';
import { createDefaultIntegrations, setIntegrations, type Integrations } from './integrations/registry.js';
import { verifyToken } from './lib/jwt.js';
import { redactUrl } from './lib/redact.js';
import * as users from './repositories/users.js';
import accountRoutes from './routes/account/index.js';
import activityRoutes from './routes/activity/index.js';
import aiRoutes from './routes/ai/index.js';
import analysisRoutes from './routes/analysis/index.js';
import authRoutes from './routes/auth/index.js';
import endpointsRoutes from './routes/endpoints/index.js';
import findingsRoutes from './routes/findings/index.js';
import graphRoutes from './routes/graph/index.js';
import plansRoutes from './routes/plans/index.js';
import projectsRoutes from './routes/projects/index.js';
import repositoriesRoutes from './routes/repositories/index.js';
import sharingRoutes from './routes/sharing/index.js';
import systemRoutes from './routes/system/index.js';
import { executeRun } from './services/analysis.js';

/**
 * Turns CORS_ORIGIN into what the CORS plugin takes. It may list several origins separated by commas, for
 * example the bare domain and its www form: "https://example.com,https://www.example.com". Each must be a full
 * origin (scheme and host); a path or trailing slash is dropped, since browsers never send one. A lone "*"
 * allows every origin. Throws on a mistake, so a typo stops the server from starting instead of silently
 * blocking the site.
 */
export function parseCorsOrigins(value: string): string | string[] {
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('CORS_ORIGIN is set but lists no origins.');
  if (entries.includes('*')) {
    if (entries.length > 1) throw new Error('CORS_ORIGIN: "*" (any origin) cannot be combined with other origins.');
    return '*';
  }
  const origins = entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(`CORS_ORIGIN: "${entry}" is not a full origin such as https://example.com.`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`CORS_ORIGIN: "${entry}" must start with http:// or https://.`);
    }
    return url.origin;
  });
  const unique = [...new Set(origins)];
  return unique.length === 1 ? unique[0]! : unique;
}

/**
 * Which websites may call the API from a browser. An explicit CORS_ORIGIN (one origin, or several separated by
 * commas) wins. Otherwise, in production, only the frontend's own address; anywhere else (a laptop) any origin,
 * for convenience.
 */
export function corsOriginFor(settings: { CORS_ORIGIN?: string; NODE_ENV: string; FRONTEND_URL: string }): string | string[] | boolean {
  if (settings.CORS_ORIGIN) return parseCorsOrigins(settings.CORS_ORIGIN);
  return settings.NODE_ENV === 'production' ? new URL(settings.FRONTEND_URL).origin : true;
}

/** Reads TRUST_PROXY: unset or "false" trusts nothing; "true" trusts every hop; a number trusts that many proxies. */
export function parseTrustProxy(value: string | undefined): boolean | number {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  const hops = Number(value);
  return Number.isInteger(hops) && hops > 0 ? hops : false;
}

/**
 * What Fastify's trustProxy option wants: true/false as they are, and a hop count as a function that trusts
 * the nearest `hops` addresses (Fastify accepts the number itself at runtime, but its types only allow this).
 */
export function toFastifyTrustProxy(setting: boolean | number): boolean | ((address: string, hop: number) => boolean) {
  return typeof setting === 'number' ? (_address, hop) => hop < setting : setting;
}

export interface BuildAppOptions {
  /** Overrides TRUST_PROXY. Tests set it so they can tell requests apart with X-Forwarded-For. */
  trustProxy?: boolean | number;
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
  endpointsRoutes,
  findingsRoutes,
  plansRoutes,
  aiRoutes,
  activityRoutes,
];

const PROBLEM_TYPE = 'application/problem+json';

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = getConfig();
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            serializers: {
              // The default request log line includes the full URL, which can contain a link's secret.
              req: (req) => ({ method: req.method, url: redactUrl(req.url ?? ''), host: req.host, remoteAddress: req.ip }),
            },
          },
    // Believing X-Forwarded-For lets any client pick its own address and so dodge every per-IP rate limit,
    // which is why this is off unless TRUST_PROXY says a proxy we control is in front.
    trustProxy: toFastifyTrustProxy(options.trustProxy ?? parseTrustProxy(config.TRUST_PROXY)),
  });

  setIntegrations(
    options.integrations ?? createDefaultIntegrations({ executeRun, log: (message) => app.log.info(message) }),
  );

  app.register(cors, {
    origin: corsOriginFor(config),
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
      const claims = await verifyToken<{ iat?: number; iatMs?: number }>(header.slice(7), 'access');
      const user = claims.sub ? await users.findById(getPool(), claims.sub) : null;
      if (!user) throw unauthorized('This account no longer exists.', 'invalid_token');
      // A password change (or "sign out everywhere") ends every sign-in made before it.
      const issuedAtMs = typeof claims.iatMs === 'number' ? claims.iatMs : (claims.iat ?? 0) * 1000; // tokens from before iatMs existed
      if (user.sessionsValidAfter && issuedAtMs < Date.parse(user.sessionsValidAfter)) {
        throw unauthorized('Your session has ended. Sign in again.', 'session_revoked');
      }
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
