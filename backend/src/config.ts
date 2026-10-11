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
  CORS_ORIGIN: optionalString,

  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GITHUB_REDIRECT_URI: optionalString,

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
