import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import AuthCard from '../components/AuthCard';
import { confirmEmail } from '../services/passwordService';

type Outcome = 'working' | 'confirmed' | 'failed';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const verificationToken = searchParams.get('token');
  const [outcome, setOutcome] = useState<Outcome>(verificationToken ? 'working' : 'failed');
  const hasStarted = useRef(false); // React strict mode runs effects twice, and the link works only once

  useEffect(() => {
    if (!verificationToken || hasStarted.current) return;
    hasStarted.current = true;
    confirmEmail(verificationToken).then(
      () => setOutcome('confirmed'),
      () => setOutcome('failed'),
    );
  }, [verificationToken]);

  return (
    <AuthCard title="Confirm your email">
      <p className="text-sm text-slate-300">
        {outcome === 'working' && 'Checking your link…'}
        {outcome === 'confirmed' && 'Your email address is confirmed.'}
        {outcome === 'failed' && 'This link is invalid or has expired. Sign in and ask for a new one.'}
      </p>
      <p className="mt-5 text-sm">
        <Link to="/projects" className="text-indigo-300 hover:text-indigo-200">
          Continue to Ripplemap
        </Link>
      </p>
    </AuthCard>
  );
}
