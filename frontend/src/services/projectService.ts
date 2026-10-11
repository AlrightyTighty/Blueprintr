import { apiDelete, apiGet, apiPost } from '../api';
import type {
  AnalysisRun,
  CreateProjectRequest,
  GithubConnection,
  GithubRepository,
  Project,
  ProjectDetail,
} from '../core/accounts/types';
import type { Page } from '../core/graph/types';

function buildQuery(parameters: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== '') query.set(name, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
}

/** Which of a user's projects to list: the live ones, archived ones, or the trash. */
export type ProjectScope = 'active' | 'archived' | 'trash';

export function listProjects(options: { search?: string; cursor?: string; scope?: ProjectScope } = {}): Promise<Page<Project>> {
  return apiGet<Page<Project>>(
    `/projects${buildQuery({ q: options.search, cursor: options.cursor, scope: options.scope, limit: 24 })}`,
  );
}

/** Moves a project to the trash (owner). It can be restored until it is deleted for good. */
export function deleteProject(projectId: string): Promise<void> {
  return apiDelete(`/projects/${projectId}`);
}

/** Hides a project from the main list without deleting it (owner). */
export function archiveProject(projectId: string): Promise<Project> {
  return apiPost<Project>(`/projects/${projectId}/archive`);
}

/** Brings an archived or trashed project back (owner). */
export function restoreProject(projectId: string): Promise<Project> {
  return apiPost<Project>(`/projects/${projectId}/restore`);
}

/** Permanently deletes a project that is already in the trash (owner). This cannot be undone. */
export function purgeProject(projectId: string): Promise<void> {
  return apiDelete(`/projects/${projectId}/permanent`);
}

export function getProject(projectId: string): Promise<ProjectDetail> {
  return apiGet<ProjectDetail>(`/projects/${projectId}`);
}

export function createProject(request: CreateProjectRequest): Promise<ProjectDetail> {
  return apiPost<ProjectDetail>('/projects', request);
}

export async function listGithubConnections(): Promise<GithubConnection[]> {
  const { items } = await apiGet<{ items: GithubConnection[] }>('/me/github-connections');
  return items;
}

export function listGithubRepositories(
  connectionId: string,
  search: string,
): Promise<Page<GithubRepository>> {
  return apiGet<Page<GithubRepository>>(
    `/me/github-connections/${connectionId}/repositories${buildQuery({ q: search, limit: 20 })}`,
  );
}

export function startRun(projectId: string): Promise<AnalysisRun> {
  return apiPost<AnalysisRun>(`/projects/${projectId}/runs`, {});
}

export function getRun(projectId: string, runId: string): Promise<AnalysisRun> {
  return apiGet<AnalysisRun>(`/projects/${projectId}/runs/${runId}`);
}

/** The newest run, whatever its status, or null if the project has never been analysed. */
export async function getLatestRun(projectId: string): Promise<AnalysisRun | null> {
  const page = await apiGet<Page<AnalysisRun>>(`/projects/${projectId}/runs?limit=1`);
  return page.items[0] ?? null;
}
