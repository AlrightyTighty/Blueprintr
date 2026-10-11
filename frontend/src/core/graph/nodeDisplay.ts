import type { GraphNode } from './types';

/** How the UI groups nodes. The API has no IAM or domain kind, so those come from `terraformType`. */
export type NodeCategory = 'code' | 'iam_role' | 'domain' | 'resource' | 'unmanaged' | 'unresolved';

const IAM_TERRAFORM_TYPES = new Set(['aws_iam_role', 'aws_iam_policy', 'aws_iam_role_policy']);
const DOMAIN_TERRAFORM_TYPES = new Set(['aws_route53_record', 'aws_route53_zone']);

export function getNodeCategory(node: GraphNode): NodeCategory {
  switch (node.kind) {
    case 'code_file':
    case 'code_function':
      return 'code';
    case 'unmanaged_resource':
      return 'unmanaged';
    case 'unresolved_ref':
      return 'unresolved';
    case 'resource':
      if (node.terraformType && IAM_TERRAFORM_TYPES.has(node.terraformType)) return 'iam_role';
      if (node.terraformType && DOMAIN_TERRAFORM_TYPES.has(node.terraformType)) return 'domain';
      return 'resource';
  }
}

export const CATEGORY_LABELS: Record<NodeCategory, string> = {
  code: 'code',
  iam_role: 'IAM',
  domain: 'domain',
  resource: 'resource',
  unmanaged: 'unmanaged resource',
  unresolved: 'unresolved reference',
};

/** The text shown on a node in the graph. */
export function getNodeDisplayName(node: GraphNode): string {
  const category = getNodeCategory(node);
  if (category === 'code') return node.filePath ?? node.name;
  if (category === 'resource' || category === 'iam_role') return node.address;
  return node.name;
}
