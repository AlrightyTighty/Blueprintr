import { CONFIDENCE_ORDER, type Confidence, type Graph, type GraphEdge } from './types.js';

/**
 * `dependents`: things that depend on the node (what breaks if it changes).
 * `dependencies`: things the node depends on.
 */
export type Direction = 'dependents' | 'dependencies';

export interface Reached {
  nodeId: string;
  distance: number;
  /** Edge ids along the shortest path from the start. */
  via: string[];
  weakestConfidence: Confidence;
}

function weaker(a: Confidence, b: Confidence): Confidence {
  return CONFIDENCE_ORDER.indexOf(a) >= CONFIDENCE_ORDER.indexOf(b) ? a : b;
}

export interface Adjacency {
  next: Map<string, GraphEdge[]>;
}

/** Edges leaving each node when walking in `direction`. Build once, reuse for many walks. */
export function buildAdjacency(graph: Graph, direction: Direction): Map<string, { edge: GraphEdge; to: string }[]> {
  const next = new Map<string, { edge: GraphEdge; to: string }[]>();
  for (const edge of graph.edges) {
    const [from, to] = direction === 'dependents' ? [edge.target, edge.source] : [edge.source, edge.target];
    const list = next.get(from);
    if (list) list.push({ edge, to });
    else next.set(from, [{ edge, to }]);
  }
  return next;
}

/**
 * Breadth-first walk from `startIds`. Returns every reachable node (excluding the starts) with its
 * shortest distance. Edges less certain than `minConfidence` are ignored.
 */
export function reach(
  graph: Graph,
  startIds: string[],
  direction: Direction,
  options: { maxDepth?: number; minConfidence?: Confidence } = {},
): Map<string, Reached> {
  const maxDepth = options.maxDepth ?? 20;
  const minRank = options.minConfidence ? CONFIDENCE_ORDER.indexOf(options.minConfidence) : CONFIDENCE_ORDER.length - 1;
  const adjacency = buildAdjacency(graph, direction);
  const starts = new Set(startIds);
  const found = new Map<string, Reached>();
  let frontier: Reached[] = startIds.map((nodeId) => ({ nodeId, distance: 0, via: [], weakestConfidence: 'certain' }));

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: Reached[] = [];
    for (const current of frontier) {
      for (const { edge, to } of adjacency.get(current.nodeId) ?? []) {
        if (starts.has(to) || found.has(to)) continue;
        if (CONFIDENCE_ORDER.indexOf(edge.confidence) > minRank) continue;
        const reached: Reached = {
          nodeId: to,
          distance: depth,
          via: [...current.via, edge.id],
          weakestConfidence: weaker(current.weakestConfidence, edge.confidence),
        };
        found.set(to, reached);
        nextFrontier.push(reached);
      }
    }
    frontier = nextFrontier;
  }
  return found;
}

/** Shortest path (as edge ids) from `from` to `to`, following edges in either direction. */
export function shortestPath(graph: Graph, from: string, to: string): GraphEdge[] | null {
  if (from === to) return [];
  const neighbours = new Map<string, { edge: GraphEdge; to: string }[]>();
  for (const edge of graph.edges) {
    for (const [a, b] of [[edge.source, edge.target], [edge.target, edge.source]] as const) {
      const list = neighbours.get(a);
      if (list) list.push({ edge, to: b });
      else neighbours.set(a, [{ edge, to: b }]);
    }
  }
  const previous = new Map<string, { edge: GraphEdge; from: string }>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const step of neighbours.get(current) ?? []) {
      if (seen.has(step.to)) continue;
      seen.add(step.to);
      previous.set(step.to, { edge: step.edge, from: current });
      if (step.to === to) {
        const path: GraphEdge[] = [];
        for (let at = to; at !== from; ) {
          const hop = previous.get(at)!;
          path.unshift(hop.edge);
          at = hop.from;
        }
        return path;
      }
      queue.push(step.to);
    }
  }
  return null;
}
