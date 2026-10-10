import type { Graph } from './types';

/**
 * 'dependents': everything that depends on the node (what breaks if it changes).
 * 'dependencies': everything the node depends on.
 */
export type Direction = 'dependents' | 'dependencies';

/** Ids reachable from `startId` in the given direction, excluding the start node. */
export function blastRadius(graph: Graph, startId: string, direction: Direction): Set<string> {
  const next = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const [from, to] = direction === 'dependents' ? [edge.target, edge.source] : [edge.source, edge.target];
    next.set(from, [...(next.get(from) ?? []), to]);
  }

  const seen = new Set<string>();
  const queue = [startId];
  while (queue.length > 0) {
    for (const id of next.get(queue.shift()!) ?? []) {
      if (id !== startId && !seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return seen;
}
