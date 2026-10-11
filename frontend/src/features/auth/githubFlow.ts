import type { GithubAuthIntent } from '../../core/accounts/types';
import { getGithubAuthorizeUrl } from '../../services/authService';

const RETURN_PATH_KEY = 'ripplemap.postAuthPath';

/** Remembers where to go once GitHub sends the browser back to /auth/github/callback. */
export function rememberReturnPath(path: string): void {
  try {
    sessionStorage.setItem(RETURN_PATH_KEY, path);
  } catch {
    // Storage blocked: the user lands on the default page after the round trip.
  }
}

/** Reads and clears the remembered path. */
export function takeReturnPath(fallback: string): string {
  try {
    const path = sessionStorage.getItem(RETURN_PATH_KEY);
    sessionStorage.removeItem(RETURN_PATH_KEY);
    return path ?? fallback;
  } catch {
    return fallback;
  }
}

/** Sends the browser to GitHub. Throws if the backend can't start the flow. */
export async function startGithubFlow(intent: GithubAuthIntent, returnPath: string): Promise<void> {
  const authorizeUrl = await getGithubAuthorizeUrl(intent);
  rememberReturnPath(returnPath);
  window.location.assign(authorizeUrl);
}
