import { blastRadius } from './blastRadius';
import type { Graph, PlanAction } from './types';

export interface PlanImpact {
  /** Nodes the plan changes directly. */
  changedNodeIds: Map<string, PlanAction>;
  /** Nodes that depend on a replaced or destroyed node, but aren't changed themselves. */
  downstreamNodeIds: Set<string>;
}

export function computePlanImpact(graph: Graph, planActionsByNodeId: Map<string, PlanAction>): PlanImpact {
  const downstreamNodeIds = new Set<string>();
  for (const [nodeId, action] of planActionsByNodeId) {
    if (action !== 'replace' && action !== 'destroy') continue;
    for (const dependentId of blastRadius(graph, nodeId, 'dependents')) {
      if (!planActionsByNodeId.has(dependentId)) downstreamNodeIds.add(dependentId);
    }
  }
  return { changedNodeIds: planActionsByNodeId, downstreamNodeIds };
}
