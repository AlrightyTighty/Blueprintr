import { apiGet, apiPost } from '../api';
import type { AuthSession, GithubAuthIntent, GithubCallbackResult } from '../core/accounts/types';

export function login(identifier: string, password: string): Promise<AuthSession> {
  return apiPost<AuthSession>('/auth/login', { identifier, password });
}

export interface RegisterRequest {
  username: string;
  email: string;
  password: string;
  displayName?: string;
}

/** Sends a fresh verification link to the signed-in user's address. */
export function resendVerificationEmail(): Promise<void> {
  return apiPost<void>('/auth/email/resend');
}

export function register(request: RegisterRequest): Promise<AuthSession> {
  return apiPost<AuthSession>('/auth/register', request);
}

/** Where to send the browser to start a GitHub OAuth flow. `link` needs a signed-in user. */
export async function getGithubAuthorizeUrl(intent: GithubAuthIntent): Promise<string> {
  const { authorizeUrl } = await apiGet<{ authorizeUrl: string; state: string }>(
    `/auth/github/authorize?intent=${intent}`,
  );
  return authorizeUrl;
}

export function finishGithubCallback(code: string, state: string): Promise<GithubCallbackResult> {
  return apiPost<GithubCallbackResult>('/auth/github/callback', { code, state });
}

export interface CompleteGithubSignupRequest extends RegisterRequest {
  registrationToken: string;
}

export function completeGithubSignup(request: CompleteGithubSignupRequest): Promise<AuthSession> {
  return apiPost<AuthSession>('/auth/github/complete', request);
}
