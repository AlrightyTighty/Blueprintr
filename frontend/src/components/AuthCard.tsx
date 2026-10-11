import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import Logo from './Logo';

interface AuthCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
}

/** The centered card used by the login, register and GitHub completion pages. */
export default function AuthCard({ title, subtitle, children }: AuthCardProps) {
  return (
    <div className="flex min-h-full items-center justify-center bg-slate-950 px-4 py-10 text-slate-100">
      <div className="w-full max-w-sm">
        <Link to="/" aria-label="Ripplemap home" className="mb-6 flex items-center justify-center gap-3 text-2xl font-semibold text-indigo-200 hover:text-indigo-100">
          <Logo size={40} />
          Ripplemap
        </Link>
        <div className="rounded-lg border border-indigo-900 bg-indigo-950/40 p-6">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-slate-400">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        <p className="mt-5 text-center text-sm">
          <Link to="/" className="text-slate-400 hover:text-indigo-200">
            ← Back to home
          </Link>
        </p>
      </div>
    </div>
  );
}
