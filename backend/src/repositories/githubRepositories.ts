import type { Db } from '../db/pool.js';

export interface RepositoryRow {
  id: string;
  githubId: number;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  isPrivate: boolean;
}

const COLUMNS = 'id, github_id, full_name, default_branch, html_url, is_private';

export function mapRepository(row: Record<string, any>, prefix = ''): RepositoryRow {
  return {
    id: row[`${prefix}id`],
    githubId: Number(row[`${prefix}github_id`]),
    fullName: row[`${prefix}full_name`],
    defaultBranch: row[`${prefix}default_branch`],
    htmlUrl: row[`${prefix}html_url`],
    isPrivate: row[`${prefix}is_private`],
  };
}

export async function upsert(db: Db, repo: Omit<RepositoryRow, 'id'>): Promise<RepositoryRow> {
  const { rows } = await db.query(
    `INSERT INTO repositories (github_id, full_name, default_branch, html_url, is_private)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (github_id) DO UPDATE
       SET full_name = EXCLUDED.full_name, default_branch = EXCLUDED.default_branch,
           html_url = EXCLUDED.html_url, is_private = EXCLUDED.is_private
     RETURNING ${COLUMNS}`,
    [repo.githubId, repo.fullName, repo.defaultBranch, repo.htmlUrl, repo.isPrivate],
  );
  return mapRepository(rows[0]);
}

export async function findById(db: Db, id: string): Promise<RepositoryRow | null> {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM repositories WHERE id = $1`, [id]);
  return rows[0] ? mapRepository(rows[0]) : null;
}
