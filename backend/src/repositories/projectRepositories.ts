import type { Db } from '../db/pool.js';
import { buildSet } from '../db/sql.js';
import { iso } from '../db/util.js';
import { mapRepository, type RepositoryRow } from './githubRepositories.js';

export interface ProjectRepositoryRow {
  id: string;
  projectId: string;
  repository: RepositoryRow;
  branch: string;
  rootPath: string;
  linkedByConnectionId: string | null;
  createdAt: string;
}

const SELECT = `pr.id, pr.project_id, pr.branch, pr.root_path, pr.linked_by_connection_id, pr.created_at,
  r.id AS r_id, r.github_id AS r_github_id, r.full_name AS r_full_name, r.default_branch AS r_default_branch,
  r.html_url AS r_html_url, r.is_private AS r_is_private`;
const FROM = 'project_repositories pr JOIN repositories r ON r.id = pr.repository_id';

function map(row: Record<string, any>): ProjectRepositoryRow {
  return {
    id: row.id,
    projectId: row.project_id,
    repository: mapRepository(row, 'r_'),
    branch: row.branch,
    rootPath: row.root_path,
    linkedByConnectionId: row.linked_by_connection_id,
    createdAt: iso(row.created_at),
  };
}

export async function list(db: Db, projectId: string): Promise<ProjectRepositoryRow[]> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE pr.project_id = $1 ORDER BY pr.created_at`, [projectId]);
  return rows.map(map);
}

export async function find(db: Db, projectId: string, linkId: string): Promise<ProjectRepositoryRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE pr.project_id = $1 AND pr.id = $2`, [projectId, linkId]);
  return rows[0] ? map(rows[0]) : null;
}

/** The link that produced a run: same repository and subfolder. */
export async function findByRepository(
  db: Db,
  projectId: string,
  repositoryId: string,
  rootPath: string,
): Promise<ProjectRepositoryRow | null> {
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM ${FROM} WHERE pr.project_id = $1 AND pr.repository_id = $2 AND pr.root_path = $3`,
    [projectId, repositoryId, rootPath],
  );
  return rows[0] ? map(rows[0]) : null;
}

/** Throws a unique violation if (project, repository, root_path) is already linked. */
export async function add(
  db: Db,
  input: { projectId: string; repositoryId: string; branch: string; rootPath: string; connectionId: string | null },
): Promise<ProjectRepositoryRow> {
  const { rows } = await db.query(
    `INSERT INTO project_repositories (project_id, repository_id, branch, root_path, linked_by_connection_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.projectId, input.repositoryId, input.branch, input.rootPath, input.connectionId],
  );
  return (await find(db, input.projectId, rows[0].id))!;
}

export async function update(
  db: Db,
  linkId: string,
  patch: { branch?: string; rootPath?: string; connectionId?: string },
): Promise<void> {
  const set = buildSet(patch, { branch: 'branch', rootPath: 'root_path', connectionId: 'linked_by_connection_id' }, 2);
  if (set) await db.query(`UPDATE project_repositories SET ${set.clause} WHERE id = $1`, [linkId, ...set.values]);
}

export async function remove(db: Db, linkId: string): Promise<void> {
  await db.query('DELETE FROM project_repositories WHERE id = $1', [linkId]);
}
