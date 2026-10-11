import { apiGet, apiPost } from '../api';
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

export function listProjects(options: { search?: string; cursor?: string } = {}): Promise<Page<Project>> {
  return apiGet<Page<Project>>(
    `/projects${buildQuery({ q: options.search, cursor: options.cursor, limit: 24 })}`,
  );
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
