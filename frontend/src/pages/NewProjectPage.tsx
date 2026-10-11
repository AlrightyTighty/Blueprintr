import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import TopBar from '../components/TopBar';
import { inputClass, labelClass, primaryButtonClass, secondaryButtonClass } from '../components/ui';
import type { GithubConnection, GithubRepository } from '../core/accounts/types';
import GithubButton from '../features/auth/GithubButton';
import { createProject, listGithubConnections, listGithubRepositories } from '../services/projectService';

export default function NewProjectPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [connections, setConnections] = useState<GithubConnection[] | null>(null);
  const [connectionId, setConnectionId] = useState('');
  const [repositorySearch, setRepositorySearch] = useState('');
  const [repositories, setRepositories] = useState<GithubRepository[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedRepository, setSelectedRepository] = useState<GithubRepository | null>(null);
  const [branch, setBranch] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [analyzeNow, setAnalyzeNow] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    listGithubConnections()
      .then((items) => {
        setConnections(items);
        if (items.length > 0) setConnectionId(items[0].id);
      })
      .catch((error: unknown) => {
        setConnections([]);
        setErrorMessage(error instanceof Error ? error.message : 'Could not load your GitHub accounts.');
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
          if (!isStale) setErrorMessage(error instanceof Error ? error.message : 'Could not list repositories.');
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

  function handleSelectRepository(repository: GithubRepository) {
    setSelectedRepository(repository);
    setBranch(repository.defaultBranch);
    // Suggest the repo name as the project name until the user types their own.
    setName((current) => current || repository.fullName.split('/')[1]);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      const project = await createProject({
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(selectedRepository
          ? {
              repositories: [
                {
                  connectionId,
                  githubRepoId: selectedRepository.githubId,
                  branch: branch.trim() || selectedRepository.defaultBranch,
                  rootPath: rootPath.trim().replace(/^\/+|\/+$/g, ''),
                },
              ],
              analyze: analyzeNow,
            }
          : {}),
      });
      navigate(`/projects/${project.id}`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Could not create the project.');
      setIsSubmitting(false);
    }
  }

  const hasNoConnections = connections !== null && connections.length === 0;

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <TopBar title="New project" />
      <main className="mx-auto w-full max-w-2xl flex-1 overflow-y-auto px-4 py-8">
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
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

          <section className="flex flex-col gap-3 rounded-lg border border-indigo-900 p-4">
            <h2 className="font-semibold text-indigo-200">Repository</h2>
            <p className="text-sm text-slate-400">
              Ripplemap reads your Terraform and code from GitHub. It only analyses them and never runs anything.
            </p>

            {connections === null && <p className="text-indigo-300">Loading your GitHub accounts…</p>}

            {hasNoConnections && (
              <div className="flex flex-col gap-3">
                <p className="text-sm text-slate-300">Connect a GitHub account to pick a repository.</p>
                <div className="max-w-xs">
                  <GithubButton
                    intent="link"
                    label="Connect GitHub"
                    returnPath="/projects/new"
                    onError={setErrorMessage}
                  />
                </div>
              </div>
            )}

            {connections !== null && connections.length > 0 && (
              <>
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
                  placeholder="Search repositories"
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
                        <span className="break-all">{repository.fullName}</span>
                        {repository.isPrivate && <span className="ml-2 text-xs text-slate-500">private</span>}
                      </button>
                    </li>
                  ))}
                  {!isSearching && repositories.length === 0 && (
                    <li className="px-3 py-2 text-sm text-slate-500">No repositories found.</li>
                  )}
                  {isSearching && <li className="px-3 py-2 text-sm text-indigo-300">Searching…</li>}
                </ul>

                {selectedRepository && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="branch" className={labelClass}>
                        Branch
                      </label>
                      <input id="branch" className={inputClass} value={branch} onChange={(event) => setBranch(event.target.value)} />
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
              </>
            )}
          </section>

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
