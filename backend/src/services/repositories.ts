import { getPool, withTransaction, type Db } from '../db/pool.js';
import { UNIQUE_VIOLATION, pgErrorCode } from '../db/util.js';
import { conflict, notFound, validationError } from '../http/errors.js';
import { integrations } from '../integrations/registry.js';
import * as activity from '../repositories/activity.js';
import * as connections from '../repositories/githubConnections.js';
import * as githubRepos from '../repositories/githubRepositories.js';
import * as links from '../repositories/projectRepositories.js';
import { githubTokenFor } from './auth.js';
import { requireProject, type Actor } from './access.js';
import { toProjectRepository } from './presenters.js';

export interface LinkInput {
  connectionId: string;
  githubRepoId: number;
  branch?: string;
  rootPath?: string;
}

/** Subfolders are stored without surrounding slashes; `..` is refused. */
export function normalizeRootPath(rootPath: string | undefined): string {
  const cleaned = (rootPath ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (cleaned.split('/').some((part) => part === '..')) {
    throw validationError([{ field: 'rootPath', message: 'Must not contain ".."' }]);
  }
  return cleaned;
}

/** What GitHub told us about a repo the user wants to link (fetched before the database transaction). */
export interface VerifiedRepo {
  connectionId: string;
  repo: Omit<githubRepos.RepositoryRow, 'id'>;
  branch: string;
  rootPath: string;
}

/** Checks the user's GitHub connection can see the repository. Network only; no database writes. */
export async function verifyRepository(db: Db, userId: string, input: LinkInput): Promise<VerifiedRepo> {
  const connection = await connections.findByIdForUser(db, input.connectionId, userId);
  if (!connection) throw validationError([{ field: 'connectionId', message: 'Not one of your GitHub connections.' }]);
  const repo = await integrations().github.getRepository(await githubTokenFor(db, connection), input.githubRepoId);
  return { connectionId: connection.id, repo, branch: input.branch?.trim() || repo.defaultBranch, rootPath: normalizeRootPath(input.rootPath) };
}

/** Writes the link and logs it. Use inside the caller's transaction. */
export async function saveLink(tx: Db, projectId: string, userId: string, verified: VerifiedRepo) {
  const repository = await githubRepos.upsert(tx, verified.repo);
  let link;
  try {
    link = await links.add(tx, { projectId, repositoryId: repository.id, branch: verified.branch, rootPath: verified.rootPath, connectionId: verified.connectionId });
  } catch (err) {
    if (pgErrorCode(err) === UNIQUE_VIOLATION) throw conflict('repository_already_linked', 'That repository (and folder) is already linked to this project.');
    throw err;
  }
  await activity.insert(tx, {
    projectId,
    actorUserId: userId,
    action: 'repository.linked',
    targetType: 'repository',
    targetId: repository.id,
    metadata: { repository: repository.fullName, branch: verified.branch, rootPath: verified.rootPath },
  });
  return link;
}

export async function listLinks(actor: Actor, projectId: string) {
  const db = getPool();
  await requireProject(db, projectId, actor, { allowShare: true });
  return { items: (await links.list(db, projectId)).map(toProjectRepository) };
}

export async function linkRepository(actor: Actor, projectId: string, input: LinkInput) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'editor' });
  const verified = await verifyRepository(db, actor.userId!, input);
  const link = await withTransaction((tx) => saveLink(tx, projectId, actor.userId!, verified));
  return toProjectRepository(link);
}

export async function updateLink(actor: Actor, projectId: string, linkId: string, patch: { branch?: string; rootPath?: string; connectionId?: string }) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'editor' });
  if (patch.connectionId) {
    const connection = await connections.findByIdForUser(db, patch.connectionId, actor.userId!);
    if (!connection) throw validationError([{ field: 'connectionId', message: 'Not one of your GitHub connections.' }]);
  }
  const rootPath = patch.rootPath === undefined ? undefined : normalizeRootPath(patch.rootPath);
  return withTransaction(async (tx) => {
    const existing = await links.find(tx, projectId, linkId);
    if (!existing) throw notFound('Repository link');
    try {
      await links.update(tx, linkId, { branch: patch.branch?.trim(), rootPath, connectionId: patch.connectionId });
    } catch (err) {
      if (pgErrorCode(err) === UNIQUE_VIOLATION) throw conflict('repository_already_linked', 'That repository (and folder) is already linked to this project.');
      throw err;
    }
    return toProjectRepository((await links.find(tx, projectId, linkId))!);
  });
}

export async function unlinkRepository(actor: Actor, projectId: string, linkId: string): Promise<void> {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'editor' });
  await withTransaction(async (tx) => {
    const existing = await links.find(tx, projectId, linkId);
    if (!existing) throw notFound('Repository link');
    await links.remove(tx, linkId);
    await activity.insert(tx, {
      projectId,
      actorUserId: actor.userId,
      action: 'repository.unlinked',
      targetType: 'repository',
      targetId: existing.repository.id,
      metadata: { repository: existing.repository.fullName, rootPath: existing.rootPath },
    });
  });
}
