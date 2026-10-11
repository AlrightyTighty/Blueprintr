/**
 * CloudFormation resource types mapped to the Terraform-style type names the rest of Blueprint uses
 * (the resource catalog, icons, linker and IAM analysis are all keyed by them). Anything not listed
 * falls back to `aws_<service>_<resource>`, which is how Terraform names most AWS resources anyway.
 */
const KNOWN: Record<string, string> = {
  'AWS::Lambda::Function': 'aws_lambda_function',
  'AWS::Lambda::EventSourceMapping': 'aws_lambda_event_source_mapping',
  'AWS::Lambda::Permission': 'aws_lambda_permission',
  'AWS::S3::Bucket': 'aws_s3_bucket',
  'AWS::S3::BucketPolicy': 'aws_s3_bucket_policy',
  'AWS::DynamoDB::Table': 'aws_dynamodb_table',
  'AWS::SQS::Queue': 'aws_sqs_queue',
  'AWS::SQS::QueuePolicy': 'aws_sqs_queue_policy',
  'AWS::SNS::Topic': 'aws_sns_topic',
  'AWS::IAM::Role': 'aws_iam_role',
  'AWS::IAM::ManagedPolicy': 'aws_iam_policy',
  // CloudFormation's "AWS::IAM::Policy" is an inline policy attached to roles, i.e. aws_iam_role_policy.
  'AWS::IAM::Policy': 'aws_iam_role_policy',
  'AWS::ApiGatewayV2::Api': 'aws_apigatewayv2_api',
  'AWS::ApiGatewayV2::Route': 'aws_apigatewayv2_route',
  'AWS::ApiGatewayV2::Integration': 'aws_apigatewayv2_integration',
  'AWS::ApiGatewayV2::Stage': 'aws_apigatewayv2_stage',
  'AWS::ApiGateway::RestApi': 'aws_api_gateway_rest_api',
  'AWS::ApiGateway::Method': 'aws_api_gateway_integration',
  'AWS::ApiGateway::Stage': 'aws_api_gateway_stage',
  'AWS::CloudFront::Distribution': 'aws_cloudfront_distribution',
  'AWS::Route53::HostedZone': 'aws_route53_zone',
  'AWS::Route53::RecordSet': 'aws_route53_record',
};

/** Resources that are CDK/CloudFormation plumbing and say nothing about the application. */
const IGNORED = new Set(['AWS::CDK::Metadata']);

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/^_+|_+$/g, '');

export const isIgnoredType = (cfnType: string): boolean => IGNORED.has(cfnType);

/** `AWS::SQS::Queue` -> `aws_sqs_queue`; `Custom::Thing` -> `custom_thing`. */
export function terraformTypeFor(cfnType: string): string {
  const known = KNOWN[cfnType];
  if (known) return known;
  const parts = cfnType.split('::');
  return parts.map(snake).join('_');
}

export { snake as snakeCase };
