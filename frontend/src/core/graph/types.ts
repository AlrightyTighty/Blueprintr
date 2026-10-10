// Shared graph schema. Keep this file free of React so the backend can reuse it.

export type NodeType = 'code' | 'resource' | 'iam_role' | 'domain' | 'unresolved';

export type PlanAction = 'none' | 'modify' | 'replace' | 'destroy';

export type Confidence = 'certain' | 'high' | 'inferred';

export type EdgeKind = 'reads' | 'writes' | 'publishes' | 'references' | 'grants' | 'env';

export type FindingKind = 'permission_gap' | 'over_broad_iam' | 'unmanaged_resource';

export interface Finding {
  kind: FindingKind;
  message: string;
}

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  /** Terraform type for resources, e.g. aws_dynamodb_table. */
  resourceType?: string;
  plan: PlanAction;
  findings: Finding[];
}

export interface GraphEdge {
  id: string;
  /** Edges point from the dependent (consumer) to what it depends on. */
  source: string;
  target: string;
  kind: EdgeKind;
  confidence: Confidence;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
