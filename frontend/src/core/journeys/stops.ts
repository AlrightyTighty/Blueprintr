import { getNodeCategory, getResourceRole } from '../graph/nodeDisplay';
import type { EdgeRelation, GraphEdge, GraphNode } from '../graph/types';
import { isCodeNode, type JourneyContext } from './journeyContext';
import {
  arrivalSentence,
  capitalise,
  describeRole,
  inferredNote,
  listOut,
  relationPhrase,
  sentences,
  speakableName,
  warningSentence,
} from './narration';
import type { CodeRef, Stop } from './types';

const CODE_TOUCH_RELATIONS = new Set<EdgeRelation>(['reads', 'writes', 'publishes', 'invokes']);

interface CodeLink {
  codeNode: GraphNode;
  edge: GraphEdge;
  ref: CodeRef;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** The code that runs in this node (runs_code) or touches it (reads, writes, publishes), with where. */
function findCodeLinks(context: JourneyContext, node: GraphNode): CodeLink[] {
  const links: CodeLink[] = [];
  for (const edge of context.incomingByNodeId.get(node.id) ?? []) {
    const codeNode = context.nodeById.get(edge.source);
    if (!codeNode || !isCodeNode(codeNode)) continue;
    if (edge.relation !== 'runs_code' && !CODE_TOUCH_RELATIONS.has(edge.relation)) continue;

    const file = (typeof edge.evidence?.file === 'string' ? edge.evidence.file : undefined) ?? codeNode.filePath;
    if (!file) continue;
    const evidenceLine = asNumber(edge.evidence?.line);
    const startLine = evidenceLine ?? codeNode.lineStart ?? 1;
    const endLine = evidenceLine ?? codeNode.lineEnd ?? startLine;
    links.push({ codeNode, edge, ref: { file, startLine, endLine } });
  }
  return links;
}

/** Ids whose findings belong on this stop: the node, its role, the code running in it, and what that code touches unmanaged. */
function relatedFindingNodeIds(context: JourneyContext, node: GraphNode, runningCode: GraphNode[]): Set<string> {
  const ids = new Set<string>([node.id]);
  for (const edge of context.outgoingByNodeId.get(node.id) ?? []) {
    if (edge.relation === 'assumes_role') ids.add(edge.target);
  }
  for (const codeNode of runningCode) {
    ids.add(codeNode.id);
    for (const edge of context.outgoingByNodeId.get(codeNode.id) ?? []) {
      const target = context.nodeById.get(edge.target);
      if (target && ['unmanaged', 'unresolved'].includes(getNodeCategory(target))) ids.add(target.id);
    }
  }
  return ids;
}

/** One reference per file, covering every range found in it. */
function mergeRefsByFile(refs: CodeRef[]): CodeRef[] {
  const merged = new Map<string, CodeRef>();
  for (const ref of refs) {
    const existing = merged.get(ref.file);
    merged.set(
      ref.file,
      existing
        ? { file: ref.file, startLine: Math.min(existing.startLine, ref.startLine), endLine: Math.max(existing.endLine, ref.endLine) }
        : ref,
    );
  }
  return [...merged.values()];
}

function uniqueRefs(refs: CodeRef[]): CodeRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.file}:${ref.startLine}-${ref.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The files whose code runs in a function, one entry per file even when its functions are listed separately. */
function runningFiles(links: CodeLink[]): string[] {
  return [...new Set(links.map((link) => link.ref.file))];
}

/**
 * One stop on a tour: what the node is, how we got here, the code that touches it and any warnings.
 * `arrivalEdge` is the edge used to reach this node, or null for the first stop.
 */
export function buildStop(context: JourneyContext, nodeId: string, arrivalEdge: GraphEdge | null): Stop {
  const node = context.nodeById.get(nodeId)!;
  const codeLinks = findCodeLinks(context, node);
  const runningLinks = codeLinks.filter((link) => link.edge.relation === 'runs_code');
  const runningCode = runningLinks.map((link) => link.codeNode);

  const previous = arrivalEdge ? context.nodeById.get(arrivalEdge.source === nodeId ? arrivalEdge.target : arrivalEdge.source) : undefined;
  const arrival = arrivalEdge && previous ? { previous, edge: arrivalEdge } : null;

  // Arriving from a function, only that function's own code is relevant to what it does here.
  const codeRunningInPrevious =
    previous && getResourceRole(previous) === 'function'
      ? new Set(
          (context.incomingByNodeId.get(previous.id) ?? [])
            .filter((edge) => edge.relation === 'runs_code')
            .map((edge) => edge.source),
        )
      : null;
  const touchingCode = codeLinks.filter(
    (link) => link.edge.relation !== 'runs_code' && (!codeRunningInPrevious || codeRunningInPrevious.has(link.codeNode.id)),
  );

  const roleEdge = (context.outgoingByNodeId.get(nodeId) ?? []).find((edge) => edge.relation === 'assumes_role');
  const roleNode = roleEdge ? context.nodeById.get(roleEdge.target) : undefined;

  const relatedIds = relatedFindingNodeIds(context, node, runningCode);
  const warnings = [
    ...new Set(
      context.findings
        .filter(
          (finding) =>
            (finding.nodeId && relatedIds.has(finding.nodeId)) || (finding.relatedNodeId && relatedIds.has(finding.relatedNodeId)),
        )
        // "Can't tell which resource this call targets" is for the findings list, not the narrator.
        .filter((finding) => finding.kind !== 'unresolved_reference')
        // The title is short enough to say out loud; the full detail is on the Details tab.
        .map((finding) => finding.title),
    ),
  ];

  const files = runningFiles(runningLinks);
  const codeSentence =
    files.length > 0
      ? `The code that runs here is ${listOut(files.map((file) => `the file ${file}`))}.`
      : touchingCode.length > 0
        ? touchingCode
            .map((link) => `${capitalise(speakableName(link.codeNode))} ${relationPhrase(link.edge.relation)} it.`)
            .join(' ')
        : '';
  const roleSentence = roleNode ? `It runs as ${speakableName(roleNode)}.` : '';
  const isArrivalInferred = arrivalEdge?.confidence === 'inferred';
  const inferredCode = touchingCode.filter((link) => link.edge.confidence === 'inferred');
  const isInferred = isArrivalInferred || inferredCode.length > 0;

  const script = sentences(
    arrivalSentence(node, arrival),
    describeRole(node),
    codeSentence,
    roleSentence,
    isArrivalInferred && inferredNote('arrival'),
    inferredCode.length > 0 && inferredNote('code', inferredCode.map((link) => link.codeNode.address)),
    ...warnings.map(warningSentence),
  );

  return {
    nodeId,
    script,
    // Where the code runs: the whole file. Where it touches this node: the exact lines.
    codeRefs: uniqueRefs([...mergeRefsByFile(runningLinks.map((link) => link.ref)), ...touchingCode.map((link) => link.ref)]),
    warnings,
    inferred: isInferred,
  };
}

/** Whether a node is worth a stop of its own; IAM and wiring are told as part of the thing they serve. */
export function isTourStop(node: GraphNode): boolean {
  const role = getResourceRole(node);
  return getNodeCategory(node) !== 'code' && role !== 'role' && role !== 'glue';
}
