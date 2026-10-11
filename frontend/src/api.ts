import { getSession, saveSession } from './session';

// The frontend calls the backend directly (no proxy).
// Dev: VITE_API_URL from .env.development. Prod: /config.json, written to S3 by iac/.
let apiUrlPromise: Promise<string> | undefined;

function getApiUrl(): Promise<string> {
  apiUrlPromise ??= import.meta.env.VITE_API_URL
    ? Promise.resolve(import.meta.env.VITE_API_URL)
    : fetch('/config.json')
        .then((res) => res.json() as Promise<{ apiUrl: string }>)
        .then((config) => config.apiUrl);
  // Strip any trailing '/' so paths can always start with one.
  return apiUrlPromise.then((url) => url.replace(/\/$/, ''));
}

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly fieldErrors: FieldError[] = [],
  ) {
    super(message);
  }
}

/** The backend returns errors as application/problem+json; prefer its detail over a bare status. */
async function describeFailure(method: string, path: string, res: Response): Promise<ApiError> {
  let detail = '';
  let fieldErrors: FieldError[] = [];
  try {
    const problem = (await res.json()) as { title?: string; detail?: string; errors?: FieldError[] };
    detail = problem.detail ?? problem.title ?? '';
    fieldErrors = problem.errors ?? [];
  } catch {
    // Not JSON; fall back to the status line below.
  }
  return new ApiError(detail || `${method} ${path} failed: ${res.status}`, res.status, fieldErrors);
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const token = getSession()?.token;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${await getApiUrl()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    // An expired or revoked token: sign out so route guards send the user to the login page.
    if (res.status === 401 && token) saveSession(null);
    throw await describeFailure(method, path, res);
  }
  return res.status === 204 ? (undefined as T) : (res.json() as Promise<T>);
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export function apiDelete(path: string): Promise<void> {
  return request<void>('DELETE', path);
}
