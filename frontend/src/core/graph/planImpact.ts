import type { ParsedPlanChange } from '../terraform/parsePlan';
import { blastRadius } from './blastRadius';
import type { Graph, PlanChange } from './types';

/**
 * Client-side version of the backend's plan analysis, in the same `PlanChange` shape, so a server
 * response can replace it later. Direct changes come from the plan; only replace and destroy spread
 * to downstream nodes.
 */
export function computePlanChanges(graph: Graph, parsedChanges: ParsedPlanChange[]): PlanChange[] {
  const nodeByAddress = new Map(graph.nodes.map((node) => [node.address, node]));

  const directChanges: PlanChange[] = parsedChanges.map((parsedChange) => ({
    id: `direct:${parsedChange.address}`,
    nodeId: nodeByAddress.get(parsedChange.address)?.id ?? null,
    address: parsedChange.address,
    terraformType: parsedChange.terraformType,
    actions: parsedChange.actions,
    action: parsedChange.action,
    impact: 'direct',
    distance: 0,
    changedAttributes: [],
  }));

  const directlyChangedNodeIds = new Set(
    directChanges.flatMap((change) => (change.nodeId ? [change.nodeId] : [])),
  );

  // Nearest distance wins when several changed nodes reach the same dependent.
  const downstreamDistanceByNodeId = new Map<string, number>();
  for (const change of directChanges) {
    if (!change.nodeId || (change.action !== 'replace' && change.action !== 'destroy')) continue;
    for (const [dependentId, distance] of blastRadius(graph, change.nodeId, 'dependents')) {
      if (directlyChangedNodeIds.has(dependentId)) continue;
      const knownDistance = downstreamDistanceByNodeId.get(dependentId);
      if (knownDistance === undefined || distance < knownDistance) {
        downstreamDistanceByNodeId.set(dependentId, distance);
      }
    }
  }

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const downstreamChanges: PlanChange[] = [...downstreamDistanceByNodeId].map(([nodeId, distance]) => {
    const node = nodeById.get(nodeId)!;
    return {
      id: `downstream:${node.address}`,
      nodeId,
      address: node.address,
      terraformType: node.terraformType,
      actions: [],
      action: 'noop',
      impact: 'downstream',
      distance,
      changedAttributes: [],
    };
  });

  return [...directChanges, ...downstreamChanges];
}
