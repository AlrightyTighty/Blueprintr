import { getConfig } from '../config.js';
import { AppError, badGateway, conflict, notConfigured, notFound } from '../http/errors.js';
import { readTarGz, type TarFile } from './tar.js';

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  /** Primary verified email when GitHub exposes one. */
  email: string | null;
  avatarUrl: string | null;
}

export interface GithubRepo {
  githubId: number;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  isPrivate: boolean;
}

export interface RepoFile {
  /** Path relative to the repository root. */
  path: string;
  content: string;
}

export interface DownloadOptions {
  /** Only files under this folder are returned ('' for the whole repository). */
  rootPath: string;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export interface GithubClient {
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<{ accessToken: string; scopes: string[] }>;
  getProfile(accessToken: string): Promise<GithubProfile>;
  listRepositories(accessToken: string, options: { page: number; q?: string }): Promise<{ items: GithubRepo[]; nextPage: number | null }>;
  getRepository(accessToken: string, githubId: number): Promise<GithubRepo>;
  /** Resolves a branch, tag or SHA to a full commit SHA. */
  resolveCommit(accessToken: string, fullName: string, ref: string): Promise<string>;
  /** Source files (Terraform and app code) at a commit, read from GitHub's tarball. Never executed. */
  downloadFiles(accessToken: string, fullName: string, sha: string, options: DownloadOptions): Promise<RepoFile[]>;
}

const API = 'https://api.github.com';
const SOURCE_EXTENSIONS = new Set(['.tf', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
const SKIPPED_FOLDERS = ['node_modules/', '.terraform/', 'dist/', 'build/', 'vendor/', 'venv/', '.venv/', 'site-packages/', '__pycache__/', '.git/'];

export function isAnalyzablePath(path: string): boolean {
  if (SKIPPED_FOLDERS.some((folder) => path.startsWith(folder) || path.includes(`/${folder}`))) return false;
  const base = path.slice(path.lastIndexOf('/') + 1);
  if (base.endsWith('.min.js') || base.endsWith('.d.ts') || base.startsWith('._')) return false; // minified, typings, macOS AppleDouble
  const dot = base.lastIndexOf('.');
  return dot !== -1 && SOURCE_EXTENSIONS.has(base.slice(dot));
}

function headers(accessToken?: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'blueprint-app',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    ...extra,
  };
}

async function github(path: string, accessToken: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
      ...init,
      headers: { ...headers(accessToken), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw badGateway('GitHub', 'Could not reach GitHub.');
  }
  if (res.status === 401) throw conflict('github_token_invalid', 'GitHub rejected the stored token. Reconnect your GitHub account.');
  if (res.status === 403 || res.status === 429) {
    throw new AppError(502, 'github_rate_limited', 'Upstream service failed', 'GitHub refused the request (rate limit or permissions).');
  }
  if (res.status === 404) throw notFound('The GitHub resource (it may not exist, or your account cannot see it)');
  if (!res.ok) throw badGateway('GitHub', `GitHub responded with ${res.status}.`);
  return res;
}

function toRepo(raw: any): GithubRepo {
  return {
    githubId: raw.id,
    fullName: raw.full_name,
    defaultBranch: raw.default_branch ?? 'main',
    htmlUrl: raw.html_url,
    isPrivate: Boolean(raw.private),
  };
}

export class HttpGithubClient implements GithubClient {
  private credentials() {
    const config = getConfig();
    if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET || !config.GITHUB_REDIRECT_URI) {
      throw notConfigured('GitHub OAuth');
    }
    return { id: config.GITHUB_CLIENT_ID, secret: config.GITHUB_CLIENT_SECRET, redirect: config.GITHUB_REDIRECT_URI };
  }

  authorizeUrl(state: string): string {
    const { id, redirect } = this.credentials();
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', id);
    url.searchParams.set('redirect_uri', redirect);
    url.searchParams.set('scope', 'read:user user:email repo');
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; scopes: string[] }> {
    const { id, secret, redirect } = this.credentials();
    let res: Response;
    try {
      res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'blueprint-app' },
        body: JSON.stringify({ client_id: id, client_secret: secret, code, redirect_uri: redirect }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw badGateway('GitHub', 'Could not reach GitHub.');
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string };
    if (!res.ok || !body.access_token) {
      throw new AppError(400, 'github_code_invalid', 'Bad request', 'GitHub did not accept the authorization code.');
    }
    return { accessToken: body.access_token, scopes: (body.scope ?? '').split(',').filter(Boolean) };
  }

  async getProfile(accessToken: string): Promise<GithubProfile> {
    const user = (await (await github('/user', accessToken)).json()) as any;
    let email: string | null = null;
    try {
      const emails = (await (await github('/user/emails', accessToken)).json()) as { email: string; primary: boolean; verified: boolean }[];
      email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
    } catch {
      email = user.email ?? null;
    }
    return { id: user.id, login: user.login, name: user.name ?? null, email, avatarUrl: user.avatar_url ?? null };
  }

  async listRepositories(accessToken: string, options: { page: number; q?: string }) {
    const fetchPage = async (page: number) => {
      const res = await github(
        `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`,
        accessToken,
      );
      const items = ((await res.json()) as any[]).map(toRepo);
      return { items, hasMore: items.length === 100 };
    };

    if (!options.q) {
      const { items, hasMore } = await fetchPage(options.page);
      return { items, nextPage: hasMore ? options.page + 1 : null };
    }
    // GitHub can't filter this endpoint by name, so scan up to 5 pages ourselves.
    const needle = options.q.toLowerCase();
    const matches: GithubRepo[] = [];
    for (let page = 1; page <= 5; page++) {
      const { items, hasMore } = await fetchPage(page);
      matches.push(...items.filter((r) => r.fullName.toLowerCase().includes(needle)));
      if (!hasMore) break;
    }
    return { items: matches, nextPage: null };
  }

  async getRepository(accessToken: string, githubId: number): Promise<GithubRepo> {
    return toRepo(await (await github(`/repositories/${githubId}`, accessToken)).json());
  }

  async resolveCommit(accessToken: string, fullName: string, ref: string): Promise<string> {
    const res = await github(`/repos/${fullName}/commits/${encodeURIComponent(ref)}`, accessToken, {
      headers: { Accept: 'application/vnd.github.sha' },
    });
    return (await res.text()).trim();
  }

  async downloadFiles(accessToken: string, fullName: string, sha: string, options: DownloadOptions): Promise<RepoFile[]> {
    const root = options.rootPath.replace(/^\/+|\/+$/g, '');
    const prefix = root ? `${root}/` : '';
    const res = await github(`/repos/${fullName}/tarball/${sha}`, accessToken);
    if (!res.body) throw badGateway('GitHub', 'GitHub returned an empty archive.');

    let tarFiles: TarFile[];
    try {
      tarFiles = await readTarGz(res.body, {
        maxTotalBytes: options.maxTotalBytes,
        want: (path, size) => path.startsWith(prefix) && size <= options.maxFileBytes && isAnalyzablePath(path),
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes('too large')) throw new AppError(422, 'repository_too_large', 'Validation failed', err.message);
      throw badGateway('GitHub', 'Could not read the repository archive.');
    }
    if (tarFiles.length > options.maxFiles) {
      throw new AppError(422, 'repository_too_large', 'Validation failed', `More than ${options.maxFiles} source files; link a subfolder instead.`);
    }
    return tarFiles.map((f) => ({ path: f.path.slice(prefix.length), content: f.content.toString('utf8') }));
  }
}
