import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../api';
import AuthCard from '../components/AuthCard';
import { formatDateTime, primaryButtonClass, secondaryButtonClass } from '../components/ui';
import type { InvitePreview } from '../core/accounts/types';
import { useAuthStore } from '../features/auth/useAuthStore';
import { acceptInvite, previewInvite } from '../services/sharingService';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; invite: InvitePreview }
  | { kind: 'unavailable'; message: string };

const ROLE_SENTENCE = { editor: 'edit it', viewer: 'view it' } as const;

/** Opened from an invitation link. Anyone can see what the invite is for; accepting needs an account. */
export default function InvitePage() {
  const { token = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const session = useAuthStore((state) => state.session);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [isJoining, setIsJoining] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [alreadyMemberOf, setAlreadyMemberOf] = useState<string | null>(null);

  useEffect(() => {
    let isCancelled = false;
    previewInvite(token)
      .then((invite) => {
        if (!isCancelled) setState({ kind: 'ready', invite });
      })
      .catch((error: unknown) => {
        if (isCancelled) return;
        const message =
          error instanceof ApiError && error.status === 410
            ? 'This invitation has expired, was withdrawn, or has already been used. Ask the owner for a new one.'
            : error instanceof ApiError && error.status === 404
              ? "We couldn't find this invitation. Check that the whole link was copied."
              : error instanceof Error
                ? error.message
                : 'Could not open this invitation.';
        setState({ kind: 'unavailable', message });
      });
    return () => {
      isCancelled = true;
    };
  }, [token]);

  async function handleJoin() {
    setIsJoining(true);
    setErrorMessage(null);
    try {
      const project = await acceptInvite(token);
      navigate(`/projects/${project.id}`, { replace: true });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setAlreadyMemberOf('this project');
      setErrorMessage(error instanceof ApiError ? error.friendlyMessage : error instanceof Error ? error.message : 'Could not join.');
      setIsJoining(false);
    }
  }

  if (state.kind === 'loading') {
    return (
      <AuthCard title="Opening invitation…">
        <p className="text-sm text-slate-400">One moment.</p>
      </AuthCard>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <AuthCard title="Invitation unavailable">
        <p className="text-sm text-slate-300">{state.message}</p>
        <Link to="/" className={`${secondaryButtonClass} mt-4 inline-block`}>
          Go to Ripplemap
        </Link>
      </AuthCard>
    );
  }

  const { invite } = state;
  // After signing in or creating an account, come straight back here to accept.
  const returnState = { from: location.pathname };
  const inviter = invite.invitedBy?.displayName || invite.invitedBy?.username;

  return (
    <AuthCard title={`Join “${invite.projectName}”`} subtitle={inviter ? `${inviter} invited you to ${ROLE_SENTENCE[invite.role]}.` : `You're invited to ${ROLE_SENTENCE[invite.role]}.`}>
      <p className="text-sm text-slate-400">
        You'll join as {invite.role === 'editor' ? 'an editor' : 'a viewer'}. The invitation expires {formatDateTime(invite.expiresAt)}.
      </p>

      {errorMessage && <p className="mt-3 text-sm text-rose-300">{errorMessage}</p>}

      {session ? (
        <div className="mt-5 flex flex-col gap-2">
          {alreadyMemberOf ? (
            <Link to="/projects" className={primaryButtonClass + ' text-center'}>
              Go to your projects
            </Link>
          ) : (
            <button className={primaryButtonClass} disabled={isJoining} onClick={handleJoin}>
              {isJoining ? 'Joining…' : 'Join project'}
            </button>
          )}
          <p className="text-xs text-slate-500">Signed in as {session.user.displayName || session.user.username}.</p>
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-2">
          <Link to="/login" state={returnState} className={primaryButtonClass + ' text-center'}>
            Sign in to join
          </Link>
          <Link to="/register" state={returnState} className={secondaryButtonClass + ' text-center'}>
            Create an account
          </Link>
        </div>
      )}
    </AuthCard>
  );
}
