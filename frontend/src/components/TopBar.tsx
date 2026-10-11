import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../features/auth/useAuthStore';
import { secondaryButtonClass } from './ui';

interface TopBarProps {
  /** Shown after the logo, e.g. the current project's name. */
  title?: string;
  /** Page-specific controls, placed before the account menu. */
  children?: ReactNode;
}

export default function TopBar({ title, children }: TopBarProps) {
  const { session, signOut } = useAuthStore();

  return (
    <header className="flex items-center justify-between border-b border-indigo-900 px-4 py-2">
      <div className="flex items-center gap-3">
        <Link to={session ? '/projects' : '/'} className="text-lg font-semibold text-indigo-200">
          Ripplemap
        </Link>
        {title && <span className="text-slate-400">/</span>}
        {title && <span className="text-slate-200">{title}</span>}
      </div>
      <div className="flex items-center gap-3 text-sm">
        {children}
        {session ? (
          <>
            <span className="text-slate-400">{session.user.displayName ?? session.user.username}</span>
            <button className={`${secondaryButtonClass} !px-3 !py-1`} onClick={signOut}>
              Sign out
            </button>
          </>
        ) : (
          <Link to="/login" className="text-indigo-300 hover:text-indigo-200">
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}
