// Offline stand-ins for the Gemini and ElevenLabs endpoints. They run on the local graph only, so
// they work with no backend or Wi-Fi. The UI labels their output as offline, never as AI-generated.
import { blastRadius } from '../core/graph/blastRadius';
import { getNodeDisplayName } from '../core/graph/nodeDisplay';
import type {
  AskResult,
  Briefing,
  BriefingRecommendation,
  Graph,
  PlanChange,
  PlanExplanation,
} from '../core/graph/types';

const DATA_STORE_TYPES = new Set(['aws_dynamodb_table', 'aws_s3_bucket', 'aws_db_instance', 'aws_sqs_queue']);

function isDestructive(change: PlanChange): boolean {
  return change.impact === 'direct' && (change.action === 'replace' || change.action === 'destroy');
}

function isDataStore(change: PlanChange): boolean {
  return change.terraformType != null && DATA_STORE_TYPES.has(change.terraformType);
}

export function createOfflineExplanation(planChanges: PlanChange[]): PlanExplanation {
  const destructiveChanges = planChanges.filter(isDestructive);
  const downstreamCount = planChanges.filter((change) => change.impact === 'downstream').length;

  const risks = destructiveChanges.map((change) => ({
    address: change.address,
    severity: isDataStore(change) ? ('high' as const) : ('medium' as const),
    summary: isDataStore(change)
      ? `${change.action === 'replace' ? 'Replacing' : 'Destroying'} this resource drops its data unless you migrate it first.`
      : `${change.action === 'replace' ? 'Replacing' : 'Destroying'} this resource interrupts everything that depends on it.`,
  }));

  const saferAlternatives = destructiveChanges.map((change) => ({
    address: change.address,
    suggestion:
      change.action === 'replace'
        ? 'Add create_before_destroy and migrate data to the new resource before the old one is removed.'
        : 'Remove the references to this resource first, then destroy it in a separate change.',
  }));

  const explanation =
    destructiveChanges.length === 0
      ? 'This plan has no replacements or destroys, so nothing downstream is put at risk.'
      : `This plan replaces or destroys ${destructiveChanges.length} resource${destructiveChanges.length === 1 ? '' : 's'}, which puts ${downstreamCount} downstream node${downstreamCount === 1 ? '' : 's'} at risk.`;

  return { explanation, risks, saferAlternatives, model: 'offline', generatedAt: new Date().toISOString() };
}

export function createOfflineBriefing(planChanges: PlanChange[]): Briefing {
  const destructiveCount = planChanges.filter(isDestructive).length;
  const updateCount = planChanges.filter((change) => change.impact === 'direct' && change.action === 'update').length;
  const downstreamCount = planChanges.filter((change) => change.impact === 'downstream').length;

  let recommendation: BriefingRecommendation = 'proceed';
  if (destructiveCount > 0 && downstreamCount > 0) recommendation = 'stop';
  else if (destructiveCount > 0 || updateCount > 0) recommendation = 'caution';

  const closingByRecommendation: Record<BriefingRecommendation, string> = {
    stop: "I'd stop here and check the migration plan before applying.",
    caution: 'Worth a second look before you apply.',
    proceed: 'Nothing depends on these changes. This looks safe to apply.',
  };
  const script =
    `This plan replaces or destroys ${destructiveCount} resource${destructiveCount === 1 ? '' : 's'} ` +
    `and modifies ${updateCount}. ${downstreamCount} downstream node${downstreamCount === 1 ? ' is' : 's are'} affected. ` +
    closingByRecommendation[recommendation];

  return { script, audioUrl: '', expiresAt: '', recommendation };
}

/** A keyword-matching stand-in for Gemini function calling: finds a named node and walks the graph. */
export function answerOffline(graph: Graph, question: string): AskResult {
  const lowerQuestion = question.toLowerCase();
  const mentionedNode = graph.nodes
    .filter((node) => [getNodeDisplayName(node), node.name, node.address].some((text) => lowerQuestion.includes(text.toLowerCase())))
    .sort((first, second) => second.address.length - first.address.length)[0];

  if (!mentionedNode) {
    return { answer: "I couldn't find a resource or file by that name in the graph.", citedNodeIds: [], toolCalls: [] };
  }

  const wantsDependencies = /\b(use|uses|depend on|depends on|rely|relies)\b/.test(lowerQuestion);
  const direction = wantsDependencies ? 'dependencies' : 'dependents';
  const reachedIds = [...blastRadius(graph, mentionedNode.id, direction).keys()];
  const names = reachedIds.map((id) => getNodeDisplayName(graph.nodes.find((node) => node.id === id)!));
  const subject = getNodeDisplayName(mentionedNode);

  const answer =
    names.length === 0
      ? `Nothing ${wantsDependencies ? 'is used by' : 'depends on'} ${subject}.`
      : `${subject} ${wantsDependencies ? 'uses' : 'is used by'} ${names.length}: ${names.join(', ')}.`;
  return { answer, citedNodeIds: reachedIds, toolCalls: [{ op: direction, node: mentionedNode.address }] };
}
