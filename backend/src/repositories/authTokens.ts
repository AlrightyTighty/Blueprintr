import type { Db } from '../db/pool.js';

export type AuthTokenPurpose = 'email_verify' | 'password_reset';

export async function create(
  db: Db,
  input: { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: Date },
): Promise<void> {
  // Only the newest token of each purpose is valid.
  await db.query('UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [
    input.userId,
    input.purpose,
  ]);
  await db.query('INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4)', [
    input.userId,
    input.purpose,
    input.tokenHash,
    input.expiresAt,
  ]);
}

/** Atomically marks a valid, unused token as used and returns its user id. */
export async function consume(db: Db, tokenHash: string, purpose: AuthTokenPurpose): Promise<string | null> {
  const { rows } = await db.query(
    `UPDATE auth_tokens SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [tokenHash, purpose],
  );
  return rows[0]?.user_id ?? null;
}
