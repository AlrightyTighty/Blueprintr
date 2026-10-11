import type { Graph, GraphEdge, GraphNode } from '../graph/types.js';
import type { EndpointAttributes, EndpointKind } from './types.js';

/** One entry point into the system, as listed to users. */
export interface EndpointInfo extends EndpointAttributes {
  /** The graph node that represents it (a route, a REST method, or a function URL). */
  id: string;
  address: string;
  /** The API Gateway API that serves it; null for function URLs. */
  apiNodeId: string | null;
  /** The Lambda function it invokes, if the infrastructure says so. */
  functionNodeId: string | null;
}

const API_TYPES = new Set(['aws_apigatewayv2_api', 'aws_api_gateway_rest_api']);

export function isEndpointAttributes(value: unknown): value is EndpointAttributes {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (['http_api', 'rest_api', 'function_url'] as EndpointKind[]).includes(v.kind as EndpointKind) && typeof v.method === 'string' && typeof v.path === 'string';
}

export interface GraphIndex {
  nodeById: Map<string, GraphNode>;
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
}

export function indexGraph(graph: Graph): GraphIndex {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge]);
  }
  return { nodeById: new Map(graph.nodes.map((n) => [n.id, n])), outgoing, incoming };
}

/** The Lambda an endpoint hands requests to: directly, or through an HTTP API integration. */
export function functionOf(index: GraphIndex, endpointNodeId: string): { functionId: string; integrationId: string | null; edges: GraphEdge[] } | null {
  const direct = (index.outgoing.get(endpointNodeId) ?? []).find((e) => e.relation === 'invokes' && index.nodeById.get(e.target)?.terraformType === 'aws_lambda_function');
  if (direct) return { functionId: direct.target, integrationId: null, edges: [direct] };
  for (const toIntegration of index.outgoing.get(endpointNodeId) ?? []) {
    const integration = index.nodeById.get(toIntegration.target);
    if (integration?.terraformType !== 'aws_apigatewayv2_integration') continue;
    const invokes = (index.outgoing.get(integration.id) ?? []).find((e) => e.relation === 'invokes' && index.nodeById.get(e.target)?.terraformType === 'aws_lambda_function');
    if (invokes) return { functionId: invokes.target, integrationId: integration.id, edges: [toIntegration, invokes] };
  }
  return null;
}

/** The API an endpoint belongs to: the route's (or REST method's) own link to its API. */
export function apiOf(index: GraphIndex, endpointNodeId: string): GraphEdge | null {
  return (index.outgoing.get(endpointNodeId) ?? []).find((e) => API_TYPES.has(index.nodeById.get(e.target)?.terraformType ?? '')) ?? null;
}

/** Every endpoint in a graph, in path then method order. */
export function listEndpoints(graph: Graph, index: GraphIndex = indexGraph(graph)): EndpointInfo[] {
  const endpoints: EndpointInfo[] = [];
  for (const node of graph.nodes) {
    const attribute = node.attributes?.endpoint;
    if (!isEndpointAttributes(attribute)) continue;
    endpoints.push({
      ...attribute,
      id: node.id,
      address: node.address,
      apiNodeId: apiOf(index, node.id)?.target ?? null,
      functionNodeId: functionOf(index, node.id)?.functionId ?? null,
    });
  }
  return endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.address.localeCompare(b.address));
}
