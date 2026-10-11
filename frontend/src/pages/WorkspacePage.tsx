import { useEffect, type ReactNode } from 'react';
import TopBar from '../components/TopBar';
import { secondaryButtonClass } from '../components/ui';
import type { ProjectRole } from '../core/accounts/types';
import { isDemoProject } from '../config';
import AskPanel from '../features/ai/AskPanel';
import PlanInsightsPanel from '../features/ai/PlanInsightsPanel';
import GraphView from '../features/graph-view/GraphView';
import { useGraphStore } from '../features/graph-view/useGraphStore';
import PlanPanel from '../features/plan-overlay/PlanPanel';
import VoiceModeControl from '../features/voice/VoiceModeControl';
import TourDock from '../features/tour-player/TourDock';
import TourPanel from '../features/tour-player/TourPanel';

interface WorkspacePageProps {
  projectId: string;
  title: string;
  /** Extra header controls, e.g. a re-run button. */
  actions?: ReactNode;
  /** e.g. https://github.com/acme/app/blob/main, so tour stops can link to the real code. */
  sourceBaseUrl?: string;
  /**
   * What the person looking may do. Viewers, and people using a read-only share link (null), can explore the
   * graph, findings and tours but not upload plans or use the AI features, which need an editor.
   */
  role?: ProjectRole | null;
}

/** The graph, findings and plan panels for one project (or the bundled demo). */
export default function WorkspacePage({ projectId, title, actions, sourceBaseUrl, role = 'owner' }: WorkspacePageProps) {
  const isViewOnly = role === null || role === 'viewer';
  const { direction, setDirection, status, errorMessage, loadGraph, graph } = useGraphStore();

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
        <VoiceModeControl />
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
        <TourPanel canUsePlans={!isViewOnly} />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1">
            {status === 'ready' && graph.nodes.length > 0 && <GraphView />}
            {status === 'ready' && graph.nodes.length === 0 && (
              <div className="flex h-full items-center justify-center px-6">
                <div className="max-w-md text-center">
                  <p className="text-lg text-indigo-200">Nothing to draw yet</p>
                  <p className="mt-2 text-sm text-slate-400">
                    Ripplemap read this repository but found no AWS resources it supports (Lambda, S3, DynamoDB, SQS,
                    IAM, API Gateway, CloudFront, Route 53), and no code that uses them. Terraform modules, count and
                    for_each aren't supported yet. If the infrastructure lives in a subfolder, link that folder instead.
                  </p>
                </div>
              </div>
            )}
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
          {status === 'ready' && <TourDock projectId={projectId} sourceBaseUrl={sourceBaseUrl} />}
        </div>
        <aside className="flex w-80 flex-col overflow-y-auto border-l border-indigo-900 bg-slate-950">
          {isViewOnly ? (
            <div className="p-4 text-sm">
              <h2 className="font-semibold text-indigo-200">View only</h2>
              <p className="mt-2 text-slate-400">
                You can explore the graph, take the tours and read the findings. Uploading a plan and asking the guide
                questions need an editor.
              </p>
            </div>
          ) : (
            <>
              <PlanPanel />
              <PlanInsightsPanel />
              <AskPanel />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
