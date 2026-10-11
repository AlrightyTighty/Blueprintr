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

function uniqueRefs(refs: CodeRef[]): CodeRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.file}:${ref.startLine}-${ref.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One stop on a tour: what the node is, how we got here, the code that touches it and any warnings.
 * `arrivalEdge` is the edge used to reach this node, or null for the first stop.
 */
export function buildStop(context: JourneyContext, nodeId: string, arrivalEdge: GraphEdge | null): Stop {
  const node = context.nodeById.get(nodeId)!;
  const codeLinks = findCodeLinks(context, node);
  const runningCode = codeLinks.filter((link) => link.edge.relation === 'runs_code').map((link) => link.codeNode);
  const touchingCode = codeLinks.filter((link) => link.edge.relation !== 'runs_code');

  const previous = arrivalEdge ? context.nodeById.get(arrivalEdge.source === nodeId ? arrivalEdge.target : arrivalEdge.source) : undefined;
  const arrival = arrivalEdge && previous ? { previous, edge: arrivalEdge } : null;

  const roleEdge = (context.outgoingByNodeId.get(nodeId) ?? []).find((edge) => edge.relation === 'assumes_role');
  const roleNode = roleEdge ? context.nodeById.get(roleEdge.target) : undefined;

  const warnings = context.findings
    .filter((finding) => {
      const ids = relatedFindingNodeIds(context, node, runningCode);
      return (finding.nodeId && ids.has(finding.nodeId)) || (finding.relatedNodeId && ids.has(finding.relatedNodeId));
    })
    .map((finding) => finding.detail ?? finding.title);
  const uniqueWarnings = [...new Set(warnings)];

  const codeSentence =
    runningCode.length > 0
      ? `The code that runs here is ${listOut(runningCode.map((codeNode) => speakableName(codeNode)))}.`
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
    inferredCode.length > 0 && inferredNote('code', inferredCode.map((link) => link.codeNode.filePath ?? link.codeNode.name)),
    ...uniqueWarnings.map(warningSentence),
  );

  return {
    nodeId,
    script,
    codeRefs: uniqueRefs(codeLinks.map((link) => link.ref)),
    warnings: uniqueWarnings,
    inferred: isInferred,
  };
}

/** Roles that make sense as stops on a request path; IAM roles are told as part of the function's stop. */
export function isTourStop(node: GraphNode): boolean {
  const category = getNodeCategory(node);
  return category !== 'iam_role' && category !== 'code' && getResourceRole(node) !== 'role';
}
