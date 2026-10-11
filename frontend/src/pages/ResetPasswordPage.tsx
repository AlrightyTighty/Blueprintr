import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AuthCard from '../components/AuthCard';
import { inputClass, labelClass, primaryButtonClass } from '../components/ui';
import { resetPassword } from '../services/passwordService';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const resetToken = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!resetToken) return;
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await resetPassword(resetToken, password);
      setIsDone(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not reset the password.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthCard title="Choose a new password">
      {!resetToken ? (
        <p className="text-sm text-slate-300">
          This link is incomplete.{' '}
          <Link to="/forgot-password" className="text-indigo-300 hover:text-indigo-200">
            Ask for a new one.
          </Link>
        </p>
      ) : isDone ? (
        <p className="text-sm text-slate-300">
          Your password is changed and every other device was signed out.{' '}
          <Link to="/login" className="text-indigo-300 hover:text-indigo-200">
            Go to sign in
          </Link>
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="new-password" className={labelClass}>
              New password
            </label>
            <input id="new-password" type="password" className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required autoFocus />
          </div>
          {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}
          <button type="submit" className={primaryButtonClass} disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      )}
    </AuthCard>
  );
}
