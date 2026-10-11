/** What a pasted GitHub link says about the repository (and, for /tree/ links, the branch and folder). */
export interface ParsedGithubUrl {
  /** "owner/repo", without a ".git" ending. */
  fullName: string;
  /**
   * The path segments after /tree/ or /blob/: a branch and then a folder, for example
   * ["feature", "x", "infra"]. They can't be split here, because a branch name may itself contain
   * slashes; the caller works out where the branch ends by asking GitHub.
   */
  refAndPath: string[];
}

// GitHub's own rules: owners are letters, digits and hyphens (up to 39); repo names also allow . and _.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const MAX_LENGTH = 500;

function decode(segment: string): string | null {
  try {
    const decoded = decodeURIComponent(segment);
    // No control characters and no way to climb out of a folder.
    return decoded === '..' || /[\u0000-\u001f]/.test(decoded) ? null : decoded;
  } catch {
    return null;
  }
}

/**
 * Reads a GitHub repository link. Accepts https://github.com/owner/repo (with or without www, a trailing
 * slash, ".git", a query or a fragment), links to a branch or folder (/tree/main/infra) or file
 * (/blob/main/infra/main.tf), github.com/owner/repo, git@github.com:owner/repo.git, and plain owner/repo.
 * Only github.com is accepted. Returns null for anything else.
 */
export function parseGithubRepoUrl(input: string): ParsedGithubUrl | null {
  const text = input.trim();
  if (!text || text.length > MAX_LENGTH) return null;

  let path: string;
  const ssh = text.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i);
  const web = text.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i);
  if (ssh) path = ssh[1];
  else if (web) path = web[1];
  else if (/^[^/\s]+\/[^/\s]+$/.test(text)) path = text; // owner/repo; a host such as "example.com/x" fails the owner check below
  else return null;

  const segments = path.split(/[?#]/)[0].split('/').filter(Boolean);
  if (segments.length < 2) return null;

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(repo)) return null;

  const kind = segments[2];
  if (kind !== 'tree' && kind !== 'blob') return { fullName: `${owner}/${repo}`, refAndPath: [] };

  const decoded = segments.slice(3).map(decode);
  if (decoded.some((segment) => segment === null)) return null;
  const refAndPath = decoded as string[];
  // A /blob/ link ends at a file; the folder is everything before it.
  return { fullName: `${owner}/${repo}`, refAndPath: kind === 'blob' ? refAndPath.slice(0, -1) : refAndPath };
}
