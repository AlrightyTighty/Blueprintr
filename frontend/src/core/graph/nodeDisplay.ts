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

/** The kind of AWS thing a resource is, for choosing how to describe it. */
export type ResourceRole = 'domain' | 'cdn' | 'api' | 'function' | 'bucket' | 'table' | 'queue' | 'role' | 'other';

const ROLE_BY_TERRAFORM_TYPE: Record<string, ResourceRole> = {
  aws_route53_record: 'domain',
  aws_route53_zone: 'domain',
  aws_cloudfront_distribution: 'cdn',
  aws_api_gateway_rest_api: 'api',
  aws_apigatewayv2_api: 'api',
  aws_lambda_function: 'function',
  aws_s3_bucket: 'bucket',
  aws_dynamodb_table: 'table',
  aws_sqs_queue: 'queue',
  aws_iam_role: 'role',
  aws_iam_policy: 'role',
  aws_iam_role_policy: 'role',
};

export function getResourceRole(node: GraphNode): ResourceRole {
  return (node.terraformType && ROLE_BY_TERRAFORM_TYPE[node.terraformType]) || 'other';
}

const FRIENDLY_NAMES: Record<ResourceRole, string> = {
  domain: 'DNS record',
  cdn: 'CloudFront distribution',
  api: 'API Gateway',
  function: 'Lambda function',
  bucket: 'S3 bucket',
  table: 'DynamoDB table',
  queue: 'SQS queue',
  role: 'IAM role',
  other: 'resource',
};

/** e.g. "DynamoDB table". Falls back to the catalog's display name for types we don't special-case. */
export function getFriendlyTypeName(node: GraphNode): string {
  const role = getResourceRole(node);
  if (role === 'other') return node.resourceType?.displayName ?? FRIENDLY_NAMES.other;
  return FRIENDLY_NAMES[role];
}
