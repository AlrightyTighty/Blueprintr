import { apiPost } from '../api';

/** Emails a reset link. The server answers the same whether or not the address has an account. */
export function requestPasswordReset(email: string): Promise<void> {
  return apiPost<void>('/auth/password/forgot', { email });
}

export function resetPassword(token: string, password: string): Promise<void> {
  return apiPost<void>('/auth/password/reset', { token, password });
}

export function confirmEmail(token: string): Promise<void> {
  return apiPost<void>('/auth/email/verify', { token });
}
