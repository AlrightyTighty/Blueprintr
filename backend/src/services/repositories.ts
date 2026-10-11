import { getPool, withTransaction, type Db } from '../db/pool.js';
import { UNIQUE_VIOLATION, pgErrorCode } from '../db/util.js';
import { getConfig } from '../config.js';
import { AppError, conflict, notFound, validationError } from '../http/errors.js';
import { integrations } from '../integrations/registry.js';
import { parseGithubRepoUrl } from '../lib/githubUrl.js';
import * as activity from '../repositories/activity.js';
import * as connections from '../repositories/githubConnections.js';
import * as githubRepos from '../repositories/githubRepositories.js';
import * as links from '../repositories/projectRepositories.js';
import { githubTokenFor } from './auth.js';
import { requireProject, type Actor } from './access.js';
import { toProjectRepository } from './presenters.js';

/** A repository picked from a connected GitHub account, or any GitHub link (public, or private if the user's account can see it). */
export type LinkInput =
  | { connectionId: string; githubRepoId: number; branch?: string; rootPath?: string }
  | { url: string; branch?: string; rootPath?: string };

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
  /** The account used to read the repository; null for a public repository, which needs none. */
  connectionId: string | null;
  repo: Omit<githubRepos.RepositoryRow, 'id'>;
  branch: string;
  rootPath: string;
}

const megabytes = (kb: number) => `${Math.round(kb / 1024)} MB`;

/** Refuses a repository too big to be worth downloading, saying so up front rather than failing mid-analysis. */
function assertNotTooLarge(repo: { fullName: string; sizeKb?: number }, field: string): void {
  const limit = getConfig().MAX_REPOSITORY_KB;
  if (repo.sizeKb !== undefined && repo.sizeKb > limit) {
    throw validationError([
      { field, message: `${repo.fullName} is too large to analyse (${megabytes(repo.sizeKb)}; the limit is ${megabytes(limit)}). Try a smaller repository.` },
    ]);
  }
}

const NOT_FOUND_BY_URL =
  "We couldn't find that repository. Check the link, or connect your GitHub account to use a private repository.";

function isNotFound(error: unknown): boolean {
  return error instanceof AppError && error.status === 404;
}

/**
 * Works out which part of a /tree/<branch>/<folder> link is the branch. A branch name may contain slashes
 * ("feature/x"), so try the shortest first and ask GitHub whether it exists.
 */
async function resolveBranchAndFolder(token: string | null, fullName: string, refAndPath: string[]) {
  const MAX_BRANCH_SEGMENTS = 4;
  for (let length = 1; length <= Math.min(refAndPath.length, MAX_BRANCH_SEGMENTS); length++) {
    const candidate = refAndPath.slice(0, length).join('/');
    try {
      await integrations().github.resolveCommit(token, fullName, candidate);
      return { branch: candidate, folder: refAndPath.slice(length).join('/') };
    } catch (error) {
      // GitHub answers "no such branch" with an error; anything that isn't one of ours is a real failure.
      if (!(error instanceof AppError)) throw error;
    }
  }
  throw validationError([{ field: 'url', message: "We couldn't find the branch named in that link." }]);
}

/** Looks a pasted GitHub link up: as a public repository first, then through each of the user's accounts. */
async function verifyByUrl(db: Db, userId: string, input: { url: string; branch?: string; rootPath?: string }): Promise<VerifiedRepo> {
  const parsed = parseGithubRepoUrl(input.url);
  if (!parsed) {
    throw validationError([{ field: 'url', message: 'Use a GitHub repository link, like https://github.com/owner/repo.' }]);
  }
  const github = integrations().github;

  let repo: Awaited<ReturnType<typeof github.getRepositoryByName>> | undefined;
  let token: string | null = null;
  let connectionId: string | null = null;

  try {
    const found = await github.getRepositoryByName(null, parsed.fullName);
    // The server's optional API token must never be what opens a private repository to everyone.
    if (!found.isPrivate) repo = found;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  if (!repo) {
    for (const connection of await connections.listForUser(db, userId)) {
      const connectionToken = await githubTokenFor(db, connection);
      try {
        repo = await github.getRepositoryByName(connectionToken, parsed.fullName);
        token = connectionToken;
        connectionId = connection.id;
        break;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }
  if (!repo) throw validationError([{ field: 'url', message: NOT_FOUND_BY_URL }]);
  assertNotTooLarge(repo, 'url');

  let branch = input.branch?.trim() || undefined;
  let folder = input.rootPath;
  if (!branch && parsed.refAndPath.length > 0) {
    const resolved = await resolveBranchAndFolder(token, repo.fullName, parsed.refAndPath);
    branch = resolved.branch;
    folder ??= resolved.folder;
  }
  return { connectionId, repo, branch: branch ?? repo.defaultBranch, rootPath: normalizeRootPath(folder) };
}

/** Checks the repository can be read, by a GitHub link or through one of the user's connections. Network only; no database writes. */
export async function verifyRepository(db: Db, userId: string, input: LinkInput): Promise<VerifiedRepo> {
  if ('url' in input) return verifyByUrl(db, userId, input);
  const connection = await connections.findByIdForUser(db, input.connectionId, userId);
  if (!connection) throw validationError([{ field: 'connectionId', message: 'Not one of your GitHub connections.' }]);
  const repo = await integrations().github.getRepository(await githubTokenFor(db, connection), input.githubRepoId);
  assertNotTooLarge(repo, 'githubRepoId');
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
