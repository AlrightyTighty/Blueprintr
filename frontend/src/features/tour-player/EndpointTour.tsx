import { useEffect, useState, type FormEvent } from 'react';
import type { Endpoint } from '../../core/graph/types';
import { fetchEndpoints, traceEndpoint } from '../../services/analysisService';
import { inputClass, primaryButtonClass } from '../../components/ui';
import { useGraphStore } from '../graph-view/useGraphStore';
import { useTourStore } from './useTourStore';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/** `/orders/{id}` becomes `/orders/123`, so a chip fills in a path you could really call. */
export function samplePath(template: string): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => (name === 'id' ? '123' : name.endsWith('+') ? 'example/path' : `example-${name}`));
}

/** "Call" an endpoint: type a method and path (or pick one) and follow that request from the front door to the data. */
export default function EndpointTour() {
  const { projectId, graph, findings, status } = useGraphStore();
  const startEndpoint = useTourStore((state) => state.startEndpoint);
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [method, setMethod] = useState('GET');
  const [path, setPath] = useState('');
  /** Set when the path came from a chip, so the request follows that exact endpoint. */
  const [chosenId, setChosenId] = useState<string | undefined>();
  const [isBusy, setIsBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Load the project's endpoints once its graph is ready; the list powers the suggestions.
  useEffect(() => {
    if (status !== 'ready' || !projectId) return;
    let isCurrent = true;
    setEndpoints(null);
    fetchEndpoints(projectId)
      .then((items) => isCurrent && setEndpoints(items))
      .catch(() => isCurrent && setEndpoints([]));
    return () => {
      isCurrent = false;
    };
  }, [projectId, status]);

  function pick(endpoint: Endpoint) {
    setMethod(endpoint.method === 'ANY' ? 'GET' : endpoint.method);
    setPath(samplePath(endpoint.path));
    setChosenId(endpoint.id);
    setMessage(null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!path.trim()) return;
    setIsBusy(true);
    setMessage(null);
    try {
      const trace = await traceEndpoint(projectId, { method, path: path.trim(), ...(chosenId ? { endpointId: chosenId } : {}) });
      startEndpoint(graph, findings, trace);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not follow that request.');
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-indigo-900 p-3">
      <h3 className="font-medium text-sky-300">Endpoint tour</h3>
      {endpoints !== null && endpoints.length === 0 ? (
        <p className="text-slate-500">
          No API endpoints found. Ripplemap reads API Gateway routes, REST methods and Lambda function URLs from your
          infrastructure code; analyse the project again if it was analysed before endpoints were supported.
        </p>
      ) : (
        <>
          <p className="text-slate-300">Call an endpoint and follow the request through your infrastructure and code.</p>
          <form className="flex flex-col gap-2" onSubmit={(event) => void handleSubmit(event)}>
            <div className="flex gap-2">
              <select
                aria-label="HTTP method"
                className="rounded border border-indigo-900 bg-indigo-950 px-2 py-2 text-slate-100 focus:border-violet-500 focus:outline-none"
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value);
                  setChosenId(undefined);
                }}
              >
                {METHODS.map((option) => (
                  <option key={option}>{option}</option>
                ))}
              </select>
              <input
                aria-label="Path"
                className={`${inputClass} min-w-0 flex-1 font-mono text-sm`}
                list="endpoint-paths"
                placeholder="/orders/123"
                value={path}
                onChange={(event) => {
                  setPath(event.target.value);
                  setChosenId(undefined);
                }}
              />
              <datalist id="endpoint-paths">
                {(endpoints ?? []).map((endpoint) => (
                  <option key={endpoint.id} value={samplePath(endpoint.path)} />
                ))}
              </datalist>
            </div>
            <button className={primaryButtonClass} type="submit" disabled={isBusy || !path.trim() || endpoints === null}>
              {isBusy ? 'Following…' : 'Follow the request'}
            </button>
          </form>
          {message && <p className="text-xs text-rose-300 [overflow-wrap:anywhere]">{message}</p>}
          {endpoints !== null && (
            <ul className="flex flex-wrap gap-1.5">
              {endpoints.map((endpoint) => (
                <li key={endpoint.id}>
                  <button
                    type="button"
                    title={endpoint.authorization ? `Requires ${endpoint.authorization}` : undefined}
                    className={`rounded border px-2 py-0.5 font-mono text-xs transition-colors hover:border-violet-500 ${
                      chosenId === endpoint.id ? 'border-violet-500 bg-indigo-900 text-slate-100' : 'border-indigo-900 bg-indigo-950 text-slate-300'
                    }`}
                    onClick={() => pick(endpoint)}
                  >
                    {endpoint.method} {endpoint.path}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
