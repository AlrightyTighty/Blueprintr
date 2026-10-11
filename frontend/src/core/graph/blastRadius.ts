import type { Graph } from './types';

/**
 * 'dependents': everything that depends on the node (what breaks if it changes).
 * 'dependencies': everything the node depends on.
 */
export type Direction = 'dependents' | 'dependencies';

/** Reachable node ids from `startId` in the given direction, mapped to their hop distance. Excludes the start node. */
export function blastRadius(graph: Graph, startId: string, direction: Direction): Map<string, number> {
  const neighboursByNodeId = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const [from, to] = direction === 'dependents' ? [edge.target, edge.source] : [edge.source, edge.target];
    neighboursByNodeId.set(from, [...(neighboursByNodeId.get(from) ?? []), to]);
  }

  const distanceByNodeId = new Map<string, number>();
  const queue = [startId];
  const distanceOf = (nodeId: string) => (nodeId === startId ? 0 : distanceByNodeId.get(nodeId)!);
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    for (const neighbourId of neighboursByNodeId.get(currentId) ?? []) {
      if (neighbourId !== startId && !distanceByNodeId.has(neighbourId)) {
        distanceByNodeId.set(neighbourId, distanceOf(currentId) + 1);
        queue.push(neighbourId);
      }
    }
  }
  return distanceByNodeId;
}
