import type { Db } from '../db/pool.js';
import { buildSet } from '../db/sql.js';
import { iso, isoOrNull } from '../db/util.js';

export interface UserRow {
  id: string;
  username: string;
  email: string;
  emailVerifiedAt: string | null;
  passwordHash: string;
  displayName: string | null;
  avatarUrl: string | null;
  createdAt: string;
  /** Login tokens issued before this moment are no longer accepted. Null if none were ever revoked. */
  sessionsValidAfter: string | null;
}

const COLUMNS = `id, username::text AS username, email::text AS email, email_verified_at, password_hash,
  display_name, avatar_url, created_at, sessions_valid_after`;

function map(row: Record<string, any>): UserRow {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    emailVerifiedAt: isoOrNull(row.email_verified_at),
    passwordHash: row.password_hash,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: iso(row.created_at),
    sessionsValidAfter: isoOrNull(row.sessions_valid_after),
  };
}

export async function findById(db: Db, id: string): Promise<UserRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/** Looks up an active user by username or email (both case-insensitive). */
export async function findByIdentifier(db: Db, identifier: string): Promise<UserRow | null> {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM users WHERE deleted_at IS NULL AND (username = $1 OR email = $1) LIMIT 1`,
    [identifier],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function findByEmail(db: Db, email: string): Promise<UserRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]);
  return rows[0] ? map(rows[0]) : null;
}

export async function usernameExists(db: Db, username: string): Promise<boolean> {
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE username = $1 AND deleted_at IS NULL', [username]);
  return (rowCount ?? 0) > 0;
}

export interface NewUser {
  username: string;
  email: string;
  passwordHash: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  emailVerified?: boolean;
}

/** Throws a unique-violation (constraint `users_username_key` / `users_email_key`) on duplicates. */
export async function create(db: Db, user: NewUser): Promise<UserRow> {
  const { rows } = await db.query(
    `INSERT INTO users (username, email, password_hash, display_name, avatar_url, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END)
     RETURNING ${COLUMNS}`,
    [user.username, user.email, user.passwordHash, user.displayName ?? null, user.avatarUrl ?? null, user.emailVerified ?? false],
  );
  return map(rows[0]);
}

export interface UserPatch {
  username?: string;
  email?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  emailVerifiedAt?: Date | null;
}

export async function update(db: Db, id: string, patch: UserPatch): Promise<UserRow | null> {
  const set = buildSet(
    patch as Record<string, unknown>,
    { username: 'username', email: 'email', displayName: 'display_name', avatarUrl: 'avatar_url', emailVerifiedAt: 'email_verified_at' },
    2,
  );
  if (!set) return findById(db, id);
  const { rows } = await db.query(
    `UPDATE users SET ${set.clause} WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLUMNS}`,
    [id, ...set.values],
  );
  return rows[0] ? map(rows[0]) : null;
}

/**
 * Sets a new password, which also ends every existing sign-in: a stolen login must not survive the password
 * being changed. The cut-off time comes from this server's clock, the same one that stamps each token.
 */
export async function setPassword(db: Db, id: string, passwordHash: string, now = new Date()): Promise<void> {
  await db.query('UPDATE users SET password_hash = $2, sessions_valid_after = $3 WHERE id = $1', [id, passwordHash, now]);
}

/** Ends every existing sign-in without touching the password ("sign out everywhere"). */
export async function revokeSessions(db: Db, id: string, now = new Date()): Promise<void> {
  await db.query('UPDATE users SET sessions_valid_after = $2 WHERE id = $1', [id, now]);
}

export async function markEmailVerified(db: Db, id: string): Promise<void> {
  await db.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [id]);
}

export async function softDelete(db: Db, id: string): Promise<void> {
  await db.query('UPDATE users SET deleted_at = now() WHERE id = $1', [id]);
}
