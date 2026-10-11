import type { Db } from '../db/pool.js';
import { iso, isoOrNull } from '../db/util.js';

export interface GithubConnectionRow {
  id: string;
  userId: string;
  githubUserId: number;
  githubLogin: string;
  accessTokenCiphertext: Buffer;
  refreshTokenCiphertext: Buffer | null;
  scopes: string[];
  tokenExpiresAt: string | null;
  createdAt: string;
}

const COLUMNS = `id, user_id, github_user_id, github_login, access_token_ciphertext, refresh_token_ciphertext,
  scopes, token_expires_at, created_at`;

function map(row: Record<string, any>): GithubConnectionRow {
  return {
    id: row.id,
    userId: row.user_id,
    githubUserId: Number(row.github_user_id),
    githubLogin: row.github_login,
    accessTokenCiphertext: row.access_token_ciphertext,
    refreshTokenCiphertext: row.refresh_token_ciphertext,
    scopes: row.scopes,
    tokenExpiresAt: isoOrNull(row.token_expires_at),
    createdAt: iso(row.created_at),
  };
}

export async function findByGithubUserId(db: Db, githubUserId: number): Promise<GithubConnectionRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM github_connections WHERE github_user_id = $1`, [githubUserId]);
  return rows[0] ? map(rows[0]) : null;
}

export async function findById(db: Db, id: string): Promise<GithubConnectionRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM github_connections WHERE id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function findByIdForUser(db: Db, id: string, userId: string): Promise<GithubConnectionRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM github_connections WHERE id = $1 AND user_id = $2`, [id, userId]);
  return rows[0] ? map(rows[0]) : null;
}

export async function listForUser(db: Db, userId: string): Promise<GithubConnectionRow[]> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM github_connections WHERE user_id = $1 ORDER BY created_at`, [userId]);
  return rows.map(map);
}

export async function insert(
  db: Db,
  input: { userId: string; githubUserId: number; githubLogin: string; accessTokenCiphertext: Buffer; scopes: string[] },
): Promise<GithubConnectionRow> {
  const { rows } = await db.query(
    `INSERT INTO github_connections (user_id, github_user_id, github_login, access_token_ciphertext, scopes)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
    [input.userId, input.githubUserId, input.githubLogin, input.accessTokenCiphertext, input.scopes],
  );
  return map(rows[0]);
}

/** Refreshes the stored token after the user re-authorizes. */
export async function updateToken(
  db: Db,
  id: string,
  input: { githubLogin: string; accessTokenCiphertext: Buffer; scopes: string[] },
): Promise<void> {
  await db.query(
    `UPDATE github_connections SET github_login = $2, access_token_ciphertext = $3, scopes = $4 WHERE id = $1`,
    [id, input.githubLogin, input.accessTokenCiphertext, input.scopes],
  );
}

export async function remove(db: Db, id: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM github_connections WHERE id = $1 AND user_id = $2', [id, userId]);
  return (rowCount ?? 0) > 0;
}

export async function removeAllForUser(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM github_connections WHERE user_id = $1', [userId]);
}
