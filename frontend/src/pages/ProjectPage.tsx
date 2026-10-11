import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { primaryButtonClass, secondaryButtonClass } from '../components/ui';
import type { AnalysisRun, ProjectDetail, RunStage } from '../core/accounts/types';
import { getLatestRun, getProject, getRun, startRun } from '../services/projectService';
import WorkspacePage from './WorkspacePage';

const POLL_INTERVAL_MS = 2000;

const STAGE_LABELS: Record<RunStage, string> = {
  fetching: 'Fetching the repository',
  parsing_terraform: 'Reading Terraform',
  scanning_code: 'Scanning app code',
  linking: 'Linking code to resources',
  inferring: 'Resolving ambiguous links with Gemini',
  findings: 'Checking for permission gaps and drift',
};

/** What the page shows: derived from the project's current run and its newest run. */
type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; project: ProjectDetail }
  | { kind: 'analysing'; project: ProjectDetail; run: AnalysisRun }
  | { kind: 'idle'; project: ProjectDetail; failedRun: AnalysisRun | null };

export default function ProjectPage() {
  const { projectId = '' } = useParams();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const loadProject = useCallback(async () => {
    try {
      const project = await getProject(projectId);
      const latestRun = await getLatestRun(projectId);
      if (latestRun && (latestRun.status === 'pending' || latestRun.status === 'running')) {
        setPhase({ kind: 'analysing', project, run: latestRun });
      } else if (project.currentRun?.status === 'succeeded') {
        setPhase({ kind: 'ready', project });
      } else {
        setPhase({ kind: 'idle', project, failedRun: latestRun?.status === 'failed' ? latestRun : null });
      }
    } catch (error) {
      setPhase({ kind: 'error', message: error instanceof Error ? error.message : 'Could not load the project.' });
    }
  }, [projectId]);

  useEffect(() => {
    setPhase({ kind: 'loading' });
    void loadProject();
  }, [loadProject]);

  // While an analysis is running, check on it until it finishes.
  const analysingRunId = phase.kind === 'analysing' ? phase.run.id : null;
  useEffect(() => {
    if (!analysingRunId) return;
    const timer = setInterval(() => {
      getRun(projectId, analysingRunId)
        .then((run) => {
          if (run.status === 'succeeded' || run.status === 'failed') void loadProject();
          else setPhase((current) => (current.kind === 'analysing' ? { ...current, run } : current));
        })
        .catch(() => {
          // A failed poll is usually a blip; the next tick tries again.
        });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [analysingRunId, projectId, loadProject]);

  async function handleStartAnalysis() {
    setIsStarting(true);
    setStartError(null);
    try {
      await startRun(projectId);
      await loadProject();
    } catch (error) {
      setStartError(error instanceof Error ? error.message : 'Could not start the analysis.');
    } finally {
      setIsStarting(false);
    }
  }

  const canAnalyse = phase.kind !== 'loading' && phase.kind !== 'error' && phase.project.myRole !== 'viewer';
  const hasRepository = phase.kind !== 'loading' && phase.kind !== 'error' && phase.project.repositories.length > 0;

  if (phase.kind === 'ready') {
    return (
      <WorkspacePage
        key={phase.project.currentRunId ?? projectId}
        projectId={projectId}
        title={phase.project.name}
        actions={
          canAnalyse && hasRepository ? (
            <button className={`${secondaryButtonClass} !px-3 !py-1`} disabled={isStarting} onClick={handleStartAnalysis}>
              {isStarting ? 'Starting…' : 'Re-run analysis'}
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <TopBar title={phase.kind === 'loading' || phase.kind === 'error' ? undefined : phase.project.name} />
      <main className="flex flex-1 items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          {phase.kind === 'loading' && <p className="text-indigo-300">Loading project…</p>}

          {phase.kind === 'error' && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-rose-300">{phase.message}</p>
              <Link to="/projects" className={secondaryButtonClass}>
                Back to projects
              </Link>
            </div>
          )}

          {phase.kind === 'analysing' && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-lg text-indigo-200">Analysing your repository…</p>
              <p className="text-slate-400">
                {phase.run.stage ? STAGE_LABELS[phase.run.stage] : phase.run.status === 'pending' ? 'Waiting to start' : 'Working'}
              </p>
              <p className="text-xs text-slate-500">Static analysis only. Nothing in your repo is ever run.</p>
            </div>
          )}

          {phase.kind === 'idle' && (
            <div className="flex flex-col items-center gap-3">
              {phase.failedRun ? (
                <>
                  <p className="text-lg text-rose-300">The last analysis failed.</p>
                  {phase.failedRun.error && <p className="text-sm text-slate-400">{phase.failedRun.error}</p>}
                </>
              ) : (
                <p className="text-lg text-indigo-200">This project hasn't been analysed yet.</p>
              )}
              {!hasRepository && <p className="text-sm text-slate-400">No repository is linked to this project.</p>}
              {startError && <p className="text-sm text-rose-300">{startError}</p>}
              <div className="flex gap-2">
                {canAnalyse && hasRepository && (
                  <button className={primaryButtonClass} disabled={isStarting} onClick={handleStartAnalysis}>
                    {isStarting ? 'Starting…' : phase.failedRun ? 'Try again' : 'Analyse now'}
                  </button>
                )}
                <Link to="/projects" className={secondaryButtonClass}>
                  Back to projects
                </Link>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
