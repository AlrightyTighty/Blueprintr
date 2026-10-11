import { getPool } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import { listEndpoints as listGraphEndpoints } from '../core/endpoints/list.js';
import { traceRequest } from '../core/endpoints/trace.js';
import * as graphRepo from '../repositories/graph.js';
import { requireProject, type Actor } from './access.js';
import { resolveReadyRun } from './analysis.js';

async function loadGraph(actor: Actor, projectId: string, runRef: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { allowShare: true });
  const run = await resolveReadyRun(db, project, runRef);
  return graphRepo.loadGraph(db, run.id, run.commitSha);
}

/** Every way into the system that the run's infrastructure code declares. */
export async function listEndpoints(actor: Actor, projectId: string, runRef: string) {
  const graph = await loadGraph(actor, projectId, runRef);
  return { items: listGraphEndpoints(graph) };
}

/** "Call" an endpoint: follow `METHOD path` from the front door through the infrastructure and code. */
export async function traceEndpoint(
  actor: Actor,
  projectId: string,
  runRef: string,
  request: { method: string; path: string; endpointId?: string },
) {
  const graph = await loadGraph(actor, projectId, runRef);
  const outcome = traceRequest(graph, request);
  if (outcome.found) return outcome.trace;

  const closest = outcome.closest.map((e) => `${e.method} ${e.path}`).join(', ');
  const detail =
    outcome.reason === 'no_endpoints'
      ? 'This analysis found no API endpoints. Ripplemap reads API Gateway HTTP API routes, REST API methods and Lambda function URLs from your infrastructure code.'
      : outcome.reason === 'unknown_endpoint'
        ? 'That endpoint is not part of this analysis run.'
        : `No endpoint matches ${request.method.toUpperCase()} ${request.path}.${closest ? ` Closest: ${closest}.` : ''}`;
  throw new AppError(404, 'no_matching_endpoint', 'Not found', detail);
}
