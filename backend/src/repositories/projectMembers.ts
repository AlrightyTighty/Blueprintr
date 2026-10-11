import type { Db } from '../db/pool.js';
import { iso, isoOrNull } from '../db/util.js';
import { mapUserSummary, type ProjectRole, type UserSummary } from './projects.js';

export interface MemberRow {
  user: UserSummary;
  role: ProjectRole;
  addedBy: UserSummary | null;
  lastOpenedAt: string | null;
  createdAt: string;
}

const SELECT = `m.role, m.last_opened_at, m.created_at,
  u.id AS u_id, u.username::text AS u_username, u.display_name AS u_display_name, u.avatar_url AS u_avatar_url,
  a.id AS a_id, a.username::text AS a_username, a.display_name AS a_display_name, a.avatar_url AS a_avatar_url`;
const FROM = `project_members m JOIN users u ON u.id = m.user_id AND u.deleted_at IS NULL
  LEFT JOIN users a ON a.id = m.added_by`;

function map(row: Record<string, any>): MemberRow {
  return {
    user: mapUserSummary(row, 'u_')!,
    role: row.role,
    addedBy: mapUserSummary(row, 'a_'),
    lastOpenedAt: isoOrNull(row.last_opened_at),
    createdAt: iso(row.created_at),
  };
}

export async function getRole(db: Db, projectId: string, userId: string): Promise<ProjectRole | null> {
  const { rows } = await db.query('SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', [
    projectId,
    userId,
  ]);
  return rows[0]?.role ?? null;
}

export async function find(db: Db, projectId: string, userId: string): Promise<MemberRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE m.project_id = $1 AND m.user_id = $2`, [
    projectId,
    userId,
  ]);
  return rows[0] ? map(rows[0]) : null;
}

export async function list(db: Db, projectId: string): Promise<MemberRow[]> {
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM ${FROM} WHERE m.project_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, u.username`,
    [projectId],
  );
  return rows.map(map);
}

export async function add(
  db: Db,
  input: { projectId: string; userId: string; role: ProjectRole; addedBy: string | null },
): Promise<void> {
  await db.query('INSERT INTO project_members (project_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)', [
    input.projectId,
    input.userId,
    input.role,
    input.addedBy,
  ]);
}

export async function updateRole(db: Db, projectId: string, userId: string, role: ProjectRole): Promise<void> {
  await db.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [projectId, userId, role]);
}

export async function remove(db: Db, projectId: string, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
    projectId,
    userId,
  ]);
  return (rowCount ?? 0) > 0;
}

export async function touchOpened(db: Db, projectId: string, userId: string): Promise<void> {
  await db.query('UPDATE project_members SET last_opened_at = now() WHERE project_id = $1 AND user_id = $2', [
    projectId,
    userId,
  ]);
}

/** Number of non-deleted projects the user owns. */
export async function countOwnedProjects(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM project_members m JOIN projects p ON p.id = m.project_id
     WHERE m.user_id = $1 AND m.role = 'owner' AND p.deleted_at IS NULL`,
    [userId],
  );
  return rows[0].n;
}

export async function removeAllForUser(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM project_members WHERE user_id = $1', [userId]);
}
