import type { Db } from '../db/pool.js';
import { iso, isoOrNull } from '../db/util.js';
import { mapUserSummary, type UserSummary } from './projects.js';

export type InvitableRole = 'editor' | 'viewer';

export interface InviteRow {
  id: string;
  projectId: string;
  projectName: string;
  email: string;
  role: InvitableRole;
  invitedBy: UserSummary | null;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const SELECT = `i.id, i.project_id, p.name AS project_name, i.email::text AS email, i.role, i.expires_at,
  i.accepted_at, i.revoked_at, i.created_at,
  u.id AS u_id, u.username::text AS u_username, u.display_name AS u_display_name, u.avatar_url AS u_avatar_url`;
const FROM = 'project_invites i JOIN projects p ON p.id = i.project_id LEFT JOIN users u ON u.id = i.invited_by';

function map(row: Record<string, any>): InviteRow {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    email: row.email,
    role: row.role,
    invitedBy: mapUserSummary(row, 'u_'),
    expiresAt: iso(row.expires_at),
    acceptedAt: isoOrNull(row.accepted_at),
    revokedAt: isoOrNull(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

/** Pending = not accepted, not revoked, not expired. */
export async function listPending(db: Db, projectId: string): Promise<InviteRow[]> {
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM ${FROM}
     WHERE i.project_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
     ORDER BY i.created_at DESC`,
    [projectId],
  );
  return rows.map(map);
}

export async function findByTokenHash(db: Db, tokenHash: string): Promise<InviteRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE i.token_hash = $1 AND p.deleted_at IS NULL`, [tokenHash]);
  return rows[0] ? map(rows[0]) : null;
}

export async function findById(db: Db, projectId: string, inviteId: string): Promise<InviteRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE i.project_id = $1 AND i.id = $2`, [projectId, inviteId]);
  return rows[0] ? map(rows[0]) : null;
}

/** Retires expired pending invites for this email so a fresh one can be issued. */
export async function expireStale(db: Db, projectId: string, email: string): Promise<void> {
  await db.query(
    `UPDATE project_invites SET revoked_at = now()
     WHERE project_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at <= now()`,
    [projectId, email],
  );
}

/** Throws a unique violation (`project_invites_pending_key`) if a pending invite exists. */
export async function create(
  db: Db,
  input: { projectId: string; email: string; role: InvitableRole; tokenHash: string; invitedBy: string; expiresAt: Date },
): Promise<InviteRow> {
  const { rows } = await db.query(
    `INSERT INTO project_invites (project_id, email, role, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.projectId, input.email, input.role, input.tokenHash, input.invitedBy, input.expiresAt],
  );
  return (await findById(db, input.projectId, rows[0].id))!;
}

export async function revoke(db: Db, projectId: string, inviteId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `UPDATE project_invites SET revoked_at = now()
     WHERE project_id = $1 AND id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [projectId, inviteId],
  );
  return (rowCount ?? 0) > 0;
}

export async function markAccepted(db: Db, inviteId: string): Promise<void> {
  await db.query('UPDATE project_invites SET accepted_at = now() WHERE id = $1', [inviteId]);
}
