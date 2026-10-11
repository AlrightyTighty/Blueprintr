import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError, setShareToken } from '../api';
import TopBar from '../components/TopBar';
import { secondaryButtonClass } from '../components/ui';
import type { ProjectDetail } from '../core/accounts/types';
import { getSharedProject } from '../services/sharingService';
import WorkspacePage from './WorkspacePage';

type State = { kind: 'loading' } | { kind: 'missing' } | { kind: 'error'; message: string } | { kind: 'ready'; project: ProjectDetail };

/** Where a file path in the project can be opened on GitHub, from its first linked repository. */
function sourceBaseUrlFor(project: ProjectDetail): string | undefined {
  const link = project.repositories[0];
  if (!link) return undefined;
  const rootPath = link.rootPath ? `/${link.rootPath.replace(/^\/+|\/+$/g, '')}` : '';
  return `${link.repository.htmlUrl}/blob/${link.branch}${rootPath}`;
}

function Message({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <TopBar />
      <main className="flex flex-1 items-center justify-center px-4">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <p className="text-lg text-indigo-200">{title}</p>
          <div className="text-sm text-slate-400">{children}</div>
          <Link to="/" className={secondaryButtonClass}>
            Go to Ripplemap
          </Link>
        </div>
      </main>
    </div>
  );
}

/** A project opened through its read-only share link. No account is needed. */
export default function SharedProjectPage() {
  const { shareToken = '' } = useParams();
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let isCancelled = false;
    setState({ kind: 'loading' });
    getSharedProject(shareToken)
      .then((project) => {
        if (isCancelled) return;
        // From here every request carries the link's token, which is what lets this visitor read the graph.
        setShareToken(shareToken);
        setState({ kind: 'ready', project });
      })
      .catch((error: unknown) => {
        if (isCancelled) return;
        if (error instanceof ApiError && error.status === 404) setState({ kind: 'missing' });
        else setState({ kind: 'error', message: error instanceof Error ? error.message : 'Could not open this link.' });
      });
    return () => {
      isCancelled = true;
      setShareToken(null);
    };
  }, [shareToken]);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-slate-950 text-indigo-300">Opening shared project…</div>
    );
  }
  if (state.kind === 'missing') {
    return (
      <Message title="This link doesn't work">
        <p>It may have been turned off or replaced by a newer one, or the project may have been deleted. Ask the owner for a fresh link.</p>
      </Message>
    );
  }
  if (state.kind === 'error') return <Message title="Couldn't open this link">{state.message}</Message>;

  const { project } = state;
  if (!project.currentRunId) {
    return (
      <Message title={project.name}>
        <p>This project hasn't been analysed yet, so there is nothing to show.</p>
      </Message>
    );
  }
  return (
    <WorkspacePage
      projectId={project.id}
      title={project.name}
      role={null}
      sourceBaseUrl={sourceBaseUrlFor(project)}
      actions={<span className="rounded bg-indigo-950 px-2 py-0.5 text-xs text-indigo-300">Shared · read only</span>}
    />
  );
}
