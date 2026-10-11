import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import AuthCard from '../components/AuthCard';
import { inputClass, labelClass, primaryButtonClass } from '../components/ui';
import GithubButton from '../features/auth/GithubButton';
import { useAuthStore } from '../features/auth/useAuthStore';
import { login } from '../services/authService';

export default function LoginPage() {
  const { session, signIn } = useAuthStore();
  const navigate = useNavigate();
  const returnPath = (useLocation().state as { from?: string } | null)?.from ?? '/projects';
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (session) return <Navigate to={returnPath} replace />;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      signIn(await login(identifier.trim(), password));
      navigate(returnPath, { replace: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not sign in.');
      setIsSubmitting(false);
    }
  }

  return (
    <AuthCard title="Sign in" subtitle="See what breaks before you apply.">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div>
          <label htmlFor="identifier" className={labelClass}>
            Username or email
          </label>
          <input
            id="identifier"
            className={inputClass}
            value={identifier}
            onChange={(event) => setIdentifier(event.target.value)}
            autoComplete="username"
            required
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="password" className={labelClass}>
            Password
          </label>
          <input
            id="password"
            type="password"
            className={inputClass}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}
        <button type="submit" className={primaryButtonClass} disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="h-px flex-1 bg-indigo-900" />
          or
          <span className="h-px flex-1 bg-indigo-900" />
        </div>
        <GithubButton intent="login" label="Continue with GitHub" returnPath={returnPath} onError={setErrorMessage} />
      </form>
      <div className="mt-5 flex justify-between text-sm">
        <Link to="/register" className="text-indigo-300 hover:text-indigo-200">
          Create an account
        </Link>
        <Link to="/demo" className="text-indigo-300 hover:text-indigo-200">
          Try the demo
        </Link>
      </div>
    </AuthCard>
  );
}
