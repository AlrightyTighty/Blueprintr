import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api';
import ConfirmDialog from '../components/ConfirmDialog';
import SharedWarning from '../features/sharing/SharedWarning';
import { formatDateTime, primaryButtonClass, secondaryButtonClass, inputClass } from '../components/ui';
import SoftBreak from '../components/SoftBreak';
import TopBar from '../components/TopBar';
import type { Project, RunStatus } from '../core/accounts/types';
import {
  archiveProject,
  deleteProject,
  listProjects,
  purgeProject,
  restoreProject,
  type ProjectScope,
} from '../services/projectService';
import { leaveProject } from '../services/sharingService';

const RUN_STATUS_CLASSES: Record<RunStatus, string> = {
  pending: 'bg-slate-800 text-slate-300',
  running: 'bg-blue-950 text-blue-300',
  succeeded: 'bg-indigo-900 text-indigo-200',
  failed: 'bg-rose-950 text-rose-300',
};

const SCOPES: { scope: ProjectScope; label: string }[] = [
  { scope: 'active', label: 'Active' },
  { scope: 'archived', label: 'Archived' },
  { scope: 'trash', label: 'Trash' },
];

const EMPTY_MESSAGES: Record<ProjectScope, string> = {
  active: 'No projects yet.',
  archived: 'Nothing is archived.',
  trash: 'The trash is empty. Deleted projects wait here until you delete them forever.',
};

type CardAction = 'archive' | 'delete' | 'restore' | 'purge' | 'leave';

const ACTION_LABELS: Record<CardAction, string> = {
  archive: 'Archive',
  delete: 'Delete',
  restore: 'Restore',
  purge: 'Delete forever',
  leave: 'Leave',
};

/** What this person can do to a project from its card: owners manage it, everyone else can only leave. */
function actionsFor(project: Project, scope: ProjectScope): CardAction[] {
  const isOwner = project.myRole === 'owner';
  if (scope === 'active') return isOwner ? ['archive', 'delete'] : ['leave'];
  if (scope === 'archived') return isOwner ? ['restore', 'delete'] : [];
  return isOwner ? ['restore', 'purge'] : [];
}

const actionButtonClass = 'rounded bg-indigo-950 px-2.5 py-1 text-xs text-indigo-200 transition-colors hover:bg-indigo-900 disabled:opacity-50';
const dangerActionClass = 'rounded bg-indigo-950 px-2.5 py-1 text-xs text-rose-300 transition-colors hover:bg-rose-950 disabled:opacity-50';

function CardBody({ project }: { project: Project }) {
  const run = project.currentRun;
  const repository = run?.repository;

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold text-slate-100 wrap-anywhere">{project.name}</h2>
        {project.myRole && (
          <span className="rounded bg-indigo-900 px-1.5 py-0.5 text-xs text-indigo-200">{project.myRole}</span>
        )}
      </div>
      {project.description && <p className="text-sm text-slate-400">{project.description}</p>}
      {repository && (
        <p className="text-sm text-blue-300 wrap-anywhere">
          <SoftBreak text={repository.fullName} />
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
    </>
  );
}

function ProjectCard({
  project,
  scope,
  busy,
  onAction,
}: {
  project: Project;
  scope: ProjectScope;
  busy: boolean;
  onAction: (action: CardAction, project: Project) => void;
}) {
  const actions = actionsFor(project, scope);
  const bodyClass = 'flex flex-1 flex-col gap-2 p-4';

  return (
    <div className="flex flex-col rounded-lg border border-indigo-900 bg-indigo-950/40 transition-colors hover:border-violet-500">
      {/* A trashed project can't be opened, so its card isn't a link. */}
      {scope === 'trash' ? (
        <div className={bodyClass}>
          <CardBody project={project} />
        </div>
      ) : (
        <Link to={`/projects/${project.id}`} className={bodyClass}>
          <CardBody project={project} />
        </Link>
      )}
      {actions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-indigo-900 px-4 py-2">
          {actions.map((action) => (
            <button
              key={action}
              type="button"
              disabled={busy}
              className={action === 'delete' || action === 'purge' || action === 'leave' ? dangerActionClass : actionButtonClass}
              onClick={() => onAction(action, project)}
            >
              {ACTION_LABELS[action]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  const [scope, setScope] = useState<ProjectScope>('active');
  const [projects, setProjects] = useState<Project[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isActing, setIsActing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<{ action: CardAction; project: Project } | null>(null);

  const loadProjects = useCallback(async (searchText: string, projectScope: ProjectScope, cursor?: string) => {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await listProjects({ search: searchText, cursor, scope: projectScope });
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
    const timer = setTimeout(() => void loadProjects(search.trim(), scope), search ? 300 : 0);
    return () => clearTimeout(timer);
  }, [search, scope, loadProjects]);

  /** Runs an action, and takes the project out of this list because it now belongs to another one. */
  async function perform(action: CardAction, project: Project) {
    switch (action) {
      case 'archive':
        await archiveProject(project.id);
        break;
      case 'restore':
        await restoreProject(project.id);
        break;
      case 'delete':
        await deleteProject(project.id);
        break;
      case 'purge':
        await purgeProject(project.id);
        break;
      case 'leave':
        await leaveProject(project.id);
        break;
    }
    setProjects((existing) => existing.filter((candidate) => candidate.id !== project.id));
  }

  function handleAction(action: CardAction, project: Project) {
    // Archiving and restoring are easy to undo, so they happen straight away; the rest ask first.
    if (action === 'archive' || action === 'restore') {
      setIsActing(true);
      setErrorMessage(null);
      perform(action, project)
        .catch((error: unknown) => setErrorMessage(error instanceof ApiError ? error.friendlyMessage : 'Could not do that.'))
        .finally(() => setIsActing(false));
    } else {
      setPending({ action, project });
    }
  }

  const hasNoProjects = !isLoading && !errorMessage && projects.length === 0;
  const tabClass = (isActive: boolean) =>
    `border-b-2 px-4 py-2 text-sm transition-colors ${
      isActive ? 'border-violet-500 text-indigo-100' : 'border-transparent text-slate-400 hover:text-slate-200'
    }`;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <TopBar />
      <main className="mx-auto w-full max-w-5xl flex-1 overflow-y-auto px-4 py-8">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
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

        <div className="mb-5 flex border-b border-indigo-900" role="tablist">
          {SCOPES.map((option) => (
            <button
              key={option.scope}
              type="button"
              role="tab"
              aria-selected={scope === option.scope}
              className={tabClass(scope === option.scope)}
              onClick={() => {
                setProjects([]);
                setScope(option.scope);
              }}
            >
              {option.label}
            </button>
          ))}
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
            <button className={secondaryButtonClass} onClick={() => void loadProjects(search.trim(), scope)}>
              Retry
            </button>
          </div>
        )}

        {hasNoProjects && (
          <div className="rounded-lg border border-dashed border-indigo-900 p-10 text-center">
            <p className="text-slate-300">{search ? 'No projects match that search.' : EMPTY_MESSAGES[scope]}</p>
            {!search && scope === 'active' && (
              <p className="mt-1 text-sm text-slate-500">
                Paste a link to any public GitHub repo and Ripplemap will map its Terraform and code into one graph.
              </p>
            )}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} scope={scope} busy={isActing} onAction={handleAction} />
          ))}
        </div>

        {isLoading && <p className="mt-4 text-indigo-300">Loading…</p>}
        {nextCursor && !isLoading && (
          <button className={`${secondaryButtonClass} mt-6`} onClick={() => void loadProjects(search.trim(), scope, nextCursor)}>
            Load more
          </button>
        )}
      </main>

      {pending && (
        <ConfirmDialog
          title={
            pending.action === 'purge'
              ? 'Delete this project forever?'
              : pending.action === 'leave'
                ? 'Leave this project?'
                : 'Move this project to the trash?'
          }
          confirmLabel={pending.action === 'purge' ? 'Delete forever' : pending.action === 'leave' ? 'Leave' : 'Move to trash'}
          danger
          onCancel={() => setPending(null)}
          onConfirm={async () => {
            await perform(pending.action, pending.project);
            setPending(null);
          }}
        >
          {pending.action === 'purge' && (
            <p>
              “{pending.project.name}” and everything in it — its analysis, findings, plans and sharing — will be erased. This
              can't be undone.
            </p>
          )}
          {pending.action === 'leave' && <p>You will lose access to “{pending.project.name}”. The owner can invite you back.</p>}
          {pending.action === 'delete' && (
            <p>
              “{pending.project.name}” disappears for you and everyone it's shared with. You can bring it back from the Trash tab,
              or delete it forever from there.
            </p>
          )}
          {(pending.action === 'delete' || pending.action === 'purge') && <SharedWarning projectId={pending.project.id} />}
        </ConfirmDialog>
      )}
    </div>
  );
}
