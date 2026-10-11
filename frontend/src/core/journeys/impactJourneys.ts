import { computeCascade } from '../graph/cascade';
import { getNodeCategory, getResourceRole, type ResourceRole } from '../graph/nodeDisplay';
import type { Finding, Graph, GraphNode, PlanChange } from '../graph/types';
import { createJourneyContext, isCodeNode, type JourneyContext } from './journeyContext';
import { isTourStop } from './stops';
import { capitalise, inferredNote, listOut, sentences, speakableName } from './narration';
import type { Journey, Stop } from './types';

/** Past this many stops a tour stops being a tour; the rest are summarised in the last stop. */
const MAX_IMPACT_STOPS = 14;

/** What breaks, in plain terms, when each kind of thing stops working. */
const FAILURE_SYMPTOMS: Record<ResourceRole, string> = {
  domain: 'To a user, the whole site is simply down.',
  cdn: 'Visitors now get error pages straight from the edge.',
  api: 'Every request that reaches it comes back as a server error.',
  function: 'It can no longer do its job, so any request that reaches it fails.',
  bucket: "Files can't be fetched or saved.",
  table: 'Reads and writes to it fail, and anything that needs that data goes with it.',
  queue: 'Messages stop flowing, so the work behind them quietly stops happening.',
  role: 'Whatever relied on its permissions loses them.',
  glue: 'Whatever it connects stops talking to each other.',
  other: 'Whatever depends on it stops working.',
};

function failureSentence(node: GraphNode): string {
  if (getNodeCategory(node) === 'code') {
    return 'It can no longer reach the resources it needs.';
  }
  return FAILURE_SYMPTOMS[getResourceRole(node)];
}

function simpleStop(nodeId: string, script: string, inferred = false): Stop {
  return { nodeId, script, codeRefs: [], warnings: [], inferred };
}

/** Kill one resource and walk outward along everything that depends on it, nearest first. */
export function buildDisasterJourney(graph: Graph, findings: Finding[], failedNodeId: string): Journey {
  const context = createJourneyContext(graph, findings);
  const failedNode = context.nodeById.get(failedNodeId)!;
  const hasFunctions = graph.nodes.some((node) => node.kind === 'code_function');
  // IAM and wiring aren't something a user would notice failing, and a file's functions are told individually.
  const cascade = computeCascade(graph, failedNodeId).filter((step) => {
    const node = context.nodeById.get(step.nodeId)!;
    return step.distance === 0 || (isTourStop(node) || (isCodeNode(node) && !(hasFunctions && node.kind === 'code_file')));
  });
  const shown = cascade.slice(0, MAX_IMPACT_STOPS);
  const hiddenCount = cascade.length - shown.length;

  const stops = shown.map((step, index): Stop => {
    const node = context.nodeById.get(step.nodeId)!;
    if (index === 0) {
      return simpleStop(
        node.id,
        sentences(
          `Now we pull the plug on ${speakableName(node)}.`,
          failureSentence(node),
          cascade.length > 1
            ? `${cascade.length - 1} other thing${cascade.length === 2 ? '' : 's'} depend${cascade.length === 2 ? 's' : ''} on it. Let's watch.`
            : 'Nothing else depends on it, so the damage stops right here.',
        ),
      );
    }
    const dependsOn = (context.outgoingByNodeId.get(node.id) ?? []).find((edge) =>
      shown.slice(0, index).some((earlier) => earlier.nodeId === edge.target),
    );
    const cause = dependsOn ? context.nodeById.get(dependsOn.target) : undefined;
    return simpleStop(
      node.id,
      sentences(
        `${capitalise(speakableName(node))} depends on ${cause ? speakableName(cause) : speakableName(failedNode)}, so it goes too.`,
        failureSentence(node),
        dependsOn?.confidence === 'inferred' && inferredNote('arrival'),
      ),
      dependsOn?.confidence === 'inferred',
    );
  });

  if (hiddenCount > 0) {
    const last = stops[stops.length - 1];
    last.script = sentences(last.script, `And ${hiddenCount} more further out.`);
  }

  return {
    id: `disaster:${failedNodeId}`,
    title: `Disaster tour: lose ${failedNode.name}`,
    kind: 'disaster',
    stops,
  };
}

const CHANGE_VERBS: Record<string, string> = {
  replace: 'replaced',
  destroy: 'destroyed',
  update: 'modified',
  create: 'created',
};

const SAFER_SEQUENCE =
  'A safer order: create the replacement first with create_before_destroy, copy the data across, switch the readers and writers over, then retire the old one.';

/**
 * Walk through a Terraform plan: what it changes directly, then what that reaches. Changes that
 * aren't in the graph are left out. The plan is only ever read, never applied.
 */
export function buildChangeJourney(graph: Graph, findings: Finding[], planChanges: PlanChange[]): Journey | null {
  const context = createJourneyContext(graph, findings);
  const inGraph = planChanges.filter((change) => change.nodeId && context.nodeById.has(change.nodeId));
  const direct = inGraph.filter((change) => change.impact === 'direct');
  const downstream = inGraph.filter((change) => change.impact === 'downstream').sort((first, second) => first.distance - second.distance);
  if (direct.length === 0) return null;

  const severity = (change: PlanChange) => (change.action === 'destroy' || change.action === 'replace' ? 0 : 1);
  const ordered = [...direct.sort((first, second) => severity(first) - severity(second)), ...downstream].slice(0, MAX_IMPACT_STOPS);
  const hasDestructive = direct.some((change) => severity(change) === 0);

  const stops = ordered.map((change): Stop => {
    const node = context.nodeById.get(change.nodeId!)!;
    if (change.impact === 'direct') {
      const dataLoss = change.action === 'replace' || change.action === 'destroy' ? getResourceRole(node) === 'table' || getResourceRole(node) === 'bucket' : false;
      return simpleStop(
        node.id,
        sentences(
          `${capitalise(speakableName(node))} will be ${CHANGE_VERBS[change.action] ?? 'changed'}.`,
          dataLoss && "Replacing a data store drops what's in it unless you migrate first.",
          change.changedAttributes.length > 0 && `What changes: ${listOut(change.changedAttributes)}.`,
        ),
      );
    }
    return simpleStop(
      node.id,
      sentences(
        `${capitalise(speakableName(node))} is ${change.distance} hop${change.distance === 1 ? '' : 's'} away, and it depends on what is changing.`,
        failureSentence(node),
      ),
    );
  });

  if (hasDestructive && stops.length > 0) {
    const last = stops[stops.length - 1];
    last.script = sentences(last.script, SAFER_SEQUENCE);
  }

  return {
    id: 'change:plan',
    title: `Change tour: ${direct.length} change${direct.length === 1 ? '' : 's'}`,
    kind: 'change',
    stops,
  };
}
