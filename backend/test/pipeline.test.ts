import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis/pipeline.js';
import { loadFixture } from './helpers.js';

describe('analysis pipeline on the demo repo', async () => {
  const out = await analyze({ files: loadFixture('demo') });
  const byId = new Map(out.nodes.map((n) => [n.id, n]));
  const edges = out.edges.map((e) => ({
    from: byId.get(e.source)!.address,
    to: byId.get(e.target)!.address,
    relation: e.relation,
    method: e.linkMethod,
    confidence: e.confidence,
  }));
  const has = (from: string, to: string, relation: string, method?: string) =>
    edges.some((e) => e.from === from && e.to === to && e.relation === relation && (!method || e.method === method));

  it('creates a node for every Terraform resource', () => {
    expect(out.nodes.filter((n) => n.kind === 'resource')).toHaveLength(16);
    expect(out.nodes.find((n) => n.address === 'aws_dynamodb_table.orders')?.attributes).toMatchObject({ name: 'orders-prod' });
  });

  it('links declared references with certain confidence', () => {
    expect(has('aws_lambda_function.api', 'aws_iam_role.api_role', 'assumes_role', 'declared_reference')).toBe(true);
    expect(has('aws_apigatewayv2_integration.api', 'aws_lambda_function.api', 'invokes')).toBe(true);
    expect(has('aws_route53_record.site', 'aws_cloudfront_distribution.site', 'routes_to')).toBe(true);
    expect(has('aws_cloudfront_distribution.site', 'aws_s3_bucket.site', 'routes_to')).toBe(true);
    expect(has('aws_iam_role.api_role', 'aws_dynamodb_table.orders', 'grants_access')).toBe(true);
    expect(edges.filter((e) => e.method === 'declared_reference').every((e) => e.confidence === 'certain')).toBe(true);
  });

  it('maps code to the Lambda that runs it', () => {
    expect(has('src/api/app.js::handler', 'aws_lambda_function.api', 'runs_code', 'code_mapping')).toBe(true);
    expect(has('src/worker/main.py::handler', 'aws_lambda_function.worker', 'runs_code', 'code_mapping')).toBe(true);
  });

  it('bridges code to resources through environment variables', () => {
    expect(has('src/api/app.js::getOrder', 'aws_dynamodb_table.orders', 'reads', 'env_var')).toBe(true);
    expect(has('src/api/app.js::saveOrder', 'aws_dynamodb_table.orders', 'writes', 'env_var')).toBe(true);
    expect(has('src/api/app.js::saveOrder', 'aws_sqs_queue.jobs', 'publishes', 'env_var')).toBe(true);
    expect(has('src/api/app.js::storeUpload', 'aws_s3_bucket.uploads', 'writes', 'env_var')).toBe(true);
    expect(has('src/worker/main.py::process', 'aws_dynamodb_table.orders', 'writes', 'env_var')).toBe(true);
    expect(has('src/worker/main.py::handler', 'aws_sqs_queue.jobs', 'reads', 'env_var')).toBe(true);
  });

  it('finds the planted permission gap', () => {
    const gap = out.findings.find((f) => f.kind === 'permission_gap');
    expect(gap?.title).toContain('cancelOrder');
    expect(gap?.title).toContain('dynamodb:DeleteItem');
    expect(out.findings.filter((f) => f.kind === 'permission_gap')).toHaveLength(1); // nothing else is missing a permission
  });

  it('finds the planted over-broad role', () => {
    const broad = out.findings.find((f) => f.kind === 'over_broad_iam');
    expect(broad?.severity).toBe('high');
    expect(broad?.title).toContain('s3:*');
  });

  it('finds the planted unmanaged bucket', () => {
    const drift = out.findings.find((f) => f.kind === 'unmanaged_resource');
    expect(drift?.title).toContain('legacy-reports');
    expect(out.nodes.some((n) => n.kind === 'unmanaged_resource' && n.name === 'legacy-reports')).toBe(true);
  });

  it('keeps edges unique and confidence consistent with the link method', () => {
    const keys = out.edges.map((e) => `${e.source}|${e.target}|${e.relation}|${e.linkMethod}`);
    expect(new Set(keys).size).toBe(keys.length);
    const expected = { declared_reference: 'certain', env_var: 'high', code_mapping: 'high', gemini_inference: 'inferred' };
    expect(out.edges.every((e) => e.confidence === expected[e.linkMethod])).toBe(true);
  });

  it('never copies environment variable values into node attributes', () => {
    const lambda = out.nodes.find((n) => n.address === 'aws_lambda_function.api')!;
    expect([...(lambda.attributes.envVarNames as string[])].sort()).toEqual(['BUCKET', 'QUEUE_URL', 'TABLE_NAME']);
    expect(JSON.stringify(lambda.attributes)).not.toContain('aws_dynamodb_table');
  });
});

describe('inference (method 4)', () => {
  const files = [
    ...loadFixture('demo'),
    {
      path: 'src/api/extra.js',
      content: `const { PutCommand } = require('@aws-sdk/lib-dynamodb');
async function save(config, db, item) {
  await db.send(new PutCommand({ TableName: config.tables.orders, Item: item }));
}`,
    },
  ];

  it('asks Gemini only for calls it cannot resolve, and labels the result inferred', async () => {
    const gemini = {
      model: 'fake',
      isConfigured: () => true,
      generate: async () => ({
        text: JSON.stringify({ resourceAddress: 'aws_dynamodb_table.orders', reasoning: 'config.tables.orders is the orders table.' }),
        functionCalls: [],
        content: { role: 'model' as const, parts: [] },
      }),
    };
    // extra.js shares the API Lambda's folder only if it is in src/api, which it is.
    const out = await analyze({ files, gemini });
    const inferred = out.edges.filter((e) => e.linkMethod === 'gemini_inference');
    expect(inferred).toHaveLength(1);
    expect(inferred[0]).toMatchObject({ confidence: 'inferred', relation: 'writes' });
    expect(inferred[0]!.explanation).toContain('orders');
    expect(out.stats.inference).toMatchObject({ attempted: 1, linked: 1 });
  });

  it('reports unresolved calls instead of guessing when Gemini is unavailable', async () => {
    const out = await analyze({ files });
    expect(out.edges.some((e) => e.linkMethod === 'gemini_inference')).toBe(false);
    expect(out.findings.some((f) => f.kind === 'unresolved_reference' && f.title.includes('dynamodb:PutItem'))).toBe(true);
    expect(out.stats.inference).toMatchObject({ skipped: 'not_configured' });
  });
});
