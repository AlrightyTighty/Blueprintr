import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis/pipeline.js';
import { addCloudFormationTemplates } from '../src/core/cloudformation/index.js';
import { parseCfnTemplate } from '../src/core/cloudformation/template.js';
import { terraformTypeFor } from '../src/core/cloudformation/types.js';
import { parseTerraform, type TfModel } from '../src/core/terraform/model.js';
import { loadFixture } from './helpers.js';

async function modelFrom(files: { path: string; content: string }[]): Promise<TfModel> {
  const model = await parseTerraform(files);
  addCloudFormationTemplates(model, files);
  return model;
}

describe('CloudFormation templates', () => {
  it('reads YAML short-form tags as their long form, with line numbers', () => {
    const result = parseCfnTemplate(
      't.yaml',
      `Resources:
  Role:
    Type: AWS::IAM::Role
  Fn:
    Type: AWS::Lambda::Function
    Properties:
      Role: !GetAtt Role.Arn
      Name: !Sub
        - "x-\${A}"
        - A: !Ref Role
      Items: !Join ["", ["a", !Ref Role]]
      Cond: !If [C, !Ref Role, !Ref "AWS::NoValue"]
`,
    );
    if (result?.kind !== 'template') throw new Error('not a template');
    const fn = result.template.resources.find((r) => r.logicalId === 'Fn')!;
    expect(fn.line).toBe(4);
    expect(fn.properties['Role']).toEqual({ 'Fn::GetAtt': ['Role', 'Arn'] });
    expect(fn.properties['Name']).toEqual({ 'Fn::Sub': ['x-${A}', { A: { Ref: 'Role' } }] });
    expect(fn.properties['Items']).toEqual({ 'Fn::Join': ['', ['a', { Ref: 'Role' }]] });
    expect(fn.properties['Cond']).toEqual({ 'Fn::If': ['C', { Ref: 'Role' }, { Ref: 'AWS::NoValue' }] });
  });

  it('reads JSON templates the same way', () => {
    const result = parseCfnTemplate('t.json', '{"Resources":{"Q":{"Type":"AWS::SQS::Queue","Properties":{"QueueName":"q"}}}}');
    expect(result?.kind === 'template' && result.template.resources[0]).toMatchObject({ logicalId: 'Q', type: 'AWS::SQS::Queue', line: 1 });
  });

  it('ignores files that are not templates', () => {
    expect(parseCfnTemplate('package.json', '{"name":"x","scripts":{"deploy":"cdk deploy"}}')).toBeNull();
    expect(parseCfnTemplate('workflow.yml', 'name: ci\non: push\n# deploys AWS::Something and Resources\njobs: {}\n')).toBeNull();
    expect(parseCfnTemplate('openapi.yaml', 'openapi: 3.1.0\npaths: {}\ndescription: Resources for AWS::Lambda users\n')).toBeNull();
  });

  it('reports a broken template instead of silently skipping it', () => {
    const result = parseCfnTemplate('bad.yaml', "AWSTemplateFormatVersion: '2010-09-09'\nResources:\n  A: [unclosed\n");
    expect(result?.kind).toBe('error');
  });

  it('refuses alias bombs instead of expanding them', () => {
    const lines = ['a: &a [x, x, x, x, x, x, x, x, x]'];
    for (let i = 0; i < 9; i++) lines.push(`${String.fromCharCode(98 + i)}: &${String.fromCharCode(98 + i)} [${Array(9).fill(`*${String.fromCharCode(97 + i)}`).join(', ')}]`);
    const result = parseCfnTemplate('bomb.yaml', `AWSTemplateFormatVersion: x\nResources: {}\n${lines.join('\n')}\n`);
    expect(result?.kind).toBe('error');
  });

  it('maps CloudFormation types to the names the catalog uses', () => {
    expect(terraformTypeFor('AWS::DynamoDB::Table')).toBe('aws_dynamodb_table');
    expect(terraformTypeFor('AWS::IAM::Policy')).toBe('aws_iam_role_policy');
    expect(terraformTypeFor('AWS::KMS::Key')).toBe('aws_kms_key');
    expect(terraformTypeFor('AWS::ElasticLoadBalancingV2::LoadBalancer')).toBe('aws_elastic_load_balancing_v2_load_balancer');
    expect(terraformTypeFor('Custom::CDKBucketDeployment')).toBe('custom_cdk_bucket_deployment');
  });

  it('rewrites intrinsic functions into references the linker understands', async () => {
    const model = await modelFrom([
      {
        path: 'infra/t.json',
        content: JSON.stringify({
          Parameters: { Env: { Type: 'String', Default: 'prod' }, NoDefault: { Type: 'String' } },
          Mappings: { Sizes: { prod: { Memory: '512' } } },
          Resources: {
            Table: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: { 'Fn::Sub': 'orders-${Env}' } } },
            Fn: {
              Type: 'AWS::Lambda::Function',
              Properties: {
                Environment: {
                  Variables: {
                    A: { Ref: 'Table' },
                    B: { 'Fn::GetAtt': ['Table', 'Arn'] },
                    C: { 'Fn::Sub': ['${Table.Arn}/${Suffix}', { Suffix: 'x' }] },
                    D: { 'Fn::Join': ['-', ['a', { Ref: 'Env' }]] },
                    E: { 'Fn::FindInMap': ['Sizes', { Ref: 'Env' }, 'Memory'] },
                    F: { Ref: 'NoDefault' },
                    G: { 'Fn::GetAZs': '' },
                    H: { Ref: 'AWS::Region' },
                  },
                },
              },
            },
          },
        }),
      },
    ]);
    const table = model.resources.find((r) => r.address === 'aws_dynamodb_table.Table')!;
    expect(table.body['name']).toBe('orders-prod');
    const fn = model.resources.find((r) => r.type === 'aws_lambda_function')!;
    expect(fn.body['environment'][0].variables).toEqual({
      A: '${aws_dynamodb_table.Table.name}',
      B: '${aws_dynamodb_table.Table.arn}',
      C: '${aws_dynamodb_table.Table.arn}/x',
      D: 'a-prod',
      E: '512',
      F: '${var.NoDefault}',
      G: '${unresolved.GetAZs}',
      H: '${pseudo.Region}',
    });
  });
});

describe('hand-written CloudFormation repo', async () => {
  const out = await analyze({ files: loadFixture('cfn') });
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  const edges = out.edges.map((e) => ({ from: byId.get(e.source)!.address, to: byId.get(e.target)!.address, relation: e.relation, method: e.linkMethod }));
  const has = (from: string, to: string, relation: string, method?: string) =>
    edges.some((e) => e.from === from && e.to === to && e.relation === relation && (!method || e.method === method));

  it('builds resource nodes from the template, with line numbers and where they came from', () => {
    const table = out.nodes.find((n) => n.address === 'aws_dynamodb_table.OrdersTable')!;
    expect(table).toMatchObject({ kind: 'resource', terraformType: 'aws_dynamodb_table', filePath: 'infra/template.yaml' });
    expect(table.lineStart).toBe(13);
    expect(table.attributes).toMatchObject({ iac: 'cloudformation', cfnType: 'AWS::DynamoDB::Table', logicalId: 'OrdersTable', name: 'orders-prod' });
    expect(out.stats.cloudFormationTemplates).toBe(1);
  });

  it('links declared references with certain confidence', () => {
    expect(has('aws_lambda_function.ApiFunction', 'aws_iam_role.ApiRole', 'assumes_role', 'declared_reference')).toBe(true);
    expect(has('aws_apigatewayv2_integration.ApiIntegration', 'aws_lambda_function.ApiFunction', 'invokes')).toBe(true);
    expect(has('aws_lambda_event_source_mapping.JobsMapping', 'aws_lambda_function.WorkerFunction', 'invokes')).toBe(true);
    expect(has('aws_route53_record.SiteRecord', 'aws_cloudfront_distribution.Distribution', 'routes_to')).toBe(true);
    expect(has('aws_cloudfront_distribution.Distribution', 'aws_s3_bucket.SiteBucket', 'routes_to')).toBe(true);
    expect(has('aws_iam_role.ApiRole', 'aws_dynamodb_table.OrdersTable', 'grants_access')).toBe(true);
    expect(has('aws_iam_role.WorkerRole', 'aws_sqs_queue.JobsQueue', 'grants_access')).toBe(true); // via an AWS::IAM::Policy that names the role
  });

  it('bridges code to resources through environment variables, like the Terraform path', () => {
    expect(has('src/api/app.js::getOrder', 'aws_dynamodb_table.OrdersTable', 'reads', 'env_var')).toBe(true);
    expect(has('src/api/app.js::saveOrder', 'aws_sqs_queue.JobsQueue', 'publishes', 'env_var')).toBe(true);
    expect(has('src/api/app.js::storeUpload', 'aws_s3_bucket.UploadsBucket', 'writes', 'env_var')).toBe(true);
    expect(has('src/worker/main.py::process', 'aws_dynamodb_table.OrdersTable', 'writes', 'env_var')).toBe(true);
    expect(has('src/api/app.js::handler', 'aws_lambda_function.ApiFunction', 'runs_code', 'code_mapping')).toBe(true);
  });

  it('finds the same planted traps', () => {
    expect(out.findings.find((f) => f.kind === 'permission_gap')?.title).toContain('dynamodb:DeleteItem');
    expect(out.findings.filter((f) => f.kind === 'permission_gap')).toHaveLength(1);
    expect(out.findings.find((f) => f.kind === 'over_broad_iam')?.title).toContain('s3:*');
    expect(out.findings.find((f) => f.kind === 'unmanaged_resource')?.title).toContain('legacy-reports');
  });

  it('never copies parameter or environment values into node attributes', () => {
    const lambda = out.nodes.find((n) => n.address === 'aws_lambda_function.ApiFunction')!;
    expect([...(lambda.attributes.envVarNames as string[])].sort()).toEqual(['BUCKET', 'QUEUE_URL', 'TABLE_NAME']);
    expect(JSON.stringify(lambda.attributes)).not.toContain('aws_dynamodb_table.');
  });
});

describe('CDK synth output (cdk.out)', async () => {
  const out = await analyze({ files: loadFixture('cdk-synth') });
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  const edges = out.edges.map((e) => ({ from: byId.get(e.source)!.address, to: byId.get(e.target)!.address, relation: e.relation, method: e.linkMethod }));
  const has = (from: string, to: string, relation: string, method?: string) =>
    edges.some((e) => e.from === from && e.to === to && e.relation === relation && (!method || e.method === method));
  const table = 'aws_dynamodb_table.DataStack_OrdersTableABC12345';
  const fn = 'aws_lambda_function.AppStack_ApiFunction9D8C7B6A';

  it('reads both stacks and prefixes addresses so identical logical ids could not collide', () => {
    expect(out.stats.cloudFormationTemplates).toBe(2);
    expect(out.nodes.some((n) => n.address === table)).toBe(true);
    expect(out.nodes.some((n) => n.address.includes('CDKMetadata'))).toBe(false); // plumbing is skipped
  });

  it('names nodes after the CDK construct, not the hashed logical id', () => {
    expect(out.nodes.find((n) => n.address === table)?.name).toBe('OrdersTable');
    expect(out.nodes.find((n) => n.address === fn)?.name).toBe('ApiFunction');
    expect(out.nodes.find((n) => n.address.endsWith('DefaultPolicy5E6F7A8B'))?.name).toBe('ApiFunction/ServiceRole/DefaultPolicy');
  });

  it('follows cross-stack exports and imports to the real resource', () => {
    expect(has(fn, table, 'references', 'declared_reference')).toBe(true); // Lambda env var = ImportValue of the table
    expect(has('src/api/app.js::getOrder', table, 'reads', 'env_var')).toBe(true);
    expect(has('aws_iam_role.AppStack_ApiFunctionServiceRole1A2B3C4D', table, 'grants_access', 'declared_reference')).toBe(true);
  });

  it('maps un-staged asset paths to the source folder, and finds the permission gap', () => {
    expect(has('src/api/app.js::handler', fn, 'runs_code', 'code_mapping')).toBe(true);
    const gap = out.findings.find((f) => f.kind === 'permission_gap');
    expect(gap?.title).toContain('dynamodb:DeleteItem');
  });

  it('reports env vars the CDK stack never defines', () => {
    expect(out.findings.some((f) => f.kind === 'unresolved_reference' && f.title.includes('BUCKET'))).toBe(true);
  });
});

describe('Terraform and CloudFormation together', () => {
  it('puts both in one graph', async () => {
    const out = await analyze({
      files: [
        { path: 'tf/main.tf', content: 'resource "aws_sqs_queue" "jobs" {\n  name = "jobs"\n}\n' },
        { path: 'cfn/t.yaml', content: 'Resources:\n  Q:\n    Type: AWS::SQS::Queue\n    Properties:\n      QueueName: other\n' },
      ],
    });
    expect(out.nodes.map((n) => n.address).sort()).toEqual(['aws_sqs_queue.Q', 'aws_sqs_queue.jobs']);
  });

  it('keeps a handler unmapped when several files could match, instead of guessing', async () => {
    const out = await analyze({
      files: [
        { path: 't.yaml', content: 'Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      Handler: index.handler\n      Runtime: nodejs20.x\n' },
        { path: 'a/index.js', content: 'exports.handler = async () => {};\n' },
        { path: 'b/index.js', content: 'exports.handler = async () => {};\n' },
      ],
    });
    expect(out.edges.some((e) => e.relation === 'runs_code')).toBe(false);
  });
});
