import { timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/pool.js';
import { forbidden, notFound, unauthorized } from '../http/errors.js';
import * as members from '../repositories/projectMembers.js';
import * as projects from '../repositories/projects.js';
import type { ProjectRole, ProjectRow } from '../repositories/projects.js';

/** Who is calling: a signed-in user, a share-link holder, or both. */
export interface Actor {
  userId: string | null;
  shareToken: string | null;
}

export interface ProjectAccess {
  project: ProjectRow;
  /** Null when access came only from a share link. */
  role: ProjectRole | null;
}

const RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, owner: 3 };

const sameToken = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface AccessOptions {
  /** Minimum role needed. Defaults to viewer. */
  min?: ProjectRole;
  /** Accept a valid share link for viewer-level access. */
  allowShare?: boolean;
  /** Let the owner reach a project that is in the trash (restore, purge). */
  allowTrashed?: boolean;
}

/**
 * The one place project permissions are decided.
 *
 * - Not a member and no valid share link: 404 (existence is not leaked).
 * - A member whose role is too low: 403.
 * - Trashed projects look deleted to everyone except the owner, and only where `allowTrashed` is set.
 */
export async function requireProject(
  db: Db,
  projectId: string,
  actor: Actor,
  options: AccessOptions = {},
): Promise<ProjectAccess> {
  const min = options.min ?? 'viewer';
  if (!actor.userId && !(options.allowShare && actor.shareToken)) throw unauthorized();

  const project = await projects.findById(db, projectId);
  if (!project) throw notFound('Project');

  const role = actor.userId ? await members.getRole(db, projectId, actor.userId) : null;
  if (role) {
    if (project.deletedAt && !(options.allowTrashed && role === 'owner')) throw notFound('Project');
    if (RANK[role] < RANK[min]) throw forbidden();
    return { project, role };
  }

  const viaShare =
    options.allowShare &&
    min === 'viewer' &&
    actor.shareToken &&
    project.visibility === 'link_view' &&
    project.shareToken &&
    !project.deletedAt &&
    sameToken(project.shareToken, actor.shareToken);
  if (viaShare) return { project, role: null };

  throw notFound('Project');
}
