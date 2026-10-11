import { randomUUID } from 'node:crypto';
import type { NewEdge, NewNode } from '../../repositories/graph.js';
import {
  CONFIDENCE_BY_METHOD,
  type EdgeRelation,
  type LinkMethod,
  type NodeKind,
} from '../graph/types.js';

export interface NodeInput {
  kind: NodeKind;
  address: string;
  name: string;
  terraformType?: string | null;
  parentId?: string | null;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  attributes?: Record<string, unknown>;
}

/** Collects nodes and edges for one run, deduplicating by address / (source, target, relation, method). */
export class GraphBuilder {
  readonly nodes = new Map<string, NewNode>();
  private readonly edgeIndex = new Map<string, NewEdge>();

  get edges(): NewEdge[] {
    return [...this.edgeIndex.values()];
  }

  node(address: string): NewNode | undefined {
    return this.nodes.get(address);
  }

  nodeById(id: string): NewNode | undefined {
    for (const node of this.nodes.values()) if (node.id === id) return node;
    return undefined;
  }

  addNode(input: NodeInput): NewNode {
    const existing = this.nodes.get(input.address);
    if (existing) return existing;
    const node: NewNode = {
      id: randomUUID(),
      kind: input.kind,
      address: input.address,
      name: input.name,
      terraformType: input.terraformType ?? null,
      parentId: input.parentId ?? null,
      filePath: input.filePath ?? null,
      lineStart: input.lineStart ?? null,
      lineEnd: input.lineEnd ?? null,
      attributes: input.attributes ?? {},
    };
    this.nodes.set(input.address, node);
    return node;
  }

  /**
   * Adds an edge meaning "source depends on target". Re-adding the same
   * (source, target, relation, method) merges the evidence instead of duplicating the edge.
   */
  addEdge(
    source: NewNode,
    target: NewNode,
    relation: EdgeRelation,
    method: LinkMethod,
    evidence: Record<string, unknown> = {},
    explanation: string | null = null,
  ): NewEdge | null {
    if (source.id === target.id) return null;
    const key = `${source.id}|${target.id}|${relation}|${method}`;
    const existing = this.edgeIndex.get(key);
    if (existing) {
      existing.evidence = mergeEvidence(existing.evidence, evidence);
      return existing;
    }
    const edge: NewEdge = {
      id: randomUUID(),
      source: source.id,
      target: target.id,
      relation,
      linkMethod: method,
      confidence: CONFIDENCE_BY_METHOD[method],
      evidence,
      explanation,
    };
    this.edgeIndex.set(key, edge);
    return edge;
  }

  hasEdge(source: NewNode, target: NewNode): boolean {
    for (const edge of this.edgeIndex.values()) if (edge.source === source.id && edge.target === target.id) return true;
    return false;
  }
}

/** Arrays (operations, actions, locations) are unioned; other keys keep the first value. */
function mergeEvidence(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const current = merged[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      const seen = new Set(current.map((v) => JSON.stringify(v)));
      merged[key] = [...current, ...value.filter((v) => !seen.has(JSON.stringify(v)))];
    } else if (current === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}
