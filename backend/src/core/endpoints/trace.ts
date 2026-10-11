import type { Confidence, EdgeRelation, Graph, GraphEdge, GraphNode } from '../graph/types.js';
import { CONFIDENCE_ORDER } from '../graph/types.js';
import { apiOf, functionOf, indexGraph, listEndpoints, type EndpointInfo, type GraphIndex } from './list.js';
import { closestEndpoints, matchRequest, normalizePath, type Match } from './match.js';
import type { EndpointKind } from './types.js';

export type TracePhase = 'front_door' | 'api' | 'route' | 'integration' | 'compute' | 'code' | 'data';

/** One function (or role) of the request that touches a step's node. */
export interface TraceUse {
  nodeId: string;
  relation: EdgeRelation;
  confidence: Confidence;
  edgeId: string;
  /** True when the touching function runs in the background, after the response. */
  async: boolean;
}

/** One stop along a request, in the order the request reaches it. */
export interface TraceStep {
  nodeId: string;
  /** The node the request came from; null for the first step. */
  fromNodeId: string | null;
  /** How the request got here (for example `routes_to`, `invokes`, `calls`, `reads`). */
  relation: EdgeRelation | null;
  /** The weakest link on the way in. `inferred` means a model guessed it. */
  confidence: Confidence | null;
  edgeIds: string[];
  phase: TracePhase;
  /** True once the request continues in the background (a queue handing work to another Lambda). */
  async: boolean;
  /** For data steps: every traced function that touches it, and how. */
  uses: TraceUse[];
}

export interface EndpointTrace {
  request: { method: string; path: string };
  match: {
    endpointId: string;
    kind: EndpointKind;
    method: string;
    path: string;
    isDefault: boolean;
    pathParams: Record<string, string>;
    alternates: { endpointId: string; kind: EndpointKind; method: string; path: string }[];
  };
  /**
   * `endpoint`: the Lambda serves only this endpoint, so the code shown is what the request runs.
   * `shared_handler`: the Lambda serves several endpoints through one handler, so the code shown is everything the
   * handler can reach; the infrastructure cannot say which branch this endpoint takes.
   */
  codeScope: 'endpoint' | 'shared_handler';
  steps: TraceStep[];
  /** The graph edges the trace used, so a viewer can highlight them. */
  edges: GraphEdge[];
  /** Things the trace could not follow, said plainly instead of guessed. */
  gaps: string[];
  truncated: boolean;
  summary: string;
}

const MAX_STEPS = 60;
const MAX_CALL_DEPTH = 12;
const MAX_ASYNC_HOPS = 3;
/** What a function can do to a resource, in the order the code does it. */
const CODE_TOUCH_RELATIONS = new Set<EdgeRelation>(['calls', 'reads', 'writes', 'publishes', 'invokes', 'references']);

const weaker = (a: Confidence | null, b: Confidence): Confidence => (a && CONFIDENCE_ORDER.indexOf(a) > CONFIDENCE_ORDER.indexOf(b) ? a : b);
const lineOf = (edge: GraphEdge) => (typeof edge.evidence?.line === 'number' ? edge.evidence.line : Number.POSITIVE_INFINITY);
const isCode = (node: GraphNode | undefined) => node?.kind === 'code_function' || node?.kind === 'code_file';

const KIND_LABEL: Record<EndpointKind, string> = {
  http_api: 'an HTTP API route',
  rest_api: 'a REST API method',
  function_url: 'a Lambda function URL',
};

/** How a node is named in the summary. */
function describe(node: GraphNode): string {
  if (node.kind === 'code_function') return `the function ${node.name}`;
  if (node.kind === 'code_file') return `the file ${node.filePath ?? node.name}`;
  if (node.kind === 'unmanaged_resource') return `${node.name} (not defined in your infrastructure code)`;
  return `the ${(node.resourceType?.displayName ?? 'resource').toLowerCase()} ${node.name}`;
}

const list = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Follows one request through the stored graph, from the front door to the data it touches:
 * domain or CDN, API, route, integration, Lambda, handler, the functions it calls, and what they use.
 * Where a queue hands work to another Lambda, the trace carries on in the background, marked `async`.
 * Everything comes from the graph; if a link is missing the trace says so in `gaps`.
 */
export function traceEndpoint(
  graph: Graph,
  endpoint: EndpointInfo,
  rawRequest: { method: string; path: string },
  options: { params?: Record<string, string>; alternates?: EndpointInfo[]; index?: GraphIndex } = {},
): EndpointTrace {
  // Echo the request the way it was understood: upper-case method, no query string or stray slashes.
  const request = { method: rawRequest.method.toUpperCase(), path: normalizePath(rawRequest.path) };
  const index = options.index ?? indexGraph(graph);
  const { nodeById, outgoing, incoming } = index;
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));

  const steps: TraceStep[] = [];
  const stepByNode = new Map<string, TraceStep>();
  const gaps: string[] = [];
  let truncated = false;
  let codeScope: EndpointTrace['codeScope'] = 'endpoint';

  /** Adds a stop, or returns the existing one when the request already passed through that node. */
  function add(step: Omit<TraceStep, 'uses'>): { step: TraceStep; created: boolean } | null {
    const existing = stepByNode.get(step.nodeId);
    if (existing) return { step: existing, created: false };
    if (steps.length >= MAX_STEPS) {
      truncated = true;
      return null;
    }
    const created: TraceStep = { ...step, uses: [] };
    steps.push(created);
    stepByNode.set(step.nodeId, created);
    return { step: created, created: true };
  }
  const via = (edges: GraphEdge[]) => ({
    edgeIds: edges.map((e) => e.id),
    confidence: edges.reduce<Confidence | null>((acc, e) => weaker(acc, e.confidence), null),
  });

  // ---- front door -> API ----------------------------------------------------------------------------------------
  const apiEdge = apiOf(index, endpoint.id);
  const apiNode = apiEdge ? nodeById.get(apiEdge.target) : undefined;
  if (apiNode) {
    const chain: GraphEdge[] = [];
    const seen = new Set([apiNode.id]);
    for (let current = apiNode.id; chain.length < 6; ) {
      const edge = (incoming.get(current) ?? []).find((e) => e.relation === 'routes_to' && !seen.has(e.source));
      if (!edge) break;
      chain.unshift(edge);
      seen.add(edge.source);
      current = edge.source;
    }
    if (chain.length === 0) {
      add({ nodeId: apiNode.id, fromNodeId: null, relation: null, confidence: null, edgeIds: [], phase: 'api', async: false });
    } else {
      add({ nodeId: chain[0]!.source, fromNodeId: null, relation: null, confidence: null, edgeIds: [], phase: 'front_door', async: false });
      for (const edge of chain) {
        add({ nodeId: edge.target, fromNodeId: edge.source, relation: 'routes_to', ...via([edge]), phase: edge.target === apiNode.id ? 'api' : 'front_door', async: false });
      }
    }
  }

  // ---- route / integration -> Lambda ------------------------------------------------------------------------------
  add({
    nodeId: endpoint.id,
    fromNodeId: apiNode?.id ?? null,
    relation: apiEdge ? 'routes_to' : null,
    ...(apiEdge ? via([apiEdge]) : { edgeIds: [], confidence: null }),
    phase: 'route',
    async: false,
  });

  const target = functionOf(index, endpoint.id);
  if (!target) {
    const endpointNode = nodeById.get(endpoint.id)!;
    gaps.push(`${endpointNode.address} does not point at a Lambda function that Ripplemap can see (it may proxy to a URL or another service), so the trace stops at the route.`);
    return finish();
  }
  const sharing = listEndpoints(graph, index).filter((e) => e.functionNodeId === target.functionId);
  codeScope = sharing.length > 1 ? 'shared_handler' : 'endpoint';
  if (codeScope === 'shared_handler') {
    gaps.push(
      `${describe(nodeById.get(target.functionId)!)} serves ${sharing.length} endpoints through one handler, and Ripplemap can't tell which code path ${endpoint.method} ${endpoint.path} takes inside it, so the code shown is everything the handler can reach.`,
    );
  }
  let upstream = endpoint.id;
  if (target.integrationId) {
    add({ nodeId: target.integrationId, fromNodeId: endpoint.id, relation: 'references', ...via([target.edges[0]!]), phase: 'integration', async: false });
    upstream = target.integrationId;
  }

  // ---- inside the Lambda: handler, calls, resources -----------------------------------------------------------------
  const queues: { queueId: string; hops: number }[] = [];

  function visitCode(fn: GraphNode, depth: number, isAsync: boolean): void {
    const edges = (outgoing.get(fn.id) ?? [])
      .filter((e) => CODE_TOUCH_RELATIONS.has(e.relation))
      .sort((a, b) => lineOf(a) - lineOf(b) || a.id.localeCompare(b.id));
    for (const edge of edges) {
      const next = nodeById.get(edge.target);
      if (!next) continue;
      if (edge.relation === 'calls') {
        if (depth >= MAX_CALL_DEPTH || stepByNode.has(next.id)) continue;
        const added = add({ nodeId: next.id, fromNodeId: fn.id, relation: 'calls', ...via([edge]), phase: 'code', async: isAsync });
        if (added?.created) visitCode(next, depth + 1, isAsync);
      } else if (!isCode(next)) {
        const added = add({ nodeId: next.id, fromNodeId: fn.id, relation: edge.relation, ...via([edge]), phase: 'data', async: isAsync });
        added?.step.uses.push({ nodeId: fn.id, relation: edge.relation, confidence: edge.confidence, edgeId: edge.id, async: isAsync });
        if (added && edge.relation === 'publishes' && next.terraformType === 'aws_sqs_queue') queues.push({ queueId: next.id, hops: 0 });
      }
    }
  }

  function enterLambda(lambdaId: string, from: { nodeId: string; relation: EdgeRelation; edges: GraphEdge[] }, isAsync: boolean): void {
    const added = add({ nodeId: lambdaId, fromNodeId: from.nodeId, relation: from.relation, ...via(from.edges), phase: 'compute', async: isAsync });
    if (!added?.created) return;
    const lambda = nodeById.get(lambdaId)!;
    const runs = (incoming.get(lambdaId) ?? []).filter((e) => e.relation === 'runs_code' && e.evidence?.handler === true);
    const handlers = runs.flatMap((e) => (nodeById.get(e.source)?.kind === 'code_function' ? [{ edge: e, node: nodeById.get(e.source)! }] : []));
    if (handlers.length === 0) {
      const file = runs.find((e) => nodeById.get(e.source)?.kind === 'code_file');
      if (file) {
        add({ nodeId: file.source, fromNodeId: lambdaId, relation: 'runs_code', ...via([file]), phase: 'code', async: isAsync });
        gaps.push(`${lambda.address} runs ${nodeById.get(file.source)!.name}, but Ripplemap could not find the handler function inside it, so the trace shows the file only.`);
      } else {
        gaps.push(`No code is mapped to ${lambda.address}, so the trace cannot show what runs there. Its handler (${String(lambda.attributes?.handler ?? 'unknown')}) was not found, or matched several files.`);
      }
      return;
    }
    for (const { edge, node } of handlers) {
      const handlerStep = add({ nodeId: node.id, fromNodeId: lambdaId, relation: 'runs_code', ...via([edge]), phase: 'code', async: isAsync });
      if (handlerStep?.created) visitCode(node, 0, isAsync);
    }
  }

  const invokeEdge = target.edges[target.edges.length - 1]!;
  enterLambda(target.functionId, { nodeId: upstream, relation: 'invokes', edges: [invokeEdge] }, false);

  // Work handed to a queue carries on after the response, in whatever Lambda consumes it.
  for (let i = 0; i < queues.length; i++) {
    const { queueId, hops } = queues[i]!;
    if (hops >= MAX_ASYNC_HOPS) continue;
    for (const toQueue of incoming.get(queueId) ?? []) {
      const mapping = nodeById.get(toQueue.source);
      if (mapping?.terraformType !== 'aws_lambda_event_source_mapping') continue;
      const toFunction = (outgoing.get(mapping.id) ?? []).find((e) => e.relation === 'invokes' && nodeById.get(e.target)?.terraformType === 'aws_lambda_function');
      if (!toFunction || stepByNode.has(toFunction.target)) continue;
      const before = queues.length;
      enterLambda(toFunction.target, { nodeId: queueId, relation: 'invokes', edges: [toQueue, toFunction] }, true);
      for (let j = before; j < queues.length; j++) queues[j] = { ...queues[j]!, hops: hops + 1 };
    }
  }

  return finish();

  // ---- result ---------------------------------------------------------------------------------------------------------------
  function finish(): EndpointTrace {
    const edges = [...new Set(steps.flatMap((s) => s.edgeIds))].flatMap((id) => (edgeById.get(id) ? [edgeById.get(id)!] : []));
    const named = (step: TraceStep) => nodeById.get(step.nodeId)!;
    const lambdaSteps = steps.filter((s) => s.phase === 'compute' && !s.async);
    const codeSteps = steps.filter((s) => s.phase === 'code' && !s.async);
    const dataSteps = steps.filter((s) => s.phase === 'data' && !s.async);
    const verbs: [EdgeRelation, string][] = [['reads', 'reads'], ['writes', 'writes to'], ['publishes', 'publishes to'], ['invokes', 'invokes'], ['references', 'uses']];

    const sentences = [
      `${request.method} ${request.path} is handled by ${endpoint.method} ${endpoint.path}, ${KIND_LABEL[endpoint.kind]}${apiNode ? ` on ${describe(apiNode)}` : ''}.`,
    ];
    if (lambdaSteps[0]) {
      const functions = codeSteps.map((s) => named(s).name);
      sentences.push(
        `It invokes ${describe(named(lambdaSteps[0]))}${functions.length > 0 ? `, which runs ${list(functions)}` : ''}.`,
      );
    }
    const dataClauses = verbs.flatMap(([relation, verb]) => {
      const targets = dataSteps.filter((s) => s.uses.some((u) => u.relation === relation && !u.async)).map((s) => describe(named(s)));
      return targets.length > 0 ? [`${verb} ${list(targets)}`] : [];
    });
    if (dataClauses.length > 0) sentences.push(`Along the way it ${dataClauses.join('; ')}.`);
    for (const step of steps.filter((s) => s.async && s.phase === 'compute')) {
      const from = step.fromNodeId ? nodeById.get(step.fromNodeId) : undefined;
      sentences.push(`Afterwards${from ? `, ${describe(from)} triggers` : ' it triggers'} ${describe(named(step))} in the background.`);
    }
    if (truncated) sentences.push('The trace was cut short because it is very long.');
    for (const gap of gaps) sentences.push(gap);

    return {
      request,
      match: {
        endpointId: endpoint.id,
        kind: endpoint.kind,
        method: endpoint.method,
        path: endpoint.path,
        isDefault: endpoint.isDefault === true,
        pathParams: options.params ?? {},
        alternates: (options.alternates ?? []).map((a) => ({ endpointId: a.id, kind: a.kind, method: a.method, path: a.path })),
      },
      codeScope,
      steps,
      edges,
      gaps,
      truncated,
      summary: sentences.join(' '),
    };
  }
}

export type TraceOutcome =
  | { found: true; trace: EndpointTrace }
  | { found: false; reason: 'no_endpoints' | 'unknown_endpoint' | 'no_match'; closest: EndpointInfo[] };

/** `METHOD path` (or a chosen endpoint id) in, trace out; or why nothing matched, with the nearest endpoints. */
export function traceRequest(graph: Graph, request: { method: string; path: string; endpointId?: string }): TraceOutcome {
  const index = indexGraph(graph);
  const endpoints = listEndpoints(graph, index);
  if (endpoints.length === 0) return { found: false, reason: 'no_endpoints', closest: [] };

  if (request.endpointId) {
    const chosen = endpoints.find((e) => e.id === request.endpointId);
    if (!chosen) return { found: false, reason: 'unknown_endpoint', closest: endpoints.slice(0, 5) };
    const match = matchRequest([chosen], request.method, request.path);
    return { found: true, trace: traceEndpoint(graph, chosen, request, { params: match?.best.params, index }) };
  }

  const result = matchRequest(endpoints, request.method, request.path);
  if (!result) return { found: false, reason: 'no_match', closest: closestEndpoints(endpoints, request.method, request.path) };
  const alternates: Match[] = result.alternates;
  return {
    found: true,
    trace: traceEndpoint(graph, result.best.endpoint, request, { params: result.best.params, alternates: alternates.map((m) => m.endpoint), index }),
  };
}
