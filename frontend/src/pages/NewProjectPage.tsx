import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import SoftBreak from '../components/SoftBreak';
import TopBar from '../components/TopBar';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';
import type { GithubConnection, GithubRepository, LinkRepositoryRequest } from '../core/accounts/types';
import { previewGithubRepo } from '../core/github/previewRepo';
import GithubButton from '../features/auth/GithubButton';
import { createProject, listGithubConnections, listGithubRepositories } from '../services/projectService';

function messageFor(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.friendlyMessage;
  return error instanceof Error ? error.message : fallback;
}

export default function NewProjectPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  // The two ways to choose a repository. Choosing one clears the other.
  const [repoUrl, setRepoUrl] = useState('');
  const [selectedRepository, setSelectedRepository] = useState<GithubRepository | null>(null);
  const [connections, setConnections] = useState<GithubConnection[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [repositorySearch, setRepositorySearch] = useState('');
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [branch, setBranch] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [analyzeNow, setAnalyzeNow] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const previewedRepo = previewGithubRepo(repoUrl);
  const hasRepository = repoUrl.trim() !== '' || selectedRepository !== null;

  useEffect(() => {
    listGithubConnections()
      .then((items) => {
        setConnections(items);
        if (items.length > 0) setConnectionId(items[0].id);
      })
      .catch(() => {
        // Not having a connected account is normal now (public links need none), so don't treat it as an error.
        setConnections([]);
      });
  }, []);

  // Searches as you type, after a short pause.
  useEffect(() => {
    if (!connectionId) return;
    let isStale = false;
    const timer = setTimeout(() => {
      setIsSearching(true);
      listGithubRepositories(connectionId, repositorySearch.trim())
        .then((page) => {
          if (!isStale) setRepositories(page.items);
        })
        .catch((error: unknown) => {
          if (!isStale) setErrorMessage(messageFor(error, 'Could not list repositories.'));
        })
        .finally(() => {
          if (!isStale) setIsSearching(false);
        });
    }, 250);
    return () => {
      isStale = true;
      clearTimeout(timer);
    };
  }, [connectionId, repositorySearch]);

  function suggestName(repoName: string) {
    // Suggest the repo name as the project name until the user types their own.
    setName((current) => current || repoName);
  }

  function handleUrlChange(value: string) {
    setRepoUrl(value);
    if (value.trim()) setSelectedRepository(null);
    const preview = previewGithubRepo(value);
    if (preview) suggestName(preview.split('/')[1]);
  }

  function handleSelectRepository(repository: GithubRepository) {
    setSelectedRepository(repository);
    setRepoUrl('');
    setBranch(repository.defaultBranch);
    suggestName(repository.fullName.split('/')[1]);
  }

  function buildRepositoryRequest(): LinkRepositoryRequest | null {
    const folder = rootPath.trim().replace(/^\/+|\/+$/g, '');
    if (repoUrl.trim()) {
      return {
        url: repoUrl.trim(),
        // Left empty, the branch comes from the link (/tree/<branch>) or is the repository's default.
        ...(branch.trim() ? { branch: branch.trim() } : {}),
        ...(folder ? { rootPath: folder } : {}),
      };
    }
    if (selectedRepository) {
      return {
        connectionId,
        githubRepoId: selectedRepository.githubId,
        branch: branch.trim() || selectedRepository.defaultBranch,
        rootPath: folder,
      };
    }
    return null;
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const repository = buildRepositoryRequest();
      const project = await createProject({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(repository ? { repositories: [repository], analyze: analyzeNow } : {}),
      });
      navigate(`/projects/${project.id}`);
    } catch (error) {
      setErrorMessage(messageFor(error, 'Could not create the project.'));
      setIsSubmitting(false);
    }
  }

  const hasNoConnections = connections !== null && connections.length === 0;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <TopBar title="New project" />
      <main className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-8">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <section className="flex flex-col gap-3 rounded-lg border border-indigo-900 p-4">
            <h2 className="font-semibold text-indigo-200">Repository</h2>
            <div>
              <label htmlFor="repoUrl" className={labelClass}>
                Paste a GitHub link
              </label>
              <input
                id="repoUrl"
                className={inputClass}
                placeholder="https://github.com/owner/repo"
                value={repoUrl}
                onChange={(event) => handleUrlChange(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <p className="mt-1 text-xs text-slate-500">
                Any public repository works with just the link. A link to a folder or branch (…/tree/main/infra) is
                understood too. Ripplemap only reads the files and never runs anything.
              </p>
              {previewedRepo && (
                <p className="mt-1 text-sm text-blue-300 wrap-anywhere">
                  Looks like <SoftBreak text={previewedRepo} />
                </p>
              )}
            </div>

            {hasRepository && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="branch" className={labelClass}>
                    Branch (optional)
                  </label>
                  <input
                    id="branch"
                    className={inputClass}
                    placeholder="Default branch"
                    value={branch}
                    onChange={(event) => setBranch(event.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="rootPath" className={labelClass}>
                    Subfolder (optional)
                  </label>
                  <input
                    id="rootPath"
                    className={inputClass}
                    placeholder="infra/"
                    value={rootPath}
                    onChange={(event) => setRootPath(event.target.value)}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-300 sm:col-span-2">
                  <input type="checkbox" checked={analyzeNow} onChange={(event) => setAnalyzeNow(event.target.checked)} />
                  Analyse right away
                </label>
              </div>
            )}

            <div className="mt-2 border-t border-indigo-900 pt-3">
              <h3 className="text-sm font-medium text-indigo-200">Private repositories</h3>
              <p className="mt-1 text-xs text-slate-500">
                Connect your GitHub account to pick from your own repositories, including private ones. Pasting a link
                to a private repository also works once your account is connected.
              </p>

              {connections === null && <p className="mt-2 text-sm text-indigo-300">Loading your GitHub accounts…</p>}

              {hasNoConnections && (
                <div className="mt-3 max-w-xs">
                  <GithubButton intent="link" label="Connect GitHub" returnPath="/projects/new" onError={setErrorMessage} />
                </div>
              )}

              {connections !== null && connections.length > 0 && (
                <div className="mt-3 flex flex-col gap-3">
                  {connections.length > 1 && (
                    <select
                      className={inputClass}
                      value={connectionId}
                      onChange={(event) => {
                        setConnectionId(event.target.value);
                        setSelectedRepository(null);
                      }}
                    >
                      {connections.map((connection) => (
                        <option key={connection.id} value={connection.id}>
                          {connection.githubLogin}
                        </option>
                      ))}
                    </select>
                  )}
                  <input
                    className={inputClass}
                    placeholder="Search your repositories"
                    value={repositorySearch}
                    onChange={(event) => setRepositorySearch(event.target.value)}
                  />
                  <ul className="max-h-56 overflow-y-auto rounded border border-indigo-900">
                    {repositories.map((repository) => (
                      <li key={repository.githubId}>
                        <button
                          type="button"
                          onClick={() => handleSelectRepository(repository)}
                          className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-indigo-950 ${
                            selectedRepository?.githubId === repository.githubId ? 'bg-indigo-900' : ''
                          }`}
                        >
                          <span className="wrap-anywhere">
                            <SoftBreak text={repository.fullName} />
                          </span>
                          {repository.isPrivate && <span className="ml-2 text-xs text-slate-500">private</span>}
                        </button>
                      </li>
                    ))}
                    {!isSearching && repositories.length === 0 && (
                      <li className="px-3 py-2 text-sm text-slate-500">No repositories found.</li>
                    )}
                    {isSearching && <li className="px-3 py-2 text-sm text-indigo-300">Searching…</li>}
                  </ul>
                </div>
              )}
            </div>
          </section>

          <div>
            <label htmlFor="name" className={labelClass}>
              Project name
            </label>
            <input
              id="name"
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
              required
            />
          </div>
          <div>
            <label htmlFor="description" className={labelClass}>
              Description (optional)
            </label>
            <input
              id="description"
              className={inputClass}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={1000}
            />
          </div>

          {errorMessage && <p className="text-sm text-rose-300">{errorMessage}</p>}

          <div className="flex gap-2">
            <button type="submit" className={primaryButtonClass} disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? 'Creating…' : 'Create project'}
            </button>
            <Link to="/projects" className={secondaryButtonClass}>
              Cancel
            </Link>
          </div>
        </form>
      </main>
    </div>
  );
}
