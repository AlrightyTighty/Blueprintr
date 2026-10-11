import { getPool } from '../db/pool.js';
import { notFound } from '../http/errors.js';
import { reach, type Direction } from '../core/graph/traversal.js';
import { runGraphQuery, type QueryRequest } from '../core/graph/query.js';
import type { Confidence, Graph, GraphNode, NodeKind } from '../core/graph/types.js';
import * as findings from '../repositories/findings.js';
import * as graphRepo from '../repositories/graph.js';
import * as plans from '../repositories/plans.js';
import { requireProject, type Actor } from './access.js';
import { resolveReadyRun } from './analysis.js';

async function loadReady(actor: Actor, projectId: string, runRef: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { allowShare: true });
  const run = await resolveReadyRun(db, project, runRef);
  return { db, project, run };
}

export async function getGraph(actor: Actor, projectId: string, runRef: string) {
  const { db, run } = await loadReady(actor, projectId, runRef);
  return graphRepo.loadGraph(db, run.id, run.commitSha);
}

export async function searchNodes(
  actor: Actor,
  projectId: string,
  runRef: string,
  query: { kind?: NodeKind; terraformType?: string; q?: string; limit: number; cursor?: string },
) {
  const { db, run } = await loadReady(actor, projectId, runRef);
  return graphRepo.searchNodes(db, run.id, query);
}

export async function getNodeDetail(actor: Actor, projectId: string, runRef: string, nodeId: string) {
  const { db, run } = await loadReady(actor, projectId, runRef);
  const graph = await graphRepo.loadGraph(db, run.id, run.commitSha);
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) throw notFound('Node');
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const byAddress = new Map(graph.nodes.map((n) => [n.address, n]));

  const neighbour = (edgeId: string, otherId: string) => ({ edge: graph.edges.find((e) => e.id === edgeId)!, node: byId.get(otherId)! });
  const incoming = graph.edges.filter((e) => e.target === nodeId).map((e) => neighbour(e.id, e.source));
  const outgoing = graph.edges.filter((e) => e.source === nodeId).map((e) => neighbour(e.id, e.target));

  // Roles that grant access to this resource, and what they allow.
  const grants = incoming
    .filter(({ edge }) => edge.relation === 'grants_access')
    .map(({ edge, node: role }) => {
      const policyAddress = typeof edge.evidence['policy'] === 'string' ? (edge.evidence['policy'] as string) : null;
      return {
        role,
        policy: policyAddress ? byAddress.get(policyAddress.replace(/ \((managed|inline)\)$/, '')) ?? null : null,
        allowedActions: Array.isArray(edge.evidence['actions']) ? (edge.evidence['actions'] as string[]) : [],
        edge,
      };
    });

  const nodeFindings = (await findings.list(db, run.id, { nodeId, limit: 100 })).items;
  return { node, incoming, outgoing, grants, findings: nodeFindings };
}

export async function getBlastRadius(
  actor: Actor,
  projectId: string,
  runRef: string,
  nodeId: string,
  options: { direction: 'dependents' | 'dependencies' | 'both'; maxDepth: number; minConfidence?: Confidence },
) {
  const { db, run } = await loadReady(actor, projectId, runRef);
  const graph = await graphRepo.loadGraph(db, run.id, run.commitSha);
  const root = graph.nodes.find((n) => n.id === nodeId);
  if (!root) throw notFound('Node');
  const directions: Direction[] = options.direction === 'both' ? ['dependents', 'dependencies'] : [options.direction];

  const merged = new Map<string, ReturnType<typeof reach> extends Map<string, infer V> ? V : never>();
  for (const direction of directions) {
    for (const [id, reached] of reach(graph, [nodeId], direction, { maxDepth: options.maxDepth, minConfidence: options.minConfidence })) {
      const existing = merged.get(id);
      if (!existing || reached.distance < existing.distance) merged.set(id, reached);
    }
  }
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const reached = [...merged.values()]
    .sort((a, b) => a.distance - b.distance)
    .map((r) => ({ node: nodes.get(r.nodeId)!, distance: r.distance, via: r.via, weakestConfidence: r.weakestConfidence }));
  const edges = [...new Set(reached.flatMap((r) => r.via))].map((id) => edgesById.get(id)!);
  return { root, direction: options.direction, maxDepth: options.maxDepth, reached, edges };
}

/** Shared by the REST endpoint, Gemini function calling and the ElevenLabs tool. */
export async function queryGraphForRun(graph: Graph, runId: string, request: QueryRequest, planId?: string | null) {
  const db = getPool();
  const allFindings = await findings.listAllForRun(db, runId);
  let planTags: Map<string, string> | undefined;
  if (planId) {
    planTags = new Map();
    for (const change of await plans.listChanges(db, planId)) {
      if (change.nodeId) planTags.set(change.nodeId, change.impact === 'downstream' ? 'downstream' : change.action);
    }
  }
  return runGraphQuery(graph, request, { findings: allFindings, planTags });
}

export async function queryGraph(actor: Actor, projectId: string, request: QueryRequest & { runId?: string; planId?: string }) {
  const { db, run } = await loadReady(actor, projectId, request.runId ?? 'current');
  const graph = await graphRepo.loadGraph(db, run.id, run.commitSha);
  if (request.planId) {
    const plan = await plans.findById(db, projectId, request.planId);
    if (!plan) throw notFound('Plan');
  }
  return queryGraphForRun(graph, run.id, request, request.planId);
}

export type { GraphNode };
