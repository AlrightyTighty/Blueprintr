// Trimmed `terraform show -json` output for the demo repo: replaces the orders table (the planted
// "this will hurt" change) and modifies the worker function.
export const SAMPLE_PLAN_JSON = JSON.stringify(
  {
    format_version: '1.2',
    resource_changes: [
      { address: 'aws_dynamodb_table.orders', type: 'aws_dynamodb_table', change: { actions: ['delete', 'create'] } },
      { address: 'aws_lambda_function.worker', type: 'aws_lambda_function', change: { actions: ['update'] } },
      { address: 'aws_s3_bucket.site', type: 'aws_s3_bucket', change: { actions: ['no-op'] } },
    ],
  },
  null,
  2,
);
