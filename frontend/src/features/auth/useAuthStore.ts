import { create } from 'zustand';
import type { AuthSession } from '../../core/accounts/types';
import { getSession, saveSession, subscribeToSession } from '../../session';

interface AuthStoreState {
  session: AuthSession | null;
  signIn: (session: AuthSession) => void;
  signOut: () => void;
}

export const useAuthStore = create<AuthStoreState>((set) => ({
  session: getSession(),
  signIn: (session) => saveSession(session),
  signOut: () => saveSession(null),
}));

// Keeps the store in step when api.ts signs the user out after a 401.
subscribeToSession((session) => useAuthStore.setState({ session }));
