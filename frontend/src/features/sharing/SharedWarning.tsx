import { useEffect, useState } from 'react';
import { useAuthStore } from '../auth/useAuthStore';
import { getSharing, listMembers } from '../../services/sharingService';

interface SharedWarningProps {
  projectId: string;
}

/**
 * A warning line for the delete dialogs: says who else would lose the project. Shows nothing while it
 * checks, when the project is private, or if the check fails (the delete itself is still guarded).
 */
export default function SharedWarning({ projectId }: SharedWarningProps) {
  const myUserId = useAuthStore((state) => state.session?.user.id);
  const [otherPeople, setOtherPeople] = useState(0);
  const [hasPublicLink, setHasPublicLink] = useState(false);

  useEffect(() => {
    let isCurrent = true;
    Promise.all([listMembers(projectId), getSharing(projectId)]).then(
      ([members, sharing]) => {
        if (!isCurrent) return;
        setOtherPeople(members.filter((member) => member.user.id !== myUserId).length);
        setHasPublicLink(sharing.visibility === 'link_view');
      },
      () => undefined,
    );
    return () => {
      isCurrent = false;
    };
  }, [projectId, myUserId]);

  if (otherPeople === 0 && !hasPublicLink) return null;

  const who = [
    otherPeople > 0 ? (otherPeople === 1 ? '1 other person' : `${otherPeople} other people`) : null,
    hasPublicLink ? 'anyone with its read-only link' : null,
  ]
    .filter(Boolean)
    .join(' and ');

  return (
    <p className="mt-3 rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-amber-200" role="alert">
      Heads up: this project is shared with {who}. They will lose access when it is deleted.
    </p>
  );
}
