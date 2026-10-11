import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import AuthCard from '../components/AuthCard';
import { inputClass, labelClass, primaryButtonClass } from '../components/ui';
import { requestPasswordReset } from '../services/passwordService';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSent, setIsSent] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      await requestPasswordReset(email.trim());
      setIsSent(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not send the email.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthCard title="Reset your password" subtitle="We will email you a link to choose a new one.">
      {isSent ? (
        <p className="text-sm text-slate-300">If an account uses {email.trim()}, a reset link is on its way. It expires soon, so use it right away.</p>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="email" className={labelClass}>
              Email
            </label>
            <input id="email" type="email" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required autoFocus />
          </div>
          {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}
          <button type="submit" className={primaryButtonClass} disabled={isSubmitting}>
            {isSubmitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}
      <p className="mt-5 text-sm">
        <Link to="/login" className="text-indigo-300 hover:text-indigo-200">
          Back to sign in
        </Link>
      </p>
    </AuthCard>
  );
}
