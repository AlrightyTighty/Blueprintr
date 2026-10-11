import type { Db } from '../db/pool.js';
import { buildSet } from '../db/sql.js';
import { decodeCursor, escapeLike, iso, isoOrNull, toPage, type Page } from '../db/util.js';

export type ProjectRole = 'owner' | 'editor' | 'viewer';
export type ProjectVisibility = 'private' | 'link_view';

export interface UserSummary {
  id: string;
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  visibility: ProjectVisibility;
  shareToken: string | null;
  currentRunId: string | null;
  createdBy: UserSummary | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
}

export interface MemberProjectRow extends ProjectRow {
  myRole: ProjectRole;
  lastOpenedAt: string | null;
}

const SELECT = `p.id, p.name, p.description, p.visibility, p.share_token, p.current_run_id,
  p.created_at, p.updated_at, p.archived_at, p.deleted_at,
  cu.id AS cu_id, cu.username::text AS cu_username, cu.display_name AS cu_display_name, cu.avatar_url AS cu_avatar_url`;
const FROM = 'projects p LEFT JOIN users cu ON cu.id = p.created_by';

export function mapUserSummary(row: Record<string, any>, prefix: string): UserSummary | null {
  const id = row[`${prefix}id`];
  if (!id) return null;
  return {
    id,
    username: row[`${prefix}username`],
    displayName: row[`${prefix}display_name`],
    avatarUrl: row[`${prefix}avatar_url`],
  };
}

function map(row: Record<string, any>): ProjectRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    shareToken: row.share_token,
    currentRunId: row.current_run_id,
    createdBy: mapUserSummary(row, 'cu_'),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: isoOrNull(row.archived_at),
    deletedAt: isoOrNull(row.deleted_at),
  };
}

/** Includes soft-deleted projects; callers decide whether the trash is visible. */
export async function findById(db: Db, id: string): Promise<ProjectRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE p.id = $1`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

/** Same as findById but takes a row lock for the rest of the transaction. */
export async function lockById(db: Db, id: string): Promise<ProjectRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE p.id = $1 FOR UPDATE OF p`, [id]);
  return rows[0] ? map(rows[0]) : null;
}

export async function findByShareToken(db: Db, token: string): Promise<ProjectRow | null> {
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM ${FROM}
     WHERE p.share_token = $1 AND p.visibility = 'link_view' AND p.deleted_at IS NULL`,
    [token],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function create(
  db: Db,
  input: { name: string; description?: string | null; createdBy: string },
): Promise<ProjectRow> {
  const { rows } = await db.query(
    'INSERT INTO projects (name, description, created_by) VALUES ($1, $2, $3) RETURNING id',
    [input.name, input.description ?? null, input.createdBy],
  );
  return (await findById(db, rows[0].id))!;
}

export async function update(
  db: Db,
  id: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  const set = buildSet(patch, { name: 'name', description: 'description' }, 2);
  if (set) await db.query(`UPDATE projects SET ${set.clause} WHERE id = $1`, [id, ...set.values]);
}

export async function setArchived(db: Db, id: string, archived: boolean): Promise<void> {
  await db.query('UPDATE projects SET archived_at = CASE WHEN $2::boolean THEN now() END WHERE id = $1', [id, archived]);
}

export async function setDeleted(db: Db, id: string, deleted: boolean): Promise<void> {
  await db.query('UPDATE projects SET deleted_at = CASE WHEN $2::boolean THEN now() END WHERE id = $1', [id, deleted]);
}

export async function hardDelete(db: Db, id: string): Promise<void> {
  await db.query('DELETE FROM projects WHERE id = $1', [id]);
}

export async function setSharing(
  db: Db,
  id: string,
  input: { visibility: ProjectVisibility; shareToken?: string | null },
): Promise<void> {
  if (input.shareToken === undefined) {
    await db.query('UPDATE projects SET visibility = $2 WHERE id = $1', [id, input.visibility]);
  } else {
    await db.query('UPDATE projects SET visibility = $2, share_token = $3 WHERE id = $1', [
      id,
      input.visibility,
      input.shareToken,
    ]);
  }
}

export async function setCurrentRun(db: Db, id: string, runId: string | null): Promise<void> {
  await db.query('UPDATE projects SET current_run_id = $2 WHERE id = $1', [id, runId]);
}

export async function memberCount(db: Db, id: string): Promise<number> {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM project_members WHERE project_id = $1', [id]);
  return rows[0].n;
}

export interface ListFilters {
  scope: 'active' | 'archived' | 'trash';
  role?: ProjectRole;
  q?: string;
  limit: number;
  cursor?: string;
}

const SORT_KEY = 'COALESCE(m.last_opened_at, p.created_at)';

/** Projects the user belongs to, most recently opened first. */
export async function listForUser(db: Db, userId: string, filters: ListFilters): Promise<Page<MemberProjectRow>> {
  const where: string[] = ['m.user_id = $1'];
  const values: unknown[] = [userId];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    where.push(sql.replace('?', `$${values.length}`));
  };

  if (filters.scope === 'active') where.push('p.archived_at IS NULL AND p.deleted_at IS NULL');
  else if (filters.scope === 'archived') where.push('p.archived_at IS NOT NULL AND p.deleted_at IS NULL');
  else where.push("p.deleted_at IS NOT NULL AND m.role = 'owner'"); // only owners see (and can restore) the trash
  if (filters.role) add('m.role = ?', filters.role);
  if (filters.q) add("p.name ILIKE ? ESCAPE '\\'", `%${escapeLike(filters.q)}%`);

  const cursor = decodeCursor(filters.cursor);
  if (cursor && typeof cursor.k === 'string' && typeof cursor.id === 'string') {
    values.push(cursor.k, cursor.id);
    where.push(`(${SORT_KEY}, p.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(filters.limit + 1);

  const { rows } = await db.query(
    `SELECT ${SELECT}, m.role AS my_role, m.last_opened_at, ${SORT_KEY}::text AS sort_key
     FROM ${FROM} JOIN project_members m ON m.project_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY ${SORT_KEY} DESC, p.id DESC
     LIMIT $${values.length}`,
    values,
  );
  const mapped = rows.map((row) => ({
    row: { ...map(row), myRole: row.my_role as ProjectRole, lastOpenedAt: isoOrNull(row.last_opened_at) },
    key: row.sort_key as string,
  }));
  const page = toPage(mapped, filters.limit, (last) => ({ k: last.key, id: last.row.id }));
  return { items: page.items.map((i) => i.row), nextCursor: page.nextCursor };
}
