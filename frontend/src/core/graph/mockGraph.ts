import type { Finding, Graph, GraphEdge, GraphNode } from './types';

const MOCK_RUN_ID = 'demo-run';

function createResourceNode(id: string, terraformType: string, name: string, displayName = name): GraphNode {
  return { id, kind: 'resource', address: `${terraformType}.${name}`, name: displayName, terraformType };
}

function createCodeNode(id: string, filePath: string): GraphNode {
  return { id, kind: 'code_file', address: filePath, name: filePath, filePath };
}

function createEdge(
  source: string,
  target: string,
  relation: GraphEdge['relation'],
  linkMethod: GraphEdge['linkMethod'],
  confidence: GraphEdge['confidence'],
  extras: Partial<GraphEdge> = {},
): GraphEdge {
  return { id: `${source}->${target}`, source, target, relation, linkMethod, confidence, ...extras };
}

function createFinding(
  id: string,
  kind: Finding['kind'],
  severity: Finding['severity'],
  title: string,
  detail: string,
  nodeId: string,
): Finding {
  return { id, runId: MOCK_RUN_ID, kind, severity, title, detail, nodeId, fingerprint: id };
}

// Mirrors the planned demo repo, including its planted traps.
export const mockGraph: Graph = {
  runId: MOCK_RUN_ID,
  nodes: [
    createResourceNode('domain.site', 'aws_route53_record', 'site', 'app.example.com'),
    createResourceNode('cdn', 'aws_cloudfront_distribution', 'site'),
    createResourceNode('bucket.site', 'aws_s3_bucket', 'site'),
    createResourceNode('api', 'aws_api_gateway_rest_api', 'api'),
    createResourceNode('fn.orders', 'aws_lambda_function', 'orders'),
    createResourceNode('fn.notify', 'aws_lambda_function', 'notify'),
    createResourceNode('table.orders', 'aws_dynamodb_table', 'orders'),
    createResourceNode('queue.events', 'aws_sqs_queue', 'events'),
    createResourceNode('role.orders', 'aws_iam_role', 'orders_role'),
    createCodeNode('code.orders', 'src/orders/handler.py'),
    createCodeNode('code.notify', 'src/notify/handler.ts'),
    {
      id: 'bucket.hardcoded',
      kind: 'unmanaged_resource',
      address: 'legacy-uploads-bucket',
      name: 'legacy-uploads-bucket',
    },
  ],
  edges: [
    createEdge('domain.site', 'cdn', 'references', 'declared_reference', 'certain'),
    createEdge('cdn', 'bucket.site', 'routes_to', 'declared_reference', 'certain'),
    createEdge('cdn', 'api', 'routes_to', 'declared_reference', 'certain'),
    createEdge('api', 'fn.orders', 'invokes', 'declared_reference', 'certain'),
    createEdge('fn.orders', 'role.orders', 'assumes_role', 'declared_reference', 'certain'),
    createEdge('role.orders', 'table.orders', 'grants_access', 'declared_reference', 'certain'),
    createEdge('fn.orders', 'table.orders', 'references', 'env_var', 'high', {
      evidence: { envVar: 'TABLE_NAME', file: 'src/orders/handler.py', line: 12 },
    }),
    createEdge('fn.orders', 'queue.events', 'references', 'env_var', 'high', {
      evidence: { envVar: 'QUEUE_URL', file: 'src/orders/handler.py', line: 14 },
    }),
    createEdge('fn.notify', 'queue.events', 'references', 'env_var', 'high', {
      evidence: { envVar: 'QUEUE_URL', file: 'src/notify/handler.ts', line: 6 },
    }),
    createEdge('fn.notify', 'table.orders', 'references', 'declared_reference', 'certain'),
    createEdge('code.orders', 'fn.orders', 'runs_code', 'code_mapping', 'high'),
    createEdge('code.orders', 'table.orders', 'writes', 'env_var', 'high', {
      evidence: { envVar: 'TABLE_NAME', file: 'src/orders/handler.py', line: 12 },
    }),
    createEdge('code.notify', 'fn.notify', 'runs_code', 'code_mapping', 'high'),
    createEdge('code.notify', 'table.orders', 'writes', 'gemini_inference', 'inferred', {
      explanation: 'The table name is built from config, and the only table in this stack is orders.',
    }),
    createEdge('code.orders', 'bucket.hardcoded', 'reads', 'gemini_inference', 'inferred', {
      explanation: 'The bucket name is a string literal that matches no Terraform resource.',
    }),
  ],
};

export const mockFindings: Finding[] = [
  createFinding(
    'finding.iam',
    'over_broad_iam',
    'medium',
    'Role allows more than the code uses',
    'Allows s3:* but the code only reads one bucket.',
    'role.orders',
  ),
  createFinding(
    'finding.gap',
    'permission_gap',
    'high',
    'Code calls an action the role does not allow',
    'Calls dynamodb:DeleteItem; the role does not allow it.',
    'code.notify',
  ),
  createFinding(
    'finding.drift',
    'unmanaged_resource',
    'medium',
    'Bucket is not managed by Terraform',
    'Hardcoded in code but missing from Terraform, so it can drift.',
    'bucket.hardcoded',
  ),
];
