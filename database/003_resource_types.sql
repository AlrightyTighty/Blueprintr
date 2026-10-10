-- 003_resource_types: catalog of Terraform resource types with display metadata.
-- AWS only for now; other providers are just more rows (terraform types are provider-prefixed).
-- icon_key maps to an SVG bundled with the frontend (e.g. "aws/lambda"); no binaries in the DB.

CREATE TYPE resource_category AS ENUM (
  'compute', 'storage', 'database', 'messaging', 'security', 'network', 'edge', 'dns'
);

CREATE TABLE resource_types (
  terraform_type text              PRIMARY KEY, -- e.g. aws_lambda_function
  provider       text              NOT NULL DEFAULT 'aws',
  service        text              NOT NULL,    -- e.g. Lambda
  display_name   text              NOT NULL,    -- e.g. Lambda Function
  category       resource_category NOT NULL,
  icon_key       text              NOT NULL,
  color          text              NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
  sort_order     integer           NOT NULL DEFAULT 0
);

-- Colours follow the AWS architecture-icon category palette.
INSERT INTO resource_types (terraform_type, service, display_name, category, icon_key, color, sort_order) VALUES
  ('aws_lambda_function',             'Lambda',      'Lambda Function',          'compute',   'aws/lambda',         '#ED7100', 10),
  ('aws_lambda_event_source_mapping', 'Lambda',      'Lambda Event Source',      'compute',   'aws/lambda',         '#ED7100', 11),
  ('aws_lambda_permission',           'Lambda',      'Lambda Permission',        'security',  'aws/lambda',         '#DD344C', 12),
  ('aws_s3_bucket',                   'S3',          'S3 Bucket',                'storage',   'aws/s3',             '#7AA116', 20),
  ('aws_s3_bucket_policy',            'S3',          'S3 Bucket Policy',         'security',  'aws/s3',             '#DD344C', 21),
  ('aws_dynamodb_table',              'DynamoDB',    'DynamoDB Table',           'database',  'aws/dynamodb',       '#C925D1', 30),
  ('aws_sqs_queue',                   'SQS',         'SQS Queue',                'messaging', 'aws/sqs',            '#E7157B', 40),
  ('aws_sqs_queue_policy',            'SQS',         'SQS Queue Policy',         'security',  'aws/sqs',            '#DD344C', 41),
  ('aws_iam_role',                    'IAM',         'IAM Role',                 'security',  'aws/iam-role',       '#DD344C', 50),
  ('aws_iam_policy',                  'IAM',         'IAM Policy',               'security',  'aws/iam-policy',     '#DD344C', 51),
  ('aws_iam_role_policy',             'IAM',         'IAM Inline Role Policy',   'security',  'aws/iam-policy',     '#DD344C', 52),
  ('aws_iam_role_policy_attachment',  'IAM',         'IAM Policy Attachment',    'security',  'aws/iam-policy',     '#DD344C', 53),
  ('aws_apigatewayv2_api',            'API Gateway', 'HTTP/WebSocket API',       'network',   'aws/api-gateway',    '#8C4FFF', 60),
  ('aws_apigatewayv2_route',          'API Gateway', 'API Route',                'network',   'aws/api-gateway',    '#8C4FFF', 61),
  ('aws_apigatewayv2_integration',    'API Gateway', 'API Integration',          'network',   'aws/api-gateway',    '#8C4FFF', 62),
  ('aws_apigatewayv2_stage',          'API Gateway', 'API Stage',                'network',   'aws/api-gateway',    '#8C4FFF', 63),
  ('aws_api_gateway_rest_api',        'API Gateway', 'REST API',                 'network',   'aws/api-gateway',    '#8C4FFF', 64),
  ('aws_api_gateway_integration',     'API Gateway', 'REST API Integration',     'network',   'aws/api-gateway',    '#8C4FFF', 65),
  ('aws_api_gateway_stage',           'API Gateway', 'REST API Stage',           'network',   'aws/api-gateway',    '#8C4FFF', 66),
  ('aws_cloudfront_distribution',     'CloudFront',  'CloudFront Distribution',  'edge',      'aws/cloudfront',     '#8C4FFF', 70),
  ('aws_route53_zone',                'Route 53',    'Hosted Zone',              'dns',       'aws/route53',        '#8C4FFF', 80),
  ('aws_route53_record',              'Route 53',    'DNS Record',               'dns',       'aws/route53',        '#8C4FFF', 81);
