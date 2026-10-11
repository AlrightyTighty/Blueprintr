// Accounts, projects and analysis runs, mirroring backend/openapi.yaml. Keep this file free of React.

export interface User {
  id: string;
  username: string;
  email: string;
  emailVerified: boolean;
  displayName?: string | null;
  avatarUrl?: string | null;
  createdAt: string;
}

export interface AuthSession {
  /** JWT for the Authorization header. */
  token: string;
  expiresAt: string;
  user: User;
}

export type GithubAuthIntent = 'login' | 'signup' | 'link';

export type GithubCallbackResult =
  | { status: 'authenticated'; session: AuthSession }
  | {
      status: 'registration_required';
      registrationToken: string;
      prefill: { username?: string; email?: string; displayName?: string; avatarUrl?: string };
    }
  | { status: 'linked'; connection: GithubConnection };

export interface GithubConnection {
  id: string;
  githubUserId: number;
  githubLogin: string;
  scopes: string[];
  createdAt: string;
}

export interface GithubRepository {
  githubId: number;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  isPrivate: boolean;
}

export interface Repository extends GithubRepository {
  id: string;
}

export interface LinkRepositoryRequest {
  connectionId: string;
  githubRepoId: number;
  branch?: string;
  /** Subfolder to analyze (monorepos). Empty means the repository root. */
  rootPath?: string;
}

export interface ProjectRepository {
  id: string;
  repository: Repository;
  branch: string;
  rootPath: string;
  linkedByConnectionId?: string | null;
  createdAt: string;
}

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type RunStage = 'fetching' | 'parsing_terraform' | 'scanning_code' | 'linking' | 'inferring' | 'findings';

export interface AnalysisRun {
  id: string;
  projectId: string;
  repository?: Repository | null;
  rootPath?: string;
  commitSha?: string | null;
  branch?: string | null;
  status: RunStatus;
  /** Progress while `status` is `running`. */
  stage?: RunStage | null;
  error?: string | null;
  parserVersion: string;
  isCurrent?: boolean;
  /** e.g. node, edge and finding counts, and how many edges were inferred. */
  stats?: Record<string, unknown>;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description?: string | null;
  visibility: 'private' | 'link_view';
  /** Null when viewing through a share link. */
  myRole: ProjectRole | null;
  currentRunId?: string | null;
  currentRun?: AnalysisRun | null;
  lastOpenedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectDetail extends Project {
  repositories: ProjectRepository[];
  memberCount: number;
  /** Open (not dismissed) findings in the current run, by severity. */
  openFindingCounts: Record<string, number>;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  repositories?: LinkRepositoryRequest[];
  /** Start an analysis of the linked repositories immediately. */
  analyze?: boolean;
}
