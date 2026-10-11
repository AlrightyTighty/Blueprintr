import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime, primaryButtonClass, secondaryButtonClass, inputClass } from '../components/ui';
import TopBar from '../components/TopBar';
import type { Project, RunStatus } from '../core/accounts/types';
import { listProjects } from '../services/projectService';

const RUN_STATUS_CLASSES: Record<RunStatus, string> = {
  pending: 'bg-slate-800 text-slate-300',
  running: 'bg-blue-950 text-blue-300',
  succeeded: 'bg-indigo-900 text-indigo-200',
  failed: 'bg-rose-950 text-rose-300',
};

function ProjectCard({ project }: { project: Project }) {
  const run = project.currentRun;
  const repository = run?.repository;

  return (
    <Link
      to={`/projects/${project.id}`}
      className="flex flex-col gap-2 rounded-lg border border-indigo-900 bg-indigo-950/40 p-4 transition-colors hover:border-violet-500"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="break-all font-semibold text-slate-100">{project.name}</h2>
        {project.myRole && (
          <span className="rounded bg-indigo-900 px-1.5 py-0.5 text-xs text-indigo-200">{project.myRole}</span>
        )}
      </div>
      {project.description && <p className="text-sm text-slate-400">{project.description}</p>}
      {repository && (
        <p className="break-all text-sm text-blue-300">
          {repository.fullName}
          {run?.branch && <span className="text-slate-500"> · {run.branch}</span>}
        </p>
      )}
      <div className="mt-auto flex items-center justify-between pt-2 text-xs text-slate-500">
        {run ? (
          <span className={`rounded px-1.5 py-0.5 ${RUN_STATUS_CLASSES[run.status]}`}>{run.status}</span>
        ) : (
          <span>Not analysed yet</span>
        )}
        <span>{project.lastOpenedAt ? `Opened ${formatDateTime(project.lastOpenedAt)}` : 'Never opened'}</span>
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadProjects = useCallback(async (searchText: string, cursor?: string) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await listProjects({ search: searchText, cursor });
      setProjects((existing) => (cursor ? [...existing, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not load your projects.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Waits a moment after typing so each keystroke doesn't hit the API.
  useEffect(() => {
    const timer = setTimeout(() => void loadProjects(search.trim()), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search, loadProjects]);

  const hasNoProjects = !isLoading && !errorMessage && projects.length === 0;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <TopBar />
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 py-8">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold">Your projects</h1>
          <div className="flex gap-2">
            <Link to="/demo" className={secondaryButtonClass}>
              Try the demo
            </Link>
            <Link to="/projects/new" className={primaryButtonClass}>
              New project
            </Link>
          </div>
        </div>

        <input
          className={`${inputClass} mb-6 max-w-sm`}
          placeholder="Search projects"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />

        {errorMessage && (
          <div className="mb-4 flex items-center gap-3">
            <p className="text-rose-300">{errorMessage}</p>
            <button className={secondaryButtonClass} onClick={() => void loadProjects(search.trim())}>
              Retry
            </button>
          </div>
        )}

        {hasNoProjects && (
          <div className="rounded-lg border border-dashed border-indigo-900 p-10 text-center">
            <p className="text-slate-300">{search ? 'No projects match that search.' : 'No projects yet.'}</p>
            {!search && (
              <p className="mt-1 text-sm text-slate-500">
                Link a GitHub repo and Ripplemap will map its Terraform and code into one graph.
              </p>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>

        {isLoading && <p className="mt-4 text-indigo-300">Loading…</p>}
        {nextCursor && !isLoading && (
          <button className={`${secondaryButtonClass} mt-6`} onClick={() => void loadProjects(search.trim(), nextCursor)}>
            Load more
          </button>
        )}
      </main>
    </div>
  );
}
