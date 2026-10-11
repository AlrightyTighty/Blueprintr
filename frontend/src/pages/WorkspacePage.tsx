import { useEffect, type ReactNode } from 'react';
import TopBar from '../components/TopBar';
import { secondaryButtonClass } from '../components/ui';
import { isDemoProject } from '../config';
import AskPanel from '../features/ai/AskPanel';
import PlanInsightsPanel from '../features/ai/PlanInsightsPanel';
import FindingsPanel from '../features/findings/FindingsPanel';
import GraphView from '../features/graph-view/GraphView';
import { useGraphStore } from '../features/graph-view/useGraphStore';
import PlanPanel from '../features/plan-overlay/PlanPanel';

interface WorkspacePageProps {
  projectId: string;
  title: string;
  /** Extra header controls, e.g. a re-run button. */
  actions?: ReactNode;
}

/** The graph, findings and plan panels for one project (or the bundled demo). */
export default function WorkspacePage({ projectId, title, actions }: WorkspacePageProps) {
  const { direction, setDirection, status, errorMessage, loadGraph } = useGraphStore();

  useEffect(() => {
    void loadGraph(projectId);
  }, [projectId, loadGraph]);

  const toggleClass = (isActive: boolean) =>
    `rounded px-3 py-1 transition-colors ${
      isActive ? 'bg-violet-600 text-white' : 'bg-indigo-950 text-indigo-200 hover:bg-indigo-900'
    }`;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <TopBar title={title}>
        {isDemoProject(projectId) && (
          <span className="rounded bg-indigo-950 px-2 py-0.5 text-xs text-indigo-300">Demo data</span>
        )}
        {actions}
        <div className="flex gap-2">
          <button className={toggleClass(direction === 'dependents')} onClick={() => setDirection('dependents')}>
            What breaks?
          </button>
          <button
            className={toggleClass(direction === 'dependencies')}
            onClick={() => setDirection('dependencies')}
          >
            What does it use?
          </button>
        </div>
      </TopBar>
      <div className="flex min-h-0 flex-1">
        <FindingsPanel />
        <main className="flex-1">
          {status === 'ready' && <GraphView />}
          {status === 'loading' && (
            <div className="flex h-full items-center justify-center text-indigo-300">Loading graph…</div>
          )}
          {status === 'error' && (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="max-w-md text-center text-rose-300">{errorMessage}</p>
              <button className={secondaryButtonClass} onClick={() => void loadGraph(projectId)}>
                Retry
              </button>
            </div>
          )}
        </main>
        <aside className="flex w-80 flex-col overflow-y-auto border-l border-indigo-900 bg-slate-950">
          <PlanPanel />
          <PlanInsightsPanel />
          <AskPanel />
        </aside>
      </div>
    </div>
  );
}
