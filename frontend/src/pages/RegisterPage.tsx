import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, type FieldError } from '../api';
import AuthCard from '../components/AuthCard';
import { inputClass, labelClass, primaryButtonClass } from '../components/ui';
import GithubButton from '../features/auth/GithubButton';
import { useAuthStore } from '../features/auth/useAuthStore';
import { register } from '../services/authService';

const MINIMUM_PASSWORD_LENGTH = 10;

export default function RegisterPage() {
  const { session, signIn } = useAuthStore();
  const navigate = useNavigate();
  const location = useLocation();
  // Where to go once the account exists, e.g. back to an invitation that sent them here.
  const returnPath = (location.state as { from?: string } | null)?.from ?? '/projects';
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldError[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (session) return <Navigate to={returnPath} replace />;

  const errorFor = (field: string) => fieldErrors.find((fieldError) => fieldError.field === field)?.message;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setFieldErrors([]);
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setFieldErrors([{ field: 'password', message: `Use at least ${MINIMUM_PASSWORD_LENGTH} characters.` }]);
      return;
    }

    setIsSubmitting(true);
    try {
      signIn(
        await register({
          username: username.trim(),
          email: email.trim(),
          password,
          ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
        }),
      );
      navigate(returnPath, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.fieldErrors.length > 0) setFieldErrors(error.fieldErrors);
      else setErrorMessage(error instanceof Error ? error.message : 'Could not create the account.');
      setIsSubmitting(false);
    }
  }

  function renderField(
    id: string,
    label: string,
    value: string,
    onChange: (value: string) => void,
    options: { type?: string; required?: boolean; hint?: string; autoComplete?: string } = {},
  ) {
    return (
      <div>
        <label htmlFor={id} className={labelClass}>
          {label}
        </label>
        <input
          id={id}
          type={options.type ?? 'text'}
          className={inputClass}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          required={options.required ?? true}
          autoComplete={options.autoComplete}
        />
        {options.hint && !errorFor(id) && <p className="mt-1 text-xs text-slate-500">{options.hint}</p>}
        {errorFor(id) && <p className="mt-1 text-xs text-rose-300">{errorFor(id)}</p>}
      </div>
    );
  }

  return (
    <AuthCard title="Create your account">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {renderField('username', 'Username', username, setUsername, {
          hint: '3–39 letters, numbers, _ or -',
          autoComplete: 'username',
        })}
        {renderField('email', 'Email', email, setEmail, { type: 'email', autoComplete: 'email' })}
        {renderField('displayName', 'Display name (optional)', displayName, setDisplayName, { required: false })}
        {renderField('password', 'Password', password, setPassword, {
          type: 'password',
          hint: `At least ${MINIMUM_PASSWORD_LENGTH} characters`,
          autoComplete: 'new-password',
        })}
        {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}
        <button type="submit" className={primaryButtonClass} disabled={isSubmitting}>
          {isSubmitting ? 'Creating account…' : 'Create account'}
        </button>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          <span className="h-px flex-1 bg-indigo-900" />
          or
          <span className="h-px flex-1 bg-indigo-900" />
        </div>
        <GithubButton intent="signup" label="Sign up with GitHub" returnPath={returnPath} onError={setErrorMessage} />
      </form>
      <p className="mt-5 text-sm text-slate-400">
        Already have an account?{' '}
        <Link to="/login" state={location.state} className="text-indigo-300 hover:text-indigo-200">
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
