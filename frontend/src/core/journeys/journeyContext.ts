import { getNodeCategory } from '../graph/nodeDisplay';
import type { Finding, Graph, GraphEdge, GraphNode } from '../graph/types';

/** The graph plus lookups every journey builder needs, built once per graph. */
export interface JourneyContext {
  graph: Graph;
  /** Open (not dismissed) findings only. */
  findings: Finding[];
  nodeById: Map<string, GraphNode>;
  outgoingByNodeId: Map<string, GraphEdge[]>;
  incomingByNodeId: Map<string, GraphEdge[]>;
}

export function createJourneyContext(graph: Graph, findings: Finding[]): JourneyContext {
  const outgoingByNodeId = new Map<string, GraphEdge[]>();
  const incomingByNodeId = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    outgoingByNodeId.set(edge.source, [...(outgoingByNodeId.get(edge.source) ?? []), edge]);
    incomingByNodeId.set(edge.target, [...(incomingByNodeId.get(edge.target) ?? []), edge]);
  }
  return {
    graph,
    findings: findings.filter((finding) => !finding.dismissedAt),
    nodeById: new Map(graph.nodes.map((node) => [node.id, node])),
    outgoingByNodeId,
    incomingByNodeId,
  };
}

export function isCodeNode(node: GraphNode | undefined): boolean {
  return node !== undefined && getNodeCategory(node) === 'code';
}
