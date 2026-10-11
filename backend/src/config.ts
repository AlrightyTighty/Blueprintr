import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  DATABASE_URL: z.string().min(1),
  /** Path to a CA bundle (e.g. the RDS global bundle). When set, the server certificate is verified. */
  DATABASE_CA_PATH: optionalString,
  /** `disable` turns TLS off entirely (local Postgres). */
  DATABASE_SSL: z.enum(['default', 'disable']).default('default'),
  DB_POOL_MAX: z.coerce.number().int().min(1).default(5),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL_SECONDS: z.coerce.number().int().min(60).default(60 * 60 * 24),
  /** Base64-encoded 32-byte key used to encrypt GitHub tokens (AES-256-GCM). */
  TOKEN_ENCRYPTION_KEY: z.string().min(1),

  FRONTEND_URL: z.string().default('http://localhost:5173'),
  /**
   * Whether to believe the X-Forwarded-For header for the client's address (it feeds the rate limits).
   * Leave it unset: on Lambda the real address already comes from API Gateway, and a client can send any
   * X-Forwarded-For it likes. Set a number (1) only when exactly that many trusted proxies sit in front,
   * or "true" to trust every hop (for tests).
   */
  TRUST_PROXY: optionalString,
  CORS_ORIGIN: optionalString,
  /** Sender address for email (verification, password reset, invitations), verified in Amazon SES. Unset: links are only logged. */
  MAIL_FROM: optionalString,

  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GITHUB_REDIRECT_URI: optionalString,
  /**
   * Optional token for reading PUBLIC repositories. Without it GitHub allows only 60 requests an hour
   * per server address (about 20 analyses). Use a token with no scopes (or a fine-grained token limited
   * to public repositories): it is only ever used for repositories that GitHub reports as public.
   */
  GITHUB_API_TOKEN: optionalString,

  GEMINI_API_KEY: optionalString,
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  ELEVENLABS_API_KEY: optionalString,
  ELEVENLABS_VOICE_ID: optionalString,
  ELEVENLABS_AGENT_ID: optionalString,
  ELEVENLABS_MODEL_ID: z.string().default('eleven_multilingual_v2'),

  /** S3 bucket for cached briefing audio. */
  AUDIO_BUCKET: optionalString,
  AWS_REGION: optionalString,

  /** Longest line the /narrate endpoint will speak, in characters. */
  NARRATION_MAX_CHARACTERS: z.coerce.number().int().min(1).default(700),
  /**
   * Most characters /narrate will send to ElevenLabs per day (UTC), so the public endpoint can't drain
   * the account's credits. Counted per server process; repeat lines are served from a cache for free.
   */
  NARRATION_DAILY_CHARACTER_BUDGET: z.coerce.number().int().min(0).default(4000),

  /**
   * An analysis still "pending" or "running" after this many minutes is treated as dead (its server restarted,
   * or the Lambda timed out) and marked failed, so nobody waits on it forever. Keep it above the job's timeout.
   */
  ANALYSIS_STALE_MINUTES: z.coerce.number().int().min(1).default(10),

  /**
   * Largest repository (GitHub's reported size, in KB, history included) that can be linked. GitHub only
   * serves a whole-repository download, so a huge repository would be streamed for nothing.
   */
  MAX_REPOSITORY_KB: z.coerce.number().int().min(1).default(500_000),

  /** Largest accepted Terraform plan upload, in bytes. */
  MAX_PLAN_BYTES: z.coerce.number().int().default(6 * 1024 * 1024),
});

export type Config = z.infer<typeof envSchema>;

let cached: Config | undefined;

export function getConfig(): Config {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Invalid environment configuration: ${problems}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Test hook: re-read process.env on next getConfig(). */
export function resetConfig(): void {
  cached = undefined;
}
