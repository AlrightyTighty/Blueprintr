import { blastRadius } from './blastRadius';
import type { Graph } from './types';

export interface CascadeStep {
  nodeId: string;
  /** 0 for the failed node itself, then hops outward through the things that depend on it. */
  distance: number;
}

/**
 * The order in which a failure spreads: the failed node first, then everything that depends on it,
 * nearest first. Ties keep the graph's own node order so the result is stable.
 */
export function computeCascade(graph: Graph, failedNodeId: string): CascadeStep[] {
  const distanceByNodeId = blastRadius(graph, failedNodeId, 'dependents');
  const nodeOrder = new Map(graph.nodes.map((node, index) => [node.id, index]));

  const affected = [...distanceByNodeId]
    .map(([nodeId, distance]) => ({ nodeId, distance }))
    .sort(
      (first, second) =>
        first.distance - second.distance || (nodeOrder.get(first.nodeId) ?? 0) - (nodeOrder.get(second.nodeId) ?? 0),
    );
  return [{ nodeId: failedNodeId, distance: 0 }, ...affected];
}
