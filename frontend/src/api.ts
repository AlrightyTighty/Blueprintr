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

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${await getApiUrl()}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json() as Promise<T>;
}
