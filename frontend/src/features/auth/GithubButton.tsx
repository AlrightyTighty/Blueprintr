import { useState } from 'react';
import type { GithubAuthIntent } from '../../core/accounts/types';
import { secondaryButtonClass } from '../../components/ui';
import { startGithubFlow } from './githubFlow';

interface GithubButtonProps {
  intent: GithubAuthIntent;
  label: string;
  /** Where to land after the GitHub round trip. */
  returnPath: string;
  onError: (message: string) => void;
}

export default function GithubButton({ intent, label, returnPath, onError }: GithubButtonProps) {
  const [isRedirecting, setIsRedirecting] = useState(false);

  async function handleClick() {
    setIsRedirecting(true);
    try {
      await startGithubFlow(intent, returnPath);
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not reach GitHub.');
      setIsRedirecting(false);
    }
  }

  return (
    <button type="button" className={`${secondaryButtonClass} w-full`} disabled={isRedirecting} onClick={handleClick}>
      {isRedirecting ? 'Redirecting…' : label}
    </button>
  );
}
