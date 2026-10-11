import type { FastifyRequest } from 'fastify';

/**
 * Route options that limit how often one signed-in account can call a route, however many addresses it uses.
 * For the routes that cost money or use an outside quota (Gemini, ElevenLabs, GitHub, analyses). Signed-out
 * callers share their address's allowance. Pass the result as a route's options.
 */
export function perUserLimit(max: number, timeWindow = '1 minute') {
  return {
    config: {
      rateLimit: { max, timeWindow, keyGenerator: (req: FastifyRequest) => req.userId ?? req.ip },
    },
  };
}
