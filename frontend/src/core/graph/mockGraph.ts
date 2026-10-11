import type { Finding, Graph, GraphEdge, GraphNode } from './types';

const MOCK_RUN_ID = 'demo-run';
const TERRAFORM_FILE = 'infra/main.tf';

interface TerraformBlock {
  id: string;
  terraformType: string;
  name: string;
  /** Shown on the graph instead of the Terraform name, e.g. a domain. */
  displayName?: string;
  body: string[];
}

// The demo repo's Terraform. Node line ranges are computed from this text so the code panel always
// shows the block a stop is talking about.
const terraformBlocks: TerraformBlock[] = [
  {
    id: 'domain.site',
    terraformType: 'aws_route53_record',
    name: 'site',
    displayName: 'app.example.com',
    body: [
      'zone_id = aws_route53_zone.main.zone_id',
      'name    = "app.example.com"',
      'type    = "A"',
      '',
      'alias {',
      '  name    = aws_cloudfront_distribution.site.domain_name',
      '  zone_id = aws_cloudfront_distribution.site.hosted_zone_id',
      '}',
    ],
  },
  {
    id: 'cdn',
    terraformType: 'aws_cloudfront_distribution',
    name: 'site',
    body: [
      'aliases = ["app.example.com"]',
      '',
      'origin {',
      '  origin_id   = "site"',
      '  domain_name = aws_s3_bucket.site.bucket_regional_domain_name',
      '}',
      '',
      'origin {',
      '  origin_id   = "api"',
      '  domain_name = aws_api_gateway_rest_api.api.id',
      '}',
    ],
  },
  {
    id: 'bucket.site',
    terraformType: 'aws_s3_bucket',
    name: 'site',
    body: ['bucket = "ripplemap-site-prod"'],
  },
  {
    id: 'api',
    terraformType: 'aws_api_gateway_rest_api',
    name: 'api',
    body: ['name = "orders-api"'],
  },
  {
    id: 'fn.orders',
    terraformType: 'aws_lambda_function',
    name: 'orders',
    body: [
      'function_name = "orders"',
      'role          = aws_iam_role.orders_role.arn',
      'handler       = "handler.handler"',
      'runtime       = "python3.12"',
      'filename      = "build/orders.zip"',
      '',
      'environment {',
      '  variables = {',
      '    TABLE_NAME = aws_dynamodb_table.orders.name',
      '    QUEUE_URL  = aws_sqs_queue.events.url',
      '  }',
      '}',
    ],
  },
  {
    id: 'fn.notify',
    terraformType: 'aws_lambda_function',
    name: 'notify',
    body: [
      'function_name = "notify"',
      'role          = aws_iam_role.orders_role.arn',
      'handler       = "handler.handler"',
      'runtime       = "nodejs20.x"',
      'filename      = "build/notify.zip"',
      '',
      'environment {',
      '  variables = {',
      '    QUEUE_URL = aws_sqs_queue.events.url',
      '  }',
      '}',
    ],
  },
  {
    id: 'table.orders',
    terraformType: 'aws_dynamodb_table',
    name: 'orders',
    body: [
      'name         = "orders"',
      'billing_mode = "PAY_PER_REQUEST"',
      'hash_key     = "id"',
      '',
      'attribute {',
      '  name = "id"',
      '  type = "S"',
      '}',
    ],
  },
  {
    id: 'queue.events',
    terraformType: 'aws_sqs_queue',
    name: 'events',
    body: ['name = "order-events"'],
  },
  {
    id: 'role.orders',
    terraformType: 'aws_iam_role',
    name: 'orders_role',
    body: [
      'name = "orders-role"',
      '',
      'inline_policy {',
      '  name = "access"',
      '  policy = jsonencode({',
      '    Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "s3:*"], Resource = "*" }]',
      '  })',
      '}',
    ],
  },
];

interface BuiltTerraform {
  text: string;
  rangeById: Map<string, { startLine: number; endLine: number }>;
}

function buildTerraform(blocks: TerraformBlock[]): BuiltTerraform {
  const lines: string[] = [];
  const rangeById = new Map<string, { startLine: number; endLine: number }>();
  for (const block of blocks) {
    const startLine = lines.length + 1;
    lines.push(`resource "${block.terraformType}" "${block.name}" {`);
    lines.push(...block.body.map((line) => (line ? `  ${line}` : '')));
    lines.push('}');
    rangeById.set(block.id, { startLine, endLine: lines.length });
    lines.push('');
  }
  return { text: lines.join('\n'), rangeById };
}

const terraform = buildTerraform(terraformBlocks);

const ordersHandler = [
  'import json',
  'import os',
  'import boto3',
  '',
  'dynamodb = boto3.resource("dynamodb")',
  'queue = boto3.client("sqs")',
  's3 = boto3.client("s3")',
  'TABLE = dynamodb.Table(os.environ["TABLE_NAME"])',
  '',
  'def handler(event, context):',
  '    order = json.loads(event["body"])',
  '    TABLE.put_item(Item=order)',
  '    queue.send_message(QueueUrl=os.environ["QUEUE_URL"], MessageBody=json.dumps(order))',
  '    s3.get_object(Bucket="legacy-uploads-bucket", Key=order["receipt"])',
  '    return {"statusCode": 201}',
];

const notifyHandler = [
  'import { SQSEvent } from "aws-lambda";',
  'import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";',
  '',
  'const db = new DynamoDBClient({});',
  '',
  'export const handler = async (event: SQSEvent) => {',
  '  for (const record of event.Records) {',
  '    const { id } = JSON.parse(record.body);',
  '    await db.send(new DeleteItemCommand({ TableName: tableName(), Key: { id: { S: id } } }));',
  '  }',
  '};',
];

/** The demo repo's files by path, so the tour can show real lines next to each stop. */
export const mockSourceFiles: Record<string, string> = {
  [TERRAFORM_FILE]: terraform.text,
  'src/orders/handler.py': ordersHandler.join('\n'),
  'src/notify/handler.ts': notifyHandler.join('\n'),
};

function createResourceNode(block: TerraformBlock): GraphNode {
  const range = terraform.rangeById.get(block.id)!;
  return {
    id: block.id,
    kind: 'resource',
    address: `${block.terraformType}.${block.name}`,
    name: block.displayName ?? block.name,
    terraformType: block.terraformType,
    filePath: TERRAFORM_FILE,
    lineStart: range.startLine,
    lineEnd: range.endLine,
  };
}

function createCodeNode(id: string, filePath: string, lineCount: number): GraphNode {
  return { id, kind: 'code_file', address: filePath, name: filePath, filePath, lineStart: 1, lineEnd: lineCount };
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
    ...terraformBlocks.map(createResourceNode),
    createCodeNode('code.orders', 'src/orders/handler.py', ordersHandler.length),
    createCodeNode('code.notify', 'src/notify/handler.ts', notifyHandler.length),
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
    createEdge('fn.notify', 'role.orders', 'assumes_role', 'declared_reference', 'certain'),
    createEdge('role.orders', 'table.orders', 'grants_access', 'declared_reference', 'certain'),
    createEdge('fn.orders', 'table.orders', 'references', 'env_var', 'high', {
      evidence: { envVar: 'TABLE_NAME', file: 'src/orders/handler.py', line: 8 },
    }),
    createEdge('fn.orders', 'queue.events', 'references', 'env_var', 'high', {
      evidence: { envVar: 'QUEUE_URL', file: 'src/orders/handler.py', line: 13 },
    }),
    createEdge('fn.notify', 'queue.events', 'references', 'env_var', 'high', {
      evidence: { envVar: 'QUEUE_URL' },
    }),
    createEdge('fn.notify', 'table.orders', 'references', 'declared_reference', 'certain'),
    createEdge('code.orders', 'fn.orders', 'runs_code', 'code_mapping', 'high'),
    createEdge('code.orders', 'table.orders', 'writes', 'env_var', 'high', {
      evidence: { envVar: 'TABLE_NAME', file: 'src/orders/handler.py', line: 12 },
    }),
    createEdge('code.notify', 'fn.notify', 'runs_code', 'code_mapping', 'high'),
    createEdge('code.notify', 'table.orders', 'writes', 'gemini_inference', 'inferred', {
      evidence: { file: 'src/notify/handler.ts', line: 9 },
      explanation: 'The table name is built from config, and the only table in this stack is orders.',
    }),
    createEdge('code.orders', 'bucket.hardcoded', 'reads', 'gemini_inference', 'inferred', {
      evidence: { file: 'src/orders/handler.py', line: 14 },
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
    'This role allows every S3 action, but the code only reads one bucket.',
    'role.orders',
  ),
  createFinding(
    'finding.gap',
    'permission_gap',
    'high',
    'Code calls an action the role does not allow',
    'The notify code calls dynamodb:DeleteItem, but its role does not allow it.',
    'code.notify',
  ),
  createFinding(
    'finding.drift',
    'unmanaged_resource',
    'medium',
    'Bucket is not managed by Terraform',
    'A bucket named legacy-uploads-bucket is hardcoded in code but missing from Terraform, so it can drift.',
    'bucket.hardcoded',
  ),
];
