// The signed-in session, kept in localStorage so a refresh doesn't sign you out. Plain module with no
// app imports so api.ts can read the token without a dependency cycle.
import type { AuthSession } from './core/accounts/types';

const STORAGE_KEY = 'ripplemap.session';

type SessionListener = (session: AuthSession | null) => void;
const listeners = new Set<SessionListener>();

function readStoredSession(): AuthSession | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const session = JSON.parse(stored) as AuthSession;
    return new Date(session.expiresAt) > new Date() ? session : null;
  } catch {
    // Storage can be blocked or hold garbage; treat both as signed out.
    return null;
  }
}

let currentSession: AuthSession | null = readStoredSession();

export function getSession(): AuthSession | null {
  return currentSession;
}

export function saveSession(session: AuthSession | null): void {
  currentSession = session;
  try {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Still signed in for this tab; it just won't survive a refresh.
  }
  listeners.forEach((listener) => listener(session));
}

export function subscribeToSession(listener: SessionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
