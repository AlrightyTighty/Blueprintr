import type { Db } from '../db/pool.js';
import { decodeCursor, escapeLike, iso, toPage, type Page } from '../db/util.js';
import { mapUserSummary, type UserSummary } from './projects.js';

export interface ActivityRow {
  id: number;
  projectId: string | null;
  actor: UserSummary | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface NewActivity {
  projectId?: string | null;
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  /** Snapshot of relevant values. Never tokens, passwords or Terraform plan values. */
  metadata?: Record<string, unknown>;
}

const SELECT = `a.id, a.project_id, a.action, a.target_type, a.target_id, a.metadata, a.created_at,
  u.id AS u_id, u.username::text AS u_username, u.display_name AS u_display_name, u.avatar_url AS u_avatar_url`;
const FROM = 'activity_log a LEFT JOIN users u ON u.id = a.actor_user_id';

function map(row: Record<string, any>): ActivityRow {
  return {
    id: row.id,
    projectId: row.project_id,
    actor: mapUserSummary(row, 'u_'),
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
  };
}

/** Call inside the same transaction as the change being recorded. */
export async function insert(db: Db, entry: NewActivity): Promise<void> {
  await db.query(
    `INSERT INTO activity_log (project_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.projectId ?? null,
      entry.actorUserId ?? null,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

async function page(db: Db, where: string[], values: unknown[], limit: number, cursorValue: string | undefined): Promise<Page<ActivityRow>> {
  const cursor = decodeCursor(cursorValue);
  if (cursor && typeof cursor.id === 'number') {
    values.push(cursor.id);
    where.push(`a.id < $${values.length}`);
  }
  values.push(limit + 1);
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT $${values.length}`,
    values,
  );
  return toPage(rows.map(map), limit, (last) => ({ id: last.id }));
}

export async function listForProject(
  db: Db,
  projectId: string,
  filters: { action?: string; actorId?: string; limit: number; cursor?: string },
): Promise<Page<ActivityRow>> {
  const where = ['a.project_id = $1'];
  const values: unknown[] = [projectId];
  if (filters.action) {
    if (filters.action.endsWith('.*')) {
      values.push(`${escapeLike(filters.action.slice(0, -1))}%`);
      where.push(`a.action LIKE $${values.length}`);
    } else {
      values.push(filters.action);
      where.push(`a.action = $${values.length}`);
    }
  }
  if (filters.actorId) {
    values.push(filters.actorId);
    where.push(`a.actor_user_id = $${values.length}::uuid`);
  }
  return page(db, where, values, filters.limit, filters.cursor);
}

/** Account-level entries (no project) the user performed. */
export async function listForUser(db: Db, userId: string, filters: { limit: number; cursor?: string }): Promise<Page<ActivityRow>> {
  return page(db, ['a.actor_user_id = $1', 'a.project_id IS NULL'], [userId], filters.limit, filters.cursor);
}
