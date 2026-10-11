import type { FindingRow } from '../../repositories/findings.js';
import { traceRequest } from '../endpoints/trace.js';
import { reach, shortestPath, type Reached } from './traversal.js';
import type { Confidence, Graph, GraphEdge, GraphNode } from './types.js';

/** The questions the graph can answer. One list, so routes, the Ask tool and the voice tool can't drift apart. */
export const QUERY_OPS = ['touches', 'dependents', 'dependencies', 'path', 'findings', 'endpoint'] as const;
export type QueryOp = (typeof QUERY_OPS)[number];

export interface QueryRequest {
  op: QueryOp;
  node: string;
  to?: string;
  maxDepth?: number;
}

export interface ReachedView {
  node: GraphNode;
  distance: number;
  via: string[];
  weakestConfidence: Confidence;
}

export interface QueryResult {
  op: QueryOp;
  resolved: GraphNode[];
  results: ReachedView[];
  edges: GraphEdge[];
  findings: FindingRow[];
  /** Plain English, short enough for a model to quote or a voice to read out. */
  summary: string;
}

const isCode = (n: GraphNode) => n.kind === 'code_function' || n.kind === 'code_file';

/** Finds nodes by id, then exact address, then exact name, then substring. First tier with a hit wins. */
export function resolveNodes(graph: Graph, ref: string, limit = 5): GraphNode[] {
  const needle = ref.trim().toLowerCase();
  if (!needle) return [];
  const tiers: ((n: GraphNode) => boolean)[] = [
    (n) => n.id === ref.trim(),
    (n) => n.address.toLowerCase() === needle,
    (n) => n.name.toLowerCase() === needle,
    (n) => n.address.toLowerCase().includes(needle) || n.name.toLowerCase().includes(needle),
  ];
  for (const tier of tiers) {
    const hits = graph.nodes.filter(tier);
    if (hits.length > 0) {
      // Infrastructure first: someone asking about "orders" means the table before a function that mentions it.
      return hits.sort((a, b) => Number(isCode(a)) - Number(isCode(b)) || a.address.localeCompare(b.address)).slice(0, limit);
    }
  }
  return [];
}

const list = (items: string[], max = 6) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);

export function runGraphQuery(
  graph: Graph,
  request: QueryRequest,
  context: { findings: FindingRow[]; /** nodeId to a short plan tag such as "replace" or "downstream" */ planTags?: Map<string, string> },
): QueryResult {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  if (request.op === 'endpoint') return endpointQuery(graph, request, nodes);
  const resolved = resolveNodes(graph, request.node);
  const tag = (n: GraphNode) => {
    const t = context.planTags?.get(n.id);
    return t ? `${n.address} [plan: ${t}]` : n.address;
  };
  const empty = (summary: string): QueryResult => ({ op: request.op, resolved, results: [], edges: [], findings: [], summary });

  if (resolved.length === 0) return empty(`I couldn't find anything called "${request.node}" in this analysis.`);
  const ids = resolved.map((n) => n.id);
  const subject = resolved.length === 1 ? tag(resolved[0]!) : `${resolved.length} matches for "${request.node}" (${list(resolved.map((n) => n.address), 3)})`;

  const toView = (reached: Reached): ReachedView => ({
    node: nodes.get(reached.nodeId)!,
    distance: reached.distance,
    via: reached.via,
    weakestConfidence: reached.weakestConfidence,
  });
  const edgesById = new Map(graph.edges.map((e) => [e.id, e]));
  const edgesOf = (views: ReachedView[]) => [...new Set(views.flatMap((v) => v.via))].map((id) => edgesById.get(id)!).filter(Boolean);

  switch (request.op) {
    case 'dependents':
    case 'dependencies': {
      const views = [...reach(graph, ids, request.op, { maxDepth: request.maxDepth ?? 10 }).values()].map(toView).sort((a, b) => a.distance - b.distance);
      const code = views.filter((v) => isCode(v.node));
      const infra = views.filter((v) => !isCode(v.node));
      const summary =
        views.length === 0
          ? request.op === 'dependents'
            ? `Nothing depends on ${subject}.`
            : `${subject} doesn't depend on anything.`
          : request.op === 'dependents'
            ? `${views.length} things depend on ${subject}: ${infra.length} infrastructure resources (${list(infra.map((v) => tag(v.node)))}) and ${code.length} code paths (${list(code.map((v) => tag(v.node)))}).`
            : `${subject} relies on ${views.length} things: ${list(views.map((v) => tag(v.node)))}.`;
      return { op: request.op, resolved, results: views, edges: edgesOf(views), findings: [], summary };
    }

    case 'touches': {
      const views: ReachedView[] = [];
      const seen = new Set<string>();
      for (const node of resolved) {
        const resourceSide = !isCode(node);
        for (const edge of graph.edges) {
          const other = resourceSide ? (edge.target === node.id ? nodes.get(edge.source) : undefined) : edge.source === node.id ? nodes.get(edge.target) : undefined;
          if (!other || seen.has(`${node.id}|${other.id}`)) continue;
          // Resources: the code and roles that touch it. Code: the resources it touches.
          const relevant = resourceSide ? isCode(other) || edge.relation === 'grants_access' : !isCode(other) && edge.relation !== 'runs_code';
          if (!relevant) continue;
          seen.add(`${node.id}|${other.id}`);
          views.push({ node: other, distance: 1, via: [edge.id], weakestConfidence: edge.confidence });
        }
      }
      const verb = (v: ReachedView) => edgesById.get(v.via[0]!)!.relation;
      const lines = views.map((v) => `${tag(v.node)} (${verb(v)}, ${edgesById.get(v.via[0]!)!.confidence})`);
      const summary =
        views.length === 0
          ? `Nothing touches ${subject}.`
          : isCode(resolved[0]!)
            ? `${subject} touches ${views.length} resources: ${list(lines)}.`
            : `${views.length} things touch ${subject}: ${list(lines)}.`;
      return { op: 'touches', resolved, results: views, edges: edgesOf(views), findings: [], summary };
    }

    case 'path': {
      if (!request.to) return empty('Say which node to find a path to.');
      const targets = resolveNodes(graph, request.to);
      if (targets.length === 0) return empty(`I couldn't find anything called "${request.to}".`);
      const path = shortestPath(graph, resolved[0]!.id, targets[0]!.id);
      if (!path) return { ...empty(`There is no connection between ${tag(resolved[0]!)} and ${tag(targets[0]!)}.`), resolved: [resolved[0]!, targets[0]!] };
      const views: ReachedView[] = [];
      let at = resolved[0]!.id;
      path.forEach((edge, i) => {
        at = edge.source === at ? edge.target : edge.source;
        views.push({ node: nodes.get(at)!, distance: i + 1, via: path.slice(0, i + 1).map((e) => e.id), weakestConfidence: edge.confidence });
      });
      const summary = `${tag(resolved[0]!)} connects to ${tag(targets[0]!)} in ${path.length} ${path.length === 1 ? 'step' : 'steps'}, via ${list(views.map((v) => v.node.address))}.`;
      return { op: 'path', resolved: [resolved[0]!, targets[0]!], results: views, edges: path, findings: [], summary };
    }

    case 'findings': {
      const related = context.findings.filter((f) => ids.includes(f.nodeId ?? '') || ids.includes(f.relatedNodeId ?? ''));
      const summary =
        related.length === 0
          ? `No findings are attached to ${subject}.`
          : `${related.length} ${related.length === 1 ? 'finding' : 'findings'} about ${subject}: ${list(related.map((f) => `${f.severity} ${f.kind.replace(/_/g, ' ')}: ${f.title}`), 4)}.`;
      return { op: 'findings', resolved, results: [], edges: [], findings: related, summary };
    }
  }
}

/** "GET /orders/123": follow that request through the infrastructure and the code. */
function endpointQuery(graph: Graph, request: QueryRequest, nodes: Map<string, GraphNode>): QueryResult {
  const nothing = (summary: string): QueryResult => ({ op: 'endpoint', resolved: [], results: [], edges: [], findings: [], summary });
  const parsed = /^([A-Za-z]+)\s+(\/\S*)$/.exec(request.node.trim());
  if (!parsed) return nothing('Give the endpoint as a method and a path, like "GET /orders/123".');

  const outcome = traceRequest(graph, { method: parsed[1]!, path: parsed[2]! });
  if (!outcome.found) {
    if (outcome.reason === 'no_endpoints') return nothing('This analysis found no API endpoints (no API Gateway routes, REST methods or function URLs).');
    const suggestions = outcome.closest.map((e) => `${e.method} ${e.path}`);
    return nothing(`No endpoint matches ${request.node.trim()}. Closest: ${list(suggestions)}.`);
  }
  const { trace } = outcome;
  const results = trace.steps.map((step, index): ReachedView => ({
    node: nodes.get(step.nodeId)!,
    distance: index + 1,
    via: step.edgeIds,
    weakestConfidence: step.confidence ?? 'certain',
  }));
  return { op: 'endpoint', resolved: [nodes.get(trace.match.endpointId)!], results, edges: trace.edges, findings: [], summary: trace.summary };
}
