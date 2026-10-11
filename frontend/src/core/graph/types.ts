// Mirrors the backend API schema in backend/openapi.yaml. Keep this file free of React.
// If the spec changes, change it here first; the rest of the frontend builds on these types.

export type NodeKind =
  | 'resource'
  | 'code_file'
  | 'code_function'
  | 'unmanaged_resource'
  | 'unresolved_ref';

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
  | 'routes_to';

export type LinkMethod = 'declared_reference' | 'env_var' | 'code_mapping' | 'gemini_inference';

/** Ordered most to least certain. */
export type Confidence = 'certain' | 'high' | 'inferred';

export type FindingKind =
  | 'permission_gap'
  | 'over_broad_iam'
  | 'unmanaged_resource'
  | 'unresolved_reference';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export type PlanAction = 'create' | 'update' | 'replace' | 'destroy' | 'noop';

/** `direct` nodes are changed by the plan (red); `downstream` nodes are affected through the graph (amber). */
export type PlanImpact = 'direct' | 'downstream';

export interface ResourceType {
  terraformType: string;
  provider: string;
  service: string;
  displayName: string;
  category: string;
  /** Names an SVG bundled with the frontend. */
  iconKey: string;
  color: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  /** Terraform address (`aws_dynamodb_table.orders`) or code location (`src/api.py::get_order`). */
  address: string;
  name: string;
  terraformType?: string | null;
  /** Null for code nodes and types outside the catalog (use a generic icon). */
  resourceType?: ResourceType | null;
  parentId?: string | null;
  filePath?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  /** Non-secret configuration only. */
  attributes?: Record<string, unknown>;
}

/**
 * Convention used by the blast-radius code: an edge points from the dependent to what it depends on
 * (code -> table). `dependents` therefore walks edges backwards from a node.
 * The spec doesn't pin this down; confirm with the backend.
 */
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: EdgeRelation;
  linkMethod: LinkMethod;
  confidence: Confidence;
  /** Proof for the link, e.g. `{ envVar: 'TABLE_NAME', file: 'src/api.py', line: 12 }`. */
  evidence?: Record<string, unknown>;
  /** Gemini's reasoning; present on `gemini_inference` edges. */
  explanation?: string | null;
}

export interface Graph {
  runId: string;
  commitSha?: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Finding {
  id: string;
  runId: string;
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  detail?: string | null;
  nodeId?: string | null;
  relatedNodeId?: string | null;
  evidence?: Record<string, unknown>;
  fingerprint: string;
  dismissedAt?: string | null;
}

export interface PlanChange {
  id: string;
  /** Null if the resource is not in the graph. */
  nodeId: string | null;
  address: string;
  terraformType?: string | null;
  /** Raw Terraform actions, e.g. `["delete", "create"]`. */
  actions: string[];
  action: PlanAction;
  impact: PlanImpact;
  /** Hops from the nearest changed node (0 for direct). */
  distance: number;
  /** Attribute names only, never values. */
  changedAttributes: string[];
}
