import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, type FieldError } from '../api';
import AuthCard from '../components/AuthCard';
import { inputClass, labelClass, primaryButtonClass } from '../components/ui';
import { takeReturnPath } from '../features/auth/githubFlow';
import { useAuthStore } from '../features/auth/useAuthStore';
import { completeGithubSignup, finishGithubCallback } from '../services/authService';

interface PendingRegistration {
  registrationToken: string;
  prefill: { username?: string; email?: string; displayName?: string };
}

/** The redirect target GitHub sends the browser back to. Finishes the OAuth flow the backend started. */
export default function GithubCallbackPage() {
  const [searchParameters] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useAuthStore((state) => state.signIn);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pendingRegistration, setPendingRegistration] = useState<PendingRegistration | null>(null);
  // A GitHub code works once, and React StrictMode runs effects twice in development.
  const hasStartedRef = useRef(false);

  useEffect(() => {
    if (hasStartedRef.current) return;
    hasStartedRef.current = true;

    const code = searchParameters.get('code');
    const state = searchParameters.get('state');
    if (!code || !state) {
      setErrorMessage(searchParameters.get('error_description') ?? 'GitHub did not return a sign-in code.');
      return;
    }

    finishGithubCallback(code, state)
      .then((result) => {
        if (result.status === 'authenticated') {
          signIn(result.session);
          navigate(takeReturnPath('/projects'), { replace: true });
        } else if (result.status === 'linked') {
          navigate(takeReturnPath('/projects'), { replace: true });
        } else {
          setPendingRegistration({ registrationToken: result.registrationToken, prefill: result.prefill });
        }
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof Error ? error.message : 'Could not finish signing in with GitHub.');
      });
  }, [searchParameters, navigate, signIn]);

  if (pendingRegistration) return <CompleteRegistrationForm registration={pendingRegistration} />;

  return (
    <AuthCard title={errorMessage ? 'GitHub sign-in failed' : 'Signing you in…'}>
      {errorMessage ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-rose-300">{errorMessage}</p>
          <Link to="/login" className="text-sm text-indigo-300 hover:text-indigo-200">
            Back to sign in
          </Link>
        </div>
      ) : (
        <p className="text-sm text-slate-400">Talking to GitHub…</p>
      )}
    </AuthCard>
  );
}

/** A new GitHub account must confirm its username and email and choose a password. */
function CompleteRegistrationForm({ registration }: { registration: PendingRegistration }) {
  const navigate = useNavigate();
  const signIn = useAuthStore((state) => state.signIn);
  const [username, setUsername] = useState(registration.prefill.username ?? '');
  const [email, setEmail] = useState(registration.prefill.email ?? '');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const errorFor = (field: string) => fieldErrors.find((fieldError) => fieldError.field === field)?.message;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);
    setErrorMessage(null);
    setFieldErrors([]);
    try {
      signIn(
        await completeGithubSignup({
          registrationToken: registration.registrationToken,
          username: username.trim(),
          email: email.trim(),
          password,
          ...(registration.prefill.displayName ? { displayName: registration.prefill.displayName } : {}),
        }),
      );
      navigate(takeReturnPath('/projects'), { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.length > 0) setFieldErrors(error.fieldErrors);
      else setErrorMessage(error instanceof Error ? error.message : 'Could not create the account.');
      setIsSubmitting(false);
    }
  }

  const fields = [
    { id: 'username', label: 'Username', value: username, onChange: setUsername, type: 'text' },
    { id: 'email', label: 'Email', value: email, onChange: setEmail, type: 'email' },
    { id: 'password', label: 'Choose a password', value: password, onChange: setPassword, type: 'password' },
  ];

  return (
    <AuthCard title="Finish creating your account" subtitle="Confirm the details we got from GitHub.">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {fields.map((field) => (
          <div key={field.id}>
            <label htmlFor={field.id} className={labelClass}>
              {field.label}
            </label>
            <input
              id={field.id}
              type={field.type}
              className={inputClass}
              value={field.value}
              onChange={(event) => field.onChange(event.target.value)}
              required
            />
            {errorFor(field.id) && <p className="mt-1 text-xs text-rose-300">{errorFor(field.id)}</p>}
          </div>
        ))}
        {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}
        <button type="submit" className={primaryButtonClass} disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
      </form>
    </AuthCard>
  );
}
