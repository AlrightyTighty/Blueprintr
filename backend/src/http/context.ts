import type { FastifyRequest } from 'fastify';
import type { AppError } from './errors.js';
import { unauthorized } from './errors.js';
import type { Actor } from '../services/access.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth hook when a valid access token was sent. */
    userId: string | null;
    /** Why a presented token was rejected (expired, malformed), so protected routes can say so. */
    authFailure: AppError | null;
    shareToken: string | null;
  }
}

/** The signed-in user's id, or a 401. */
export function requireUser(req: FastifyRequest): string {
  if (!req.userId) throw req.authFailure ?? unauthorized();
  return req.userId;
}

/**
 * Who is calling. With `allowShare`, a share-link holder counts even without an account;
 * otherwise a signed-in user is required.
 */
export function actorOf(req: FastifyRequest, options: { allowShare?: boolean } = {}): Actor {
  if (!req.userId && !(options.allowShare && req.shareToken)) throw req.authFailure ?? unauthorized();
  return { userId: req.userId, shareToken: options.allowShare ? req.shareToken : null };
}

/** An editor-or-better action always needs an account. */
export function userActor(req: FastifyRequest): Actor & { userId: string } {
  return { userId: requireUser(req), shareToken: null };
}
