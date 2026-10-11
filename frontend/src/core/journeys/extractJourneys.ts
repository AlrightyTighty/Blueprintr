import { getResourceRole } from '../graph/nodeDisplay';
import type { EdgeRelation, Finding, Graph, GraphEdge, GraphNode } from '../graph/types';
import { createJourneyContext, type JourneyContext } from './journeyContext';
import { buildStop, isTourStop } from './stops';
import type { Journey } from './types';

// Edges a request can follow. IAM (assumes_role, grants_access) and runs_code are told as part of a stop.
const FLOW_RELATIONS = new Set<EdgeRelation>(['references', 'depends_on', 'routes_to', 'invokes', 'reads', 'writes', 'publishes']);

function flowEdgesFrom(context: JourneyContext, nodeId: string): GraphEdge[] {
  return (context.outgoingByNodeId.get(nodeId) ?? []).filter((edge) => {
    const target = context.nodeById.get(edge.target);
    return FLOW_RELATIONS.has(edge.relation) && target !== undefined && isTourStop(target);
  });
}

interface Reach {
  /** Visit order, depth first, so siblings are told one after another. */
  order: string[];
  /** The edge each node was first reached by. */
  arrivalEdgeByNodeId: Map<string, GraphEdge>;
}

function walkFrom(context: JourneyContext, entryId: string): Reach {
  const order: string[] = [];
  const arrivalEdgeByNodeId = new Map<string, GraphEdge>();
  const visit = (nodeId: string) => {
    order.push(nodeId);
    for (const edge of flowEdgesFrom(context, nodeId)) {
      if (!order.includes(edge.target)) {
        arrivalEdgeByNodeId.set(edge.target, edge);
        visit(edge.target);
      }
    }
  };
  visit(entryId);
  return { order, arrivalEdgeByNodeId };
}

/** Shortest path of edges from the entry to each reachable node. */
function shortestPaths(context: JourneyContext, entryId: string): Map<string, GraphEdge[]> {
  const pathByNodeId = new Map<string, GraphEdge[]>([[entryId, []]]);
  const queue = [entryId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of flowEdgesFrom(context, current)) {
      if (!pathByNodeId.has(edge.target)) {
        pathByNodeId.set(edge.target, [...pathByNodeId.get(current)!, edge]);
        queue.push(edge.target);
      }
    }
  }
  return pathByNodeId;
}

/**
 * Where requests enter: domains first (every tour starts at the front door), then API gateways and
 * functions that no domain reaches.
 */
function findEntryPoints(context: JourneyContext): GraphNode[] {
  const nodes = context.graph.nodes.filter(isTourStop);
  const entries = nodes.filter((node) => getResourceRole(node) === 'domain');
  const reached = new Set(entries.flatMap((entry) => walkFrom(context, entry.id).order));

  for (const wantedRole of ['api', 'function'] as const) {
    for (const node of nodes) {
      if (getResourceRole(node) === wantedRole && !reached.has(node.id)) {
        entries.push(node);
        walkFrom(context, node.id).order.forEach((id) => reached.add(id));
      }
    }
  }
  return entries;
}

function pathStops(context: JourneyContext, path: GraphEdge[], entryId: string) {
  const stops = [buildStop(context, entryId, null)];
  for (const edge of path) stops.push(buildStop(context, edge.target, edge));
  return stops;
}

function entryTitleName(entry: GraphNode): string {
  return entry.name;
}

/** The tours that can be told from the graph alone: one first-day walk and several request journeys per entry point. */
export function extractJourneys(graph: Graph, findings: Finding[]): Journey[] {
  const context = createJourneyContext(graph, findings);
  const firstDay: Journey[] = [];
  const requests: Journey[] = [];

  for (const entry of findEntryPoints(context)) {
    const { order, arrivalEdgeByNodeId } = walkFrom(context, entry.id);
    if (order.length < 2) continue;

    firstDay.push({
      id: `first_day:${entry.id}`,
      title: `First day: ${entryTitleName(entry)}`,
      kind: 'first_day',
      stops: order.map((nodeId) => buildStop(context, nodeId, arrivalEdgeByNodeId.get(nodeId) ?? null)),
    });

    // A function with no front door gets one journey of its own, below, instead of one per thing it uses.
    const pathByNodeId = getResourceRole(entry) === 'function' ? new Map<string, GraphEdge[]>() : shortestPaths(context, entry.id);
    for (const [nodeId, path] of pathByNodeId) {
      const node = context.nodeById.get(nodeId)!;
      if (nodeId === entry.id) continue;

      const passesThroughFunction = path.slice(0, -1).some((edge) => getResourceRole(context.nodeById.get(edge.target)!) === 'function');
      const isFunction = getResourceRole(node) === 'function';
      const isLeaf = flowEdgesFrom(context, nodeId).length === 0;

      if (isFunction && !passesThroughFunction) {
        // Follow the request into the function, then to everything it uses.
        const stops = pathStops(context, path, entry.id);
        for (const edge of flowEdgesFrom(context, nodeId)) stops.push(buildStop(context, edge.target, edge));
        requests.push({ id: `request:${entry.id}:${nodeId}`, title: `Follow a request through ${node.name}`, kind: 'request', stops });
      } else if (isLeaf && !passesThroughFunction && !isFunction) {
        requests.push({
          id: `request:${entry.id}:${nodeId}`,
          title: `Follow a request to ${node.name}`,
          kind: 'request',
          stops: pathStops(context, path, entry.id),
        });
      }
    }

    // A function with no front door still deserves its own request journey.
    if (getResourceRole(entry) === 'function') {
      const stops = [buildStop(context, entry.id, null)];
      for (const edge of flowEdgesFrom(context, entry.id)) stops.push(buildStop(context, edge.target, edge));
      requests.push({ id: `request:${entry.id}:${entry.id}`, title: `Follow a request through ${entry.name}`, kind: 'request', stops });
    }
  }
  return [...firstDay, ...requests];
}
