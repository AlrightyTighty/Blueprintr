-- 009_endpoints: what endpoint tours need.
--   * 'calls': one function calls another (the caller depends on the callee), so a request can be
--     followed from a Lambda's handler into the functions it delegates to.
--   * catalog rows for the extra API Gateway REST and Lambda function URL resources endpoints come from.
-- ADD VALUE is allowed inside a transaction on PostgreSQL 12+; the new value is not used in this file.

ALTER TYPE edge_relation ADD VALUE IF NOT EXISTS 'calls';

INSERT INTO resource_types (terraform_type, service, display_name, category, icon_key, color, sort_order) VALUES
  ('aws_api_gateway_resource', 'API Gateway', 'REST API Resource', 'network', 'aws/api-gateway', '#8C4FFF', 67),
  ('aws_api_gateway_method',   'API Gateway', 'REST API Method',   'network', 'aws/api-gateway', '#8C4FFF', 68),
  ('aws_lambda_function_url',  'Lambda',      'Lambda Function URL', 'compute', 'aws/lambda',     '#ED7100', 13)
ON CONFLICT (terraform_type) DO NOTHING;
