import { getPool, withTransaction, type Db } from '../db/pool.js';
import { badRequest, conflict, notFound, validationError } from '../http/errors.js';
import * as activity from '../repositories/activity.js';
import * as runs from '../repositories/analysisRuns.js';
import * as findings from '../repositories/findings.js';
import * as members from '../repositories/projectMembers.js';
import * as links from '../repositories/projectRepositories.js';
import * as projects from '../repositories/projects.js';
import type { ProjectRole, ProjectRow } from '../repositories/projects.js';
import { requireProject, type Actor } from './access.js';
import { startRunInternal } from './analysis.js';
import { toProject, toProjectRepository, toRun } from './presenters.js';
import { saveLink, verifyRepository, type LinkInput, type VerifiedRepo } from './repositories.js';

async function detail(db: Db, project: ProjectRow, extra: { myRole: ProjectRole | null; lastOpenedAt?: string | null }) {
  const [repositories, memberCount, currentRun] = await Promise.all([
    links.list(db, project.id),
    projects.memberCount(db, project.id),
    project.currentRunId ? runs.findById(db, project.id, project.currentRunId) : Promise.resolve(null),
  ]);
  const openFindingCounts = project.currentRunId ? await findings.openCounts(db, project.currentRunId) : {};
  return {
    ...toProject(project, { ...extra, currentRun: currentRun ? toRun(currentRun) : null }),
    repositories: repositories.map(toProjectRepository),
    memberCount,
    openFindingCounts,
  };
}

export { detail as projectDetail };

export async function createProject(
  userId: string,
  input: { name: string; description?: string; repositories?: LinkInput[]; analyze?: boolean },
) {
  const db = getPool();
  // Ask GitHub first, so a bad repository fails the request before anything is written.
  const verified: VerifiedRepo[] = [];
  for (const repo of input.repositories ?? []) verified.push(await verifyRepository(db, userId, repo));
  const seen = new Set<string>();
  for (const v of verified) {
    const key = `${v.repo.githubId}|${v.rootPath}`;
    if (seen.has(key)) throw validationError([{ field: 'repositories', message: 'The same repository and folder is listed twice.' }]);
    seen.add(key);
  }

  const { project, firstLinkId } = await withTransaction(async (tx) => {
    const created = await projects.create(tx, { name: input.name, description: input.description, createdBy: userId });
    await members.add(tx, { projectId: created.id, userId, role: 'owner', addedBy: userId });
    await activity.insert(tx, { projectId: created.id, actorUserId: userId, action: 'project.created', targetType: 'project', targetId: created.id, metadata: { name: created.name } });
    let first: string | null = null;
    for (const v of verified) {
      const link = await saveLink(tx, created.id, userId, v);
      first ??= link.id;
    }
    return { project: created, firstLinkId: first };
  });

  if (input.analyze && firstLinkId) await startRunInternal(getPool(), project.id, userId, { repositoryLinkId: firstLinkId });
  return detail(db, (await projects.findById(db, project.id))!, { myRole: 'owner' });
}

export async function listProjects(
  userId: string,
  query: { scope: 'active' | 'archived' | 'trash'; role?: ProjectRole; q?: string; limit: number; cursor?: string },
) {
  const db = getPool();
  const page = await projects.listForUser(db, userId, query);
  const runRows = await runs.findByIds(db, page.items.flatMap((p) => (p.currentRunId ? [p.currentRunId] : [])));
  const runById = new Map(runRows.map((r) => [r.id, toRun(r)]));
  return {
    items: page.items.map((p) => toProject(p, { myRole: p.myRole, lastOpenedAt: p.lastOpenedAt, currentRun: p.currentRunId ? runById.get(p.currentRunId) : null })),
    nextCursor: page.nextCursor,
  };
}

export async function getProject(actor: Actor, projectId: string) {
  const db = getPool();
  const { project, role } = await requireProject(db, projectId, actor, { allowShare: true });
  if (actor.userId && role) await members.touchOpened(db, projectId, actor.userId);
  return detail(db, project, { myRole: role });
}

export async function updateProject(actor: Actor, projectId: string, patch: { name?: string; description?: string | null }) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'owner' });
  await withTransaction(async (tx) => {
    await projects.update(tx, projectId, patch);
    if (patch.name !== undefined && patch.name !== project.name) {
      await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'project.renamed', targetType: 'project', targetId: projectId, metadata: { from: project.name, to: patch.name } });
    }
  });
  return detail(db, (await projects.findById(db, projectId))!, { myRole: 'owner' });
}

export async function deleteProject(actor: Actor, projectId: string): Promise<void> {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'owner' });
  await withTransaction(async (tx) => {
    await projects.setDeleted(tx, projectId, true);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'project.deleted', targetType: 'project', targetId: projectId, metadata: { name: project.name, permanent: false } });
  });
}

export async function archiveProject(actor: Actor, projectId: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'owner' });
  if (project.archivedAt) throw conflict('already_archived', 'The project is already archived.');
  await withTransaction(async (tx) => {
    await projects.setArchived(tx, projectId, true);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'project.archived', targetType: 'project', targetId: projectId, metadata: { name: project.name } });
  });
  return toProject((await projects.findById(db, projectId))!, { myRole: 'owner' });
}

/** Brings a project back from the trash; if it isn't trashed, from the archive. */
export async function restoreProject(actor: Actor, projectId: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'owner', allowTrashed: true });
  if (!project.deletedAt && !project.archivedAt) throw conflict('not_restorable', 'The project is neither archived nor in the trash.');
  await withTransaction(async (tx) => {
    if (project.deletedAt) await projects.setDeleted(tx, projectId, false);
    else await projects.setArchived(tx, projectId, false);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'project.restored', targetType: 'project', targetId: projectId, metadata: { name: project.name, from: project.deletedAt ? 'trash' : 'archive' } });
  });
  return toProject((await projects.findById(db, projectId))!, { myRole: 'owner' });
}

/** Hard delete. Only for projects already in the trash. The activity log keeps its rows. */
export async function purgeProject(actor: Actor, projectId: string): Promise<void> {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'owner', allowTrashed: true });
  if (!project.deletedAt) throw conflict('not_in_trash', 'Move the project to the trash before deleting it permanently.');
  await withTransaction(async (tx) => {
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'project.deleted', targetType: 'project', targetId: projectId, metadata: { name: project.name, permanent: true } });
    await projects.hardDelete(tx, projectId);
  });
}

export async function leaveProject(actor: Actor, projectId: string): Promise<void> {
  const db = getPool();
  const { project, role } = await requireProject(db, projectId, actor);
  if (role === 'owner') throw conflict('owner_cannot_leave', 'Transfer ownership to someone else before leaving.');
  await withTransaction(async (tx) => {
    await members.remove(tx, projectId, actor.userId!);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'member.left', targetType: 'user', targetId: actor.userId, metadata: { project: project.name, role } });
  });
}

export async function transferOwnership(actor: Actor, projectId: string, newOwnerId: string) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'owner' });
  if (newOwnerId === actor.userId) throw badRequest('already_owner', 'You already own this project.');
  await withTransaction(async (tx) => {
    await projects.lockById(tx, projectId);
    const target = await members.find(tx, projectId, newOwnerId);
    if (!target) throw notFound('Member');
    // The partial unique index allows one owner, so demote before promoting.
    await members.updateRole(tx, projectId, actor.userId!, 'editor');
    await members.updateRole(tx, projectId, newOwnerId, 'owner');
    await activity.insert(tx, {
      projectId,
      actorUserId: actor.userId,
      action: 'project.ownership_transferred',
      targetType: 'user',
      targetId: newOwnerId,
      metadata: { from: actor.userId, to: newOwnerId, toUsername: target.user.username },
    });
  });
  return { items: await members.list(db, projectId) };
}
