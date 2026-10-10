import type { Graph, GraphEdge, GraphNode } from './types';

function createNode(
  id: string,
  type: GraphNode['type'],
  label: string,
  overrides: Partial<GraphNode> = {},
): GraphNode {
  return { id, type, label, plan: 'none', findings: [], ...overrides };
}

function createEdge(
  source: string,
  target: string,
  kind: GraphEdge['kind'],
  confidence: GraphEdge['confidence'],
): GraphEdge {
  return { id: `${source}->${target}`, source, target, kind, confidence };
}

// Mirrors the planned demo repo, including its planted traps.
export const mockGraph: Graph = {
  nodes: [
    createNode('domain.site', 'domain', 'app.example.com', { resourceType: 'aws_route53_record' }),
    createNode('cdn', 'resource', 'aws_cloudfront_distribution.site', {
      resourceType: 'aws_cloudfront_distribution',
    }),
    createNode('bucket.site', 'resource', 'aws_s3_bucket.site', { resourceType: 'aws_s3_bucket' }),
    createNode('api', 'resource', 'aws_api_gateway_rest_api.api', {
      resourceType: 'aws_api_gateway_rest_api',
    }),
    createNode('fn.orders', 'resource', 'aws_lambda_function.orders', {
      resourceType: 'aws_lambda_function',
    }),
    createNode('fn.notify', 'resource', 'aws_lambda_function.notify', {
      resourceType: 'aws_lambda_function',
    }),
    createNode('table.orders', 'resource', 'aws_dynamodb_table.orders', {
      resourceType: 'aws_dynamodb_table',
    }),
    createNode('queue.events', 'resource', 'aws_sqs_queue.events', { resourceType: 'aws_sqs_queue' }),
    createNode('role.orders', 'iam_role', 'aws_iam_role.orders_role', {
      resourceType: 'aws_iam_role',
      findings: [{ kind: 'over_broad_iam', message: 'Allows s3:* but code only reads one bucket.' }],
    }),
    createNode('code.orders', 'code', 'src/orders/handler.py'),
    createNode('code.notify', 'code', 'src/notify/handler.ts', {
      findings: [
        { kind: 'permission_gap', message: 'Calls dynamodb:DeleteItem; role does not allow it.' },
      ],
    }),
    createNode('bucket.hardcoded', 'unresolved', 'legacy-uploads-bucket', {
      findings: [{ kind: 'unmanaged_resource', message: 'Hardcoded in code, not in Terraform.' }],
    }),
  ],
  edges: [
    createEdge('domain.site', 'cdn', 'references', 'certain'),
    createEdge('cdn', 'bucket.site', 'references', 'certain'),
    createEdge('cdn', 'api', 'references', 'certain'),
    createEdge('api', 'fn.orders', 'references', 'certain'),
    createEdge('fn.orders', 'role.orders', 'references', 'certain'),
    createEdge('fn.orders', 'table.orders', 'env', 'high'),
    createEdge('fn.orders', 'queue.events', 'env', 'high'),
    createEdge('fn.notify', 'queue.events', 'env', 'high'),
    createEdge('fn.notify', 'table.orders', 'references', 'certain'),
    createEdge('code.orders', 'fn.orders', 'references', 'high'),
    createEdge('code.orders', 'table.orders', 'writes', 'high'),
    createEdge('code.notify', 'fn.notify', 'references', 'high'),
    createEdge('code.notify', 'table.orders', 'writes', 'inferred'),
    createEdge('code.orders', 'bucket.hardcoded', 'reads', 'inferred'),
  ],
};
