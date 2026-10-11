import { randomBytes } from 'node:crypto';
import { badGateway, notFound } from '../src/http/errors.js';
import type { ElevenLabsClient } from '../src/integrations/elevenlabs.js';
import type { GeminiClient } from '../src/integrations/gemini.js';
import type { GithubClient, GithubProfile, GithubRepo, RepoFile } from '../src/integrations/github.js';
import type { Integrations } from '../src/integrations/registry.js';
import type { Mailer } from '../src/lib/mailer.js';
import { executeRun } from '../src/services/analysis.js';
import { loadFixture } from './helpers.js';

export const COMMIT = 'a'.repeat(40);

export class FakeMailer implements Mailer {
  sent: { kind: 'verify' | 'reset'; to: string; link: string }[] = [];
  async sendEmailVerification(to: string, link: string) {
    this.sent.push({ kind: 'verify', to, link });
  }
  async sendPasswordReset(to: string, link: string) {
    this.sent.push({ kind: 'reset', to, link });
  }
  /** The `token` query parameter of the latest mail of a kind sent to an address. */
  lastToken(kind: 'verify' | 'reset', to: string): string {
    const mail = [...this.sent].reverse().find((m) => m.kind === kind && m.to === to);
    if (!mail) throw new Error(`no ${kind} mail sent to ${to}`);
    return new URL(mail.link).searchParams.get('token')!;
  }
}

export class FakeGithub implements GithubClient {
  /** access token -> profile */
  profiles = new Map<string, GithubProfile>();
  repos: GithubRepo[] = [
    { githubId: 5000, fullName: 'acme/orders', defaultBranch: 'main', htmlUrl: 'https://github.com/acme/orders', isPrivate: true },
    { githubId: 5001, fullName: 'acme/website', defaultBranch: 'main', htmlUrl: 'https://github.com/acme/website', isPrivate: false },
  ];
  files: RepoFile[] = loadFixture('demo');
  downloads = 0;

  /** Register the GitHub account that "code" will authenticate as. */
  grantCode(code: string, profile: GithubProfile) {
    this.profiles.set(`token-${code}`, profile);
  }
  authorizeUrl(state: string) {
    return `https://github.test/authorize?state=${state}`;
  }
  async exchangeCode(code: string) {
    if (!this.profiles.has(`token-${code}`)) throw new Error('bad code');
    return { accessToken: `token-${code}`, scopes: ['read:user', 'repo'] };
  }
  async getProfile(token: string) {
    return this.profiles.get(token)!;
  }
  async listRepositories(_token: string, options: { page: number; q?: string }) {
    const items = this.repos.filter((r) => !options.q || r.fullName.includes(options.q));
    return { items, nextPage: null };
  }
  async getRepository(_token: string, githubId: number) {
    const repo = this.repos.find((r) => r.githubId === githubId);
    if (!repo) throw new Error('not found');
    return repo;
  }
  async getRepositoryByName(token: string | null, fullName: string) {
    const repo = this.repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
    // Like GitHub: a private repository looks like it does not exist to someone who cannot see it.
    if (!repo || (repo.isPrivate && !token)) throw notFound('The GitHub repository');
    return repo;
  }
  /** When set, only these branch names resolve; others fail like GitHub's "no commit found". */
  branches: Set<string> | null = null;
  /** The token each download used (null = a public, tokenless read). */
  downloadTokens: (string | null)[] = [];
  async resolveCommit(_token: string | null, _fullName: string, ref: string) {
    const isSha = /^[0-9a-f]{40}$/.test(ref);
    if (this.branches && !isSha && !this.branches.has(ref)) throw badGateway('GitHub', 'No commit found.');
    return isSha ? ref : COMMIT;
  }
  async downloadFiles(token: string | null, _fullName: string, _sha: string, options: { rootPath: string }) {
    this.downloadTokens.push(token);
    this.downloads++;
    const prefix = options.rootPath ? `${options.rootPath}/` : '';
    return this.files.filter((f) => f.path.startsWith(prefix)).map((f) => ({ ...f, path: f.path.slice(prefix.length) }));
  }
}

export class FakeGemini implements GeminiClient {
  model = 'fake-gemini';
  configured = false;
  isConfigured() {
    return this.configured;
  }
  async generate(): Promise<never> {
    throw new Error('FakeGemini.generate was not expected to be called');
  }
}

export class FakeElevenLabs implements ElevenLabsClient {
  isConfigured() {
    return true;
  }
  async synthesize(text: string) {
    return Buffer.from(`mp3:${text}`);
  }
  async getSignedUrl() {
    return { signedUrl: 'wss://elevenlabs.test/session', agentId: 'agent-1' };
  }
}

export function createFakes() {
  const mailer = new FakeMailer();
  const github = new FakeGithub();
  const gemini = new FakeGemini();
  const elevenlabs = new FakeElevenLabs();
  const audioFiles = new Map<string, Buffer>();
  const integrations: Integrations = {
    mailer,
    github,
    gemini,
    elevenlabs,
    audio: {
      isConfigured: () => true,
      put: async (key, audio) => void audioFiles.set(key, audio),
      signedUrl: async (key) => `https://audio.test/${key}?sig=${randomBytes(4).toString('hex')}`,
    },
    // Run the analysis before the request returns, so tests don't have to poll.
    dispatcher: { dispatch: (runId) => executeRun(runId) },
  };
  return { integrations, mailer, github, gemini, elevenlabs, audioFiles };
}
