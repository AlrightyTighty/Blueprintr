import { getNodeCategory, getResourceRole } from '../graph/nodeDisplay';
import type { Finding, Graph, GraphEdge, GraphNode } from '../graph/types';

/** The graph plus lookups every journey builder needs, built once per graph. */
export interface JourneyContext {
  graph: Graph;
  /** Open (not dismissed) findings only. */
  findings: Finding[];
  nodeById: Map<string, GraphNode>;
  outgoingByNodeId: Map<string, GraphEdge[]>;
  incomingByNodeId: Map<string, GraphEdge[]>;
  /**
   * Where a request goes next from each node. Same as the graph's edges, plus one edge per piece of
   * wiring: an API route or queue trigger "connection" node that references a source and invokes a
   * function means the source hands requests to that function.
   */
  flowEdgesByNodeId: Map<string, GraphEdge[]>;
}

export function createJourneyContext(graph: Graph, findings: Finding[]): JourneyContext {
  const outgoingByNodeId = new Map<string, GraphEdge[]>();
  const incomingByNodeId = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    outgoingByNodeId.set(edge.source, [...(outgoingByNodeId.get(edge.source) ?? []), edge]);
    incomingByNodeId.set(edge.target, [...(incomingByNodeId.get(edge.target) ?? []), edge]);
  }
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return {
    graph,
    findings: findings.filter((finding) => !finding.dismissedAt),
    nodeById,
    outgoingByNodeId,
    incomingByNodeId,
    flowEdgesByNodeId: buildFlowEdges(graph, nodeById, outgoingByNodeId),
  };
}

function buildFlowEdges(
  graph: Graph,
  nodeById: Map<string, GraphNode>,
  outgoingByNodeId: Map<string, GraphEdge[]>,
): Map<string, GraphEdge[]> {
  const flowEdgesByNodeId = new Map<string, GraphEdge[]>(outgoingByNodeId);
  for (const node of graph.nodes) {
    if (getResourceRole(node) !== 'glue') continue;
    const outgoing = outgoingByNodeId.get(node.id) ?? [];
    const invocation = outgoing.find((edge) => edge.relation === 'invokes');
    if (!invocation) continue;
    for (const edge of outgoing) {
      const source = nodeById.get(edge.target);
      if (edge.relation !== 'references' || !source || getResourceRole(source) === 'role') continue;
      const handoff: GraphEdge = {
        id: `glue:${node.id}:${source.id}`,
        source: source.id,
        target: invocation.target,
        relation: 'invokes',
        linkMethod: invocation.linkMethod,
        confidence: invocation.confidence,
        evidence: invocation.evidence,
      };
      flowEdgesByNodeId.set(source.id, [...(flowEdgesByNodeId.get(source.id) ?? []), handoff]);
    }
  }
  return flowEdgesByNodeId;
}

export function isCodeNode(node: GraphNode | undefined): boolean {
  return node !== undefined && getNodeCategory(node) === 'code';
}
