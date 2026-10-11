// Offline tour scripts, written from the graph alone. They only ever mention nodes that exist and
// say plainly when a link is inferred. A Gemini-written script can replace these later; the Stop
// shape stays the same.
import { getFriendlyTypeName, getNodeCategory, getResourceRole } from '../graph/nodeDisplay';
import type { EdgeRelation, GraphEdge, GraphNode } from '../graph/types';

/** How a node is named out loud: "the DynamoDB table orders", or a file's own name for code. */
export function speakableName(node: GraphNode): string {
  if (getNodeCategory(node) === 'code') return `the file ${node.filePath ?? node.name}`;
  if (getNodeCategory(node) === 'unmanaged') return `the bucket ${node.name}`;
  if (getNodeCategory(node) === 'unresolved') return `an unresolved reference called ${node.name}`;
  return `the ${getFriendlyTypeName(node)} ${node.name}`;
}

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ARRIVAL_PHRASES: Record<EdgeRelation, string> = {
  references: 'points to',
  depends_on: 'depends on',
  assumes_role: 'assumes',
  grants_access: 'grants access to',
  runs_code: 'runs',
  reads: 'reads from',
  writes: 'writes to',
  publishes: 'publishes to',
  invokes: 'invokes',
  routes_to: 'routes traffic to',
};

export function relationPhrase(relation: EdgeRelation): string {
  return ARRIVAL_PHRASES[relation];
}

const ROLE_DESCRIPTIONS: Record<ReturnType<typeof getResourceRole>, string> = {
  domain: 'This is the front door: the address your users actually type.',
  cdn: 'It sits in front of everything and decides where each request goes.',
  api: 'It receives requests and hands each matching route to a function.',
  function: 'This is where your code runs.',
  bucket: 'It stores files.',
  table: "It keeps the application's data.",
  queue: "It passes messages between parts of the system, so one side doesn't have to wait for the other.",
  role: 'It decides what its owner is allowed to do.',
  other: '',
};

export function describeRole(node: GraphNode): string {
  return ROLE_DESCRIPTIONS[getResourceRole(node)];
}

/** Joins sentences, skipping empty ones. */
export function sentences(...parts: (string | false | null | undefined)[]): string {
  return parts.filter((part): part is string => Boolean(part)).join(' ');
}

/** Says plainly which part is inferred, so the guide never sounds surer than the graph is. */
export function inferredNote(source: 'arrival' | 'code', codeNames: string[] = []): string {
  return source === 'arrival'
    ? 'One honest note: the link into this stop is inferred, not proven by the Terraform.'
    : `One honest note: the link from ${listOut(codeNames)} is inferred from reading the code, not proven.`;
}

export function warningSentence(warning: string): string {
  return `Watch your step: ${warning}`;
}

export interface ArrivalContext {
  previous: GraphNode;
  edge: GraphEdge;
}

export function arrivalSentence(node: GraphNode, arrival: ArrivalContext | null): string {
  if (!arrival) return `We start at ${speakableName(node)}.`;
  return `${capitalise(speakableName(arrival.previous))} ${relationPhrase(arrival.edge.relation)} ${speakableName(node)}.`;
}

/** Joins "a", "a and b", "a, b and c". */
export function listOut(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
