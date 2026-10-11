import type { ResourceTypeRow } from '../../repositories/resourceTypes.js';

export type NodeKind = 'resource' | 'code_file' | 'code_function' | 'unmanaged_resource' | 'unresolved_ref';

export type EdgeRelation =
  | 'references'
  | 'depends_on'
  | 'assumes_role'
  | 'grants_access'
  | 'runs_code'
  | 'reads'
  | 'writes'
  | 'publishes'
  | 'invokes'
  | 'routes_to'
  /** One function calls another (the caller depends on the callee). */
  | 'calls';

export type LinkMethod = 'declared_reference' | 'env_var' | 'code_mapping' | 'gemini_inference';
export type Confidence = 'certain' | 'high' | 'inferred';

/** Confidence is fixed by the link method (the database enforces the same pairing). */
export const CONFIDENCE_BY_METHOD: Record<LinkMethod, Confidence> = {
  declared_reference: 'certain',
  env_var: 'high',
  code_mapping: 'high',
  gemini_inference: 'inferred',
};

export const CONFIDENCE_ORDER: Confidence[] = ['certain', 'high', 'inferred'];

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Terraform address (`aws_dynamodb_table.orders`) or `path::function` for code. */
  address: string;
  name: string;
  terraformType: string | null;
  resourceType: ResourceTypeRow | null;
  parentId: string | null;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  attributes: Record<string, unknown>;
}

/** An edge means: `source` depends on `target` (a function reads a table; a Lambda assumes a role). */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: EdgeRelation;
  linkMethod: LinkMethod;
  confidence: Confidence;
  evidence: Record<string, unknown>;
  explanation: string | null;
}

export interface Graph {
  runId: string;
  commitSha: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
