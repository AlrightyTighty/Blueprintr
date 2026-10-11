import type { Db } from '../db/pool.js';
import { decodeCursor, iso, isoOrNull, toPage, type Page } from '../db/util.js';
import { mapRepository, type RepositoryRow } from './githubRepositories.js';
import { mapUserSummary, type UserSummary } from './projects.js';

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface RunRow {
  id: string;
  projectId: string;
  repository: RepositoryRow | null;
  rootPath: string;
  commitSha: string | null;
  branch: string | null;
  status: RunStatus;
  error: string | null;
  parserVersion: string;
  stats: Record<string, any>;
  startedBy: UserSummary | null;
  isCurrent: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const SELECT = `ar.id, ar.project_id, ar.root_path, ar.commit_sha, ar.branch, ar.status, ar.error, ar.parser_version,
  ar.stats, ar.created_at, ar.started_at, ar.finished_at, (p.current_run_id = ar.id) AS is_current,
  r.id AS r_id, r.github_id AS r_github_id, r.full_name AS r_full_name, r.default_branch AS r_default_branch,
  r.html_url AS r_html_url, r.is_private AS r_is_private,
  u.id AS u_id, u.username::text AS u_username, u.display_name AS u_display_name, u.avatar_url AS u_avatar_url`;
const FROM = `analysis_runs ar JOIN projects p ON p.id = ar.project_id
  LEFT JOIN repositories r ON r.id = ar.repository_id LEFT JOIN users u ON u.id = ar.started_by`;

function map(row: Record<string, any>): RunRow {
  return {
    id: row.id,
    projectId: row.project_id,
    repository: row.r_id ? mapRepository(row, 'r_') : null,
    rootPath: row.root_path,
    commitSha: row.commit_sha,
    branch: row.branch,
    status: row.status,
    error: row.error,
    parserVersion: row.parser_version,
    stats: row.stats ?? {},
    startedBy: mapUserSummary(row, 'u_'),
    isCurrent: row.is_current === true,
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

export async function findById(db: Db, projectId: string, runId: string): Promise<RunRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE ar.project_id = $1 AND ar.id = $2`, [projectId, runId]);
  return rows[0] ? map(rows[0]) : null;
}

export async function findByIds(db: Db, ids: string[]): Promise<RunRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE ar.id = ANY($1::uuid[])`, [ids]);
  return rows.map(map);
}

export async function create(
  db: Db,
  input: {
    projectId: string;
    repositoryId: string | null;
    rootPath: string;
    commitSha: string | null;
    branch: string | null;
    parserVersion: string;
    startedBy: string;
    stats: Record<string, unknown>;
  },
): Promise<RunRow> {
  const { rows } = await db.query(
    `INSERT INTO analysis_runs (project_id, repository_id, root_path, commit_sha, branch, parser_version, started_by, stats)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [input.projectId, input.repositoryId, input.rootPath, input.commitSha, input.branch, input.parserVersion, input.startedBy, JSON.stringify(input.stats)],
  );
  return (await findById(db, input.projectId, rows[0].id))!;
}

/** Progress updates merge into `stats` (the current stage lives at `stats.stage`). */
export async function updateProgress(
  db: Db,
  runId: string,
  patch: { status?: RunStatus; error?: string | null; stats?: Record<string, unknown>; markStarted?: boolean; markFinished?: boolean },
): Promise<void> {
  await db.query(
    `UPDATE analysis_runs SET
       status = COALESCE($2::run_status, status),
       error = CASE WHEN $3::boolean THEN $4 ELSE error END,
       stats = stats || $5::jsonb,
       started_at = CASE WHEN $6::boolean THEN now() ELSE started_at END,
       finished_at = CASE WHEN $7::boolean THEN now() ELSE finished_at END
     WHERE id = $1`,
    [
      runId,
      patch.status ?? null,
      patch.error !== undefined,
      patch.error ?? null,
      JSON.stringify(patch.stats ?? {}),
      patch.markStarted ?? false,
      patch.markFinished ?? false,
    ],
  );
}

export async function list(
  db: Db,
  projectId: string,
  filters: { commitSha?: string; status?: RunStatus; limit: number; cursor?: string },
): Promise<Page<RunRow>> {
  const where = ['ar.project_id = $1'];
  const values: unknown[] = [projectId];
  if (filters.commitSha) {
    values.push(filters.commitSha);
    where.push(`ar.commit_sha = $${values.length}`);
  }
  if (filters.status) {
    values.push(filters.status);
    where.push(`ar.status = $${values.length}::run_status`);
  }
  const cursor = decodeCursor(filters.cursor);
  if (cursor && typeof cursor.k === 'string' && typeof cursor.id === 'string') {
    values.push(cursor.k, cursor.id);
    where.push(`(ar.created_at, ar.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(filters.limit + 1);
  const { rows } = await db.query(
    `SELECT ${SELECT}, ar.created_at::text AS sort_key FROM ${FROM}
     WHERE ${where.join(' AND ')} ORDER BY ar.created_at DESC, ar.id DESC LIMIT $${values.length}`,
    values,
  );
  const mapped = rows.map((row) => ({ run: map(row), key: row.sort_key as string }));
  const page = toPage(mapped, filters.limit, (last) => ({ k: last.key, id: last.run.id }));
  return { items: page.items.map((i) => i.run), nextCursor: page.nextCursor };
}

export async function remove(db: Db, runId: string): Promise<void> {
  await db.query('DELETE FROM analysis_runs WHERE id = $1', [runId]);
}

/** For background jobs that only know the run id. */
export async function findProjectId(db: Db, runId: string): Promise<string | null> {
  const { rows } = await db.query('SELECT project_id FROM analysis_runs WHERE id = $1', [runId]);
  return rows[0]?.project_id ?? null;
}
