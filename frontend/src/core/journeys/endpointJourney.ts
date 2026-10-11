import type { EndpointKind, EndpointTrace, Finding, Graph, GraphEdge, GraphNode, TraceStep } from '../graph/types';
import { createJourneyContext, isCodeNode, type JourneyContext } from './journeyContext';
import {
  arrivalSentence,
  capitalise,
  describeRole,
  inferredNote,
  relationPhrase,
  sentences,
  speakableName,
  warningSentence,
} from './narration';
import { buildStop } from './stops';
import type { CodeRef, Journey, Stop } from './types';

const KIND_PHRASE: Record<EndpointKind, string> = {
  http_api: 'the HTTP API route',
  rest_api: 'the REST API method',
  function_url: 'the Lambda function URL',
};

/** The edge a step arrived by. Several real edges can lie behind one hop (route, integration), so it is rebuilt from the step. */
function arrivalEdge(step: TraceStep, index: number): GraphEdge | null {
  if (!step.fromNodeId || !step.relation) return null;
  return {
    id: `trace:${index}`,
    source: step.fromNodeId,
    target: step.nodeId,
    relation: step.relation,
    linkMethod: 'code_mapping',
    confidence: step.confidence ?? 'certain',
    evidence: {},
  };
}

/** Titles of the open findings about this node, short enough to say aloud. "Can't tell which resource" stays in the list. */
function warningsFor(context: JourneyContext, node: GraphNode): string[] {
  return [
    ...new Set(
      context.findings
        .filter((finding) => finding.kind !== 'unresolved_reference' && (finding.nodeId === node.id || finding.relatedNodeId === node.id))
        .map((finding) => finding.title),
    ),
  ];
}

function refFromNode(node: GraphNode): CodeRef[] {
  if (!node.filePath || !node.lineStart) return [];
  return [{ file: node.filePath, startLine: node.lineStart, endLine: node.lineEnd ?? node.lineStart }];
}

/** A function (or file) the request runs: where it came from, its own lines, and anything wrong with it. */
function codeStop(context: JourneyContext, node: GraphNode, step: TraceStep, index: number): Stop {
  const edge = arrivalEdge(step, index);
  const previous = edge ? context.nodeById.get(edge.source) : undefined;
  const warnings = warningsFor(context, node);
  return {
    nodeId: node.id,
    script: sentences(
      previous && edge ? arrivalSentence(node, { previous, edge }) : `We start at ${speakableName(node)}.`,
      step.confidence === 'inferred' && inferredNote('arrival'),
      ...warnings.map(warningSentence),
    ),
    codeRefs: refFromNode(node),
    warnings,
    inferred: step.confidence === 'inferred',
  };
}

/** A resource the traced code uses: the first function that reaches it, anyone else who does too, and the exact lines. */
function dataStop(context: JourneyContext, node: GraphNode, step: TraceStep, index: number, edgeById: Map<string, GraphEdge>): Stop {
  const edge = arrivalEdge(step, index);
  const previous = edge ? context.nodeById.get(edge.source) : undefined;
  const others = step.uses.slice(1).flatMap((use) => {
    const user = context.nodeById.get(use.nodeId);
    return user ? [`${capitalise(speakableName(user))} ${relationPhrase(use.relation)} it${use.async ? ' too, later, in the background' : ' too'}.`] : [];
  });
  const inferredUsers = step.uses.filter((use) => use.confidence === 'inferred').flatMap((use) => context.nodeById.get(use.nodeId)?.address ?? []);
  const warnings = warningsFor(context, node);
  const refs = step.uses.flatMap((use): CodeRef[] => {
    const evidence = edgeById.get(use.edgeId)?.evidence;
    const file = typeof evidence?.file === 'string' ? evidence.file : undefined;
    const line = typeof evidence?.line === 'number' ? evidence.line : undefined;
    return file && line ? [{ file, startLine: line, endLine: line }] : [];
  });
  return {
    nodeId: node.id,
    script: sentences(
      previous && edge ? arrivalSentence(node, { previous, edge }) : `We start at ${speakableName(node)}.`,
      describeRole(node),
      ...others,
      inferredUsers.length > 0 && inferredNote('code', inferredUsers),
      ...warnings.map(warningSentence),
    ),
    codeRefs: refs.filter((ref, i) => refs.findIndex((other) => other.file === ref.file && other.startLine === ref.startLine) === i),
    warnings,
    inferred: inferredUsers.length > 0,
  };
}

/** The route the request matched, said the way a developer would: method, path and what the placeholders became. */
function routeStop(context: JourneyContext, node: GraphNode, step: TraceStep, index: number, trace: EndpointTrace): Stop {
  const { match } = trace;
  const params = Object.entries(match.pathParams).map(([name, value]) => `Here {${name}} is ${value}.`);
  const base = buildStop(context, node.id, arrivalEdge(step, index));
  const alternates = match.alternates.length;
  return {
    ...base,
    script: sentences(
      `The request matches ${KIND_PHRASE[match.kind]} ${match.method} ${match.path}.`,
      ...params,
      match.isDefault && "This is a catch-all, used because no more specific route matches.",
      alternates > 0 && `${alternates} other endpoint${alternates === 1 ? '' : 's'} match equally well; this tour follows the first.`,
      step.confidence === 'inferred' && inferredNote('arrival'),
      ...base.warnings.map(warningSentence),
    ),
  };
}

/**
 * The tour for one "called" endpoint: the trace the backend produced, told stop by stop. Resource stops
 * reuse the same narration as every other tour; functions and the data they touch get stops written for
 * a request (this function calls that one; it reads this table).
 */
export function buildEndpointJourney(graph: Graph, findings: Finding[], trace: EndpointTrace): Journey {
  const context = createJourneyContext(graph, findings);
  const edgeById = new Map(graph.edges.map((edge) => [edge.id, edge]));
  const firstCodeIndex = trace.steps.findIndex((step) => step.phase === 'code');
  const firstAsyncIndex = trace.steps.findIndex((step) => step.async);

  const stops: Stop[] = [];
  trace.steps.forEach((step, index) => {
    const node = context.nodeById.get(step.nodeId);
    if (!node) return;
    let stop: Stop;
    if (step.phase === 'route') stop = routeStop(context, node, step, index, trace);
    else if (isCodeNode(node)) stop = codeStop(context, node, step, index);
    else if (step.phase === 'data') stop = dataStop(context, node, step, index, edgeById);
    else stop = buildStop(context, node.id, arrivalEdge(step, index));

    // The background caveat opens the first background stop; the shared-handler caveat belongs where the code starts.
    const before = index === firstAsyncIndex ? ["The caller already has its answer, but the work isn't finished: the request carries on in the background."] : [];
    const after = index === firstCodeIndex && trace.codeScope === 'shared_handler' && trace.gaps[0] ? [`One honest note: ${trace.gaps[0]}`] : [];
    stops.push({ ...stop, script: sentences(...before, stop.script, ...after) });
  });

  const closingGaps = trace.codeScope === 'shared_handler' ? trace.gaps.slice(1) : trace.gaps;
  const notes = [...closingGaps, ...(trace.truncated ? ['This tour stops here because the request goes much deeper; the graph has the rest.'] : [])];
  const last = stops[stops.length - 1];
  if (last && notes.length > 0) last.script = sentences(last.script, ...notes.map((note) => `One honest note: ${note}`));
  if (stops[0]) stops[0] = { ...stops[0], script: sentences(`You call ${trace.request.method} ${trace.request.path}.`, stops[0].script) };

  return {
    id: `endpoint:${trace.match.endpointId}:${trace.request.method} ${trace.request.path}`,
    title: `Follow ${trace.request.method} ${trace.request.path}`,
    kind: 'endpoint',
    stops,
  };
}
