import type { RunRow } from '../repositories/analysisRuns.js';
import type { UserRow } from '../repositories/users.js';
import type { GithubConnectionRow } from '../repositories/githubConnections.js';
import type { ProjectRepositoryRow } from '../repositories/projectRepositories.js';
import type { ProjectRow, ProjectRole } from '../repositories/projects.js';
import type { PlanChangeRow, PlanRow } from '../repositories/plans.js';

/** The signed-in user's own profile. Never includes the password hash. */
export function toUser(user: UserRow) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  };
}

/** Never includes tokens. */
export function toGithubConnection(row: GithubConnectionRow) {
  return {
    id: row.id,
    githubUserId: row.githubUserId,
    githubLogin: row.githubLogin,
    scopes: row.scopes,
    createdAt: row.createdAt,
  };
}

export function toProjectRepository(row: ProjectRepositoryRow) {
  return {
    id: row.id,
    repository: row.repository,
    branch: row.branch,
    rootPath: row.rootPath,
    linkedByConnectionId: row.linkedByConnectionId,
    createdAt: row.createdAt,
  };
}

/** Run fields the API exposes; `stage` and the internal start options live inside `stats`. */
export function toRun(run: RunRow) {
  const { stage, options: _options, ...stats } = run.stats as Record<string, unknown>;
  return {
    id: run.id,
    projectId: run.projectId,
    repository: run.repository,
    rootPath: run.rootPath,
    commitSha: run.commitSha,
    branch: run.branch,
    status: run.status,
    stage: run.status === 'running' && typeof stage === 'string' ? stage : null,
    error: run.error,
    parserVersion: run.parserVersion,
    isCurrent: run.isCurrent,
    stats,
    startedBy: run.startedBy,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export type RunView = ReturnType<typeof toRun>;

/** Project as returned by the API: no share token (that is only shown by the sharing endpoints). */
export function toProject(
  project: ProjectRow,
  extra: { myRole: ProjectRole | null; lastOpenedAt?: string | null; currentRun?: RunView | null },
) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    visibility: project.visibility,
    myRole: extra.myRole,
    currentRunId: project.currentRunId,
    currentRun: extra.currentRun ?? null,
    createdBy: project.createdBy,
    lastOpenedAt: extra.lastOpenedAt ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
    deletedAt: project.deletedAt,
  };
}

export function toPlan(plan: PlanRow) {
  return {
    id: plan.id,
    projectId: plan.projectId,
    runId: plan.runId,
    terraformVersion: plan.terraformVersion,
    summary: plan.summary,
    hasExplanation: plan.aiExplanation !== null,
    hasBriefing: plan.briefingAudioKey !== null,
    createdBy: plan.createdBy,
    createdAt: plan.createdAt,
  };
}

export function toPlanDetail(plan: PlanRow, changes: PlanChangeRow[]) {
  return { ...toPlan(plan), changes };
}
