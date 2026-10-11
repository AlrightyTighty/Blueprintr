import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { scanCode } from '../src/core/code/scan.js';
import { runGraphQuery } from '../src/core/graph/query.js';
import { reach, shortestPath } from '../src/core/graph/traversal.js';
import type { Graph, GraphEdge, GraphNode } from '../src/core/graph/types.js';
import { baseAddress, overlayPlan, parsePlanJson, toPlanAction } from '../src/core/plans/overlay.js';
import { parseHclExpression } from '../src/core/terraform/hclExpr.js';
import { actionMatches, parsePolicyAttribute } from '../src/core/terraform/policies.js';
import { findRefs, resolveString } from '../src/core/terraform/references.js';
import { isAnalyzablePath } from '../src/integrations/github.js';
import { readTarGz } from '../src/integrations/tar.js';

describe('terraform references', () => {
  it('finds resource, data, var and module references inside interpolations', () => {
    const refs = findRefs('${aws_dynamodb_table.orders.arn}/index/${var.env}-${data.archive_file.api.output_path}-${module.net.id}');
    expect(refs).toEqual([
      { kind: 'resource', type: 'aws_dynamodb_table', name: 'orders', attribute: 'arn' },
      { kind: 'var', name: 'env' },
      { kind: 'data', type: 'archive_file', name: 'api', attribute: 'output_path' },
      { kind: 'module', name: 'net' },
    ]);
  });

  it('ignores words that merely look like references', () => {
    expect(findRefs('no interpolation aws_s3_bucket.logs')).toEqual([]);
    expect(findRefs('${path.module}/data_files.json')).toEqual([]);
  });

  it('resolves variables and locals from defaults, and refuses to guess otherwise', () => {
    const scope = { variables: new Map<string, unknown>([['env', 'prod']]), locals: new Map<string, unknown>([['name', 'orders-${var.env}']]) };
    expect(resolveString('${local.name}-x', scope)).toBe('orders-prod-x');
    expect(resolveString('${var.missing}', scope)).toBeNull();
    expect(resolveString('${aws_s3_bucket.b.id}', scope)).toBeNull();
  });
});

describe('IAM policy reading', () => {
  it('reads jsonencode bodies', () => {
    const value = `\${jsonencode({\n Version = "2012-10-17"\n Statement = [\n {\n Effect = "Allow"\n Action = ["s3:GetObject", "s3:ListBucket"]\n Resource = [aws_s3_bucket.b.arn, "\${aws_s3_bucket.b.arn}/*"]\n },\n { Effect = "Deny", Action = "s3:Delete*", Resource = "*" }\n ]\n })}`;
    const statements = parsePolicyAttribute(value, new Map())!;
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatchObject({ effect: 'Allow', actions: ['s3:GetObject', 's3:ListBucket'] });
    expect(statements[0]!.resources).toHaveLength(2);
    expect(statements[1]).toMatchObject({ effect: 'Deny', resources: [{ kind: 'all' }] });
  });

  it('reads JSON heredocs and policy-document data sources', () => {
    const json = '{"Statement":[{"Effect":"Allow","Action":"sqs:SendMessage","Resource":"${aws_sqs_queue.q.arn}"}]}';
    expect(parsePolicyAttribute(json, new Map())![0]!.resources[0]).toMatchObject({ kind: 'ref', ref: { name: 'q' } });
    const docs = new Map([['d', [{ effect: 'Allow' as const, actions: ['x:y'], resources: [] }]]]);
    expect(parsePolicyAttribute('${data.aws_iam_policy_document.d.json}', docs)).toHaveLength(1);
  });

  it('says "unknown" rather than guessing when it cannot read a policy', () => {
    expect(parsePolicyAttribute('${jsonencode(merge(local.a, local.b))}', new Map())).toBeNull();
    expect(parseHclExpression('{ a = 1 +')).toBeUndefined();
  });

  it('matches IAM action wildcards', () => {
    expect(actionMatches('dynamodb:*', 'dynamodb:GetItem')).toBe(true);
    expect(actionMatches('s3:Get*', 's3:GetObject')).toBe(true);
    expect(actionMatches('s3:Get*', 's3:PutObject')).toBe(false);
    expect(actionMatches('*', 'sqs:SendMessage')).toBe(true);
    expect(actionMatches('S3:getobject', 's3:GetObject')).toBe(true);
  });
});

describe('code scanner', () => {
  it('finds env reads in JavaScript and Python, including destructuring', () => {
    const facts = scanCode([
      { path: 'a.js', content: "const { A, B: renamed } = process.env;\nfunction f() { return process.env['C'] + process.env.D; }" },
      { path: 'b.py', content: "import os\ndef g():\n    return os.environ['E'], os.environ.get('F'), os.getenv('G', 'x')\n" },
    ]);
    expect(facts.envReads.map((r) => r.name).sort()).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(facts.envReads.find((r) => r.name === 'C')?.function).toBe('a.js::f');
    expect(facts.envReads.find((r) => r.name === 'E')?.function).toBe('b.py::g');
  });

  it('finds functions, arrow functions and their extents', () => {
    const facts = scanCode([
      { path: 'x.ts', content: 'export async function one() {\n  if (true) {\n    return 1;\n  }\n}\nconst two = async (a: number) => {\n  return a;\n};\nconst three = (a) => a + 1;\nexports.four = function () {};\n' },
    ]);
    const fn = (name: string) => facts.functions.find((f) => f.name === name)!;
    expect([fn('one').lineStart, fn('one').lineEnd]).toEqual([1, 5]);
    expect([fn('two').lineStart, fn('two').lineEnd]).toEqual([6, 8]);
    expect([fn('three').lineStart, fn('three').lineEnd]).toEqual([9, 9]);
    expect(fn('four')).toBeTruthy();
  });

  it('ignores commented-out code', () => {
    const facts = scanCode([{ path: 'c.js', content: "// new GetCommand({ TableName: 'old' })\n/* process.env.NOPE */\nconst x = 1;" }]);
    expect(facts.sdkCalls).toHaveLength(0);
    expect(facts.envReads).toHaveLength(0);
  });

  it('resolves targets through constants and keeps unknown ones unknown', () => {
    const facts = scanCode([
      {
        path: 'd.js',
        content:
          "const TABLE = process.env.MY_TABLE;\nconst BUCKET = 'literal-bucket';\nasync function f(cfg) {\n await c.send(new GetCommand({ TableName: TABLE }));\n await c.send(new PutObjectCommand({ Bucket: BUCKET }));\n await c.send(new SendMessageCommand({ QueueUrl: cfg.queue }));\n}",
      },
    ]);
    const targets = facts.sdkCalls.map((c) => [c.action, c.target]);
    expect(targets).toEqual([
      ['dynamodb:GetItem', { kind: 'env', name: 'MY_TABLE' }],
      ['s3:PutObject', { kind: 'literal', value: 'literal-bucket' }],
      ['sqs:SendMessage', { kind: 'unknown', hint: 'cfg.queue' }],
    ]);
  });

  it('does not mistake generic method names for AWS calls', () => {
    const facts = scanCode([{ path: 'e.js', content: "async function f() { await axios.get('/x'); cache.delete(key); emitter.publish(); map.put(1, 2); }" }]);
    expect(facts.sdkCalls).toHaveLength(0);
  });

  it('understands boto3 clients, resources and Table receivers', () => {
    const facts = scanCode([
      {
        path: 'p.py',
        content:
          "import boto3, os\ntbl = boto3.resource('dynamodb').Table('orders')\ns3 = boto3.client('s3')\ndef f():\n    tbl.delete_item(Key={'id': 1})\n    tbl.query(KeyConditionExpression='x')\n    s3.get_object(Bucket=os.environ['B'], Key='k')\n    session.query(User)\n",
      },
    ]);
    expect(facts.sdkCalls.map((c) => [c.action, c.target])).toEqual([
      ['dynamodb:DeleteItem', { kind: 'literal', value: 'orders' }],
      ['dynamodb:Query', { kind: 'literal', value: 'orders' }],
      ['s3:GetObject', { kind: 'env', name: 'B' }],
    ]);
  });
});

// A tiny graph:  fn -reads-> table <-grants- role <-assumes- lambda <-runs- fn2
const node = (id: string, kind: GraphNode['kind'], address = id): GraphNode => ({
  id, kind, address, name: address, terraformType: null, resourceType: null, parentId: null, filePath: null, lineStart: null, lineEnd: null, attributes: {},
});
const edge = (id: string, source: string, target: string, relation: GraphEdge['relation'], confidence: GraphEdge['confidence'] = 'high'): GraphEdge => ({
  id, source, target, relation, linkMethod: confidence === 'certain' ? 'declared_reference' : confidence === 'inferred' ? 'gemini_inference' : 'env_var', confidence, evidence: {}, explanation: null,
});
const graph: Graph = {
  runId: 'r', commitSha: null,
  nodes: [node('table', 'resource', 'aws_dynamodb_table.orders'), node('fn', 'code_function', 'a.js::get'), node('role', 'resource', 'aws_iam_role.r'), node('lambda', 'resource', 'aws_lambda_function.l'), node('fn2', 'code_function', 'a.js::handler'), node('lonely', 'resource', 'aws_s3_bucket.b')],
  edges: [
    edge('e1', 'fn', 'table', 'reads'),
    edge('e2', 'role', 'table', 'grants_access', 'certain'),
    edge('e3', 'lambda', 'role', 'assumes_role', 'certain'),
    edge('e4', 'fn2', 'lambda', 'runs_code'),
    edge('e5', 'fn', 'lambda', 'runs_code', 'inferred'),
  ],
};

describe('graph traversal', () => {
  it('walks dependents (what breaks) with distances', () => {
    const found = reach(graph, ['table'], 'dependents');
    expect([...found.keys()].sort()).toEqual(['fn', 'fn2', 'lambda', 'role']);
    expect(found.get('fn')!.distance).toBe(1);
    expect(found.get('role')!.distance).toBe(1);
    expect(found.get('lambda')!.distance).toBe(2);
    expect(found.get('fn2')!.distance).toBe(3);
  });

  it('walks dependencies', () => {
    expect([...reach(graph, ['fn2'], 'dependencies').keys()].sort()).toEqual(['lambda', 'role', 'table']);
  });

  it('respects depth and the minimum confidence', () => {
    expect([...reach(graph, ['table'], 'dependents', { maxDepth: 1 }).keys()].sort()).toEqual(['fn', 'role']);
    expect(reach(graph, ['table'], 'dependents', { minConfidence: 'certain' }).has('fn')).toBe(false);
  });

  it('reports the weakest confidence along a path', () => {
    expect(reach(graph, ['table'], 'dependents').get('fn2')!.weakestConfidence).toBe('high');
    expect(reach(graph, ['lambda'], 'dependents').get('fn')!.weakestConfidence).toBe('inferred');
  });

  it('finds shortest paths in either direction, and none where none exists', () => {
    expect(shortestPath(graph, 'fn2', 'table')!.map((e) => e.id)).toEqual(['e4', 'e3', 'e2']);
    expect(shortestPath(graph, 'fn2', 'lonely')).toBeNull();
  });

  it('terminates on cycles', () => {
    const cyclic: Graph = { ...graph, edges: [...graph.edges, edge('loop', 'table', 'fn2', 'references')] };
    expect(reach(cyclic, ['table'], 'dependents').size).toBeGreaterThan(0);
  });
});

describe('graph query', () => {
  const ctx = { findings: [] };

  it('answers "what touches the table"', () => {
    const result = runGraphQuery(graph, { op: 'touches', node: 'orders' }, ctx);
    expect(result.results.map((r) => r.node.id).sort()).toEqual(['fn', 'role']);
    expect(result.summary).toContain('2 things touch aws_dynamodb_table.orders');
  });

  it('answers "what does this function touch"', () => {
    const result = runGraphQuery(graph, { op: 'touches', node: 'a.js::get' }, ctx);
    expect(result.results.map((r) => r.node.id)).toEqual(['table']);
  });

  it('is honest when it finds nothing', () => {
    expect(runGraphQuery(graph, { op: 'dependents', node: 'nope' }, ctx).summary).toContain("couldn't find");
    expect(runGraphQuery(graph, { op: 'dependents', node: 'lonely' }, ctx).summary).toContain('Nothing depends on');
  });

  it('annotates results with plan tags', () => {
    const result = runGraphQuery(graph, { op: 'dependents', node: 'table' }, { findings: [], planTags: new Map([['lambda', 'downstream']]) });
    expect(result.summary).toContain('aws_lambda_function.l [plan: downstream]');
  });
});

describe('plan overlay', () => {
  const plan = {
    format_version: '1.2',
    terraform_version: '1.9.0',
    resource_changes: [
      { address: 'aws_dynamodb_table.orders', type: 'aws_dynamodb_table', change: { actions: ['delete', 'create'], before: { name: 'a', secret: 'HUNTER2' }, after: { name: 'b', secret: 'HUNTER3' }, after_unknown: { arn: true } } },
      { address: 'aws_s3_bucket.b[0]', type: 'aws_s3_bucket', change: { actions: ['update'], before: { tags: { a: 1 } }, after: { tags: { a: 2 } } } },
      { address: 'aws_s3_bucket.b[1]', type: 'aws_s3_bucket', change: { actions: ['no-op'] } },
      { address: 'aws_sqs_queue.new', type: 'aws_sqs_queue', change: { actions: ['create'], after: { name: 'q' } } },
    ],
  };

  it('maps Terraform actions and strips instance suffixes', () => {
    expect(toPlanAction(['create', 'delete'])).toBe('replace');
    expect(toPlanAction(['delete', 'create'])).toBe('replace');
    expect(toPlanAction(['delete'])).toBe('destroy');
    expect(toPlanAction(['read'])).toBe('noop');
    expect(baseAddress('aws_s3_bucket.b["x"][0]')).toBe('aws_s3_bucket.b');
  });

  it('keeps attribute names, never values', () => {
    const parsed = parsePlanJson(plan);
    expect(JSON.stringify(parsed)).not.toContain('HUNTER');
    expect(parsed.changes.find((c) => c.address === 'aws_dynamodb_table.orders')!.changedAttributes).toEqual(['arn', 'name', 'secret']);
  });

  it('rejects things that are not plans', () => {
    expect(() => parsePlanJson({ hello: 1 })).toThrow(/Terraform plan/);
    expect(() => parsePlanJson('x')).toThrow();
  });

  it('marks changed resources direct and everything depending on a replace downstream', () => {
    const overlay = overlayPlan(graph, parsePlanJson(plan));
    const direct = overlay.changes.filter((c) => c.impact === 'direct').map((c) => [c.address, c.action]);
    expect(direct).toEqual(expect.arrayContaining([['aws_dynamodb_table.orders', 'replace'], ['aws_s3_bucket.b', 'update'], ['aws_sqs_queue.new', 'create']]));
    const downstream = overlay.changes.filter((c) => c.impact === 'downstream');
    expect(downstream.map((c) => c.nodeId).sort()).toEqual(['fn', 'fn2', 'lambda', 'role']);
    expect(downstream.every((c) => c.action === 'noop')).toBe(true);
    expect(overlay.summary).toMatchObject({ replace: 1, update: 1, create: 1, downstream: 4 });
  });

  it('only a replace or destroy spreads; an update does not', () => {
    const onlyUpdate = overlayPlan(graph, parsePlanJson({ resource_changes: [{ address: 'aws_dynamodb_table.orders', change: { actions: ['update'], before: {}, after: { a: 1 } } }] }));
    expect(onlyUpdate.changes.filter((c) => c.impact === 'downstream')).toHaveLength(0);
  });
});

describe('GitHub archive reader', () => {
  it('extracts wanted files from a real tarball and strips the top folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    const root = join(dir, 'owner-repo-abc123');
    mkdirSync(join(root, 'infra'), { recursive: true });
    mkdirSync(join(root, 'node_modules/x'), { recursive: true });
    writeFileSync(join(root, 'infra/main.tf'), 'resource "aws_s3_bucket" "b" {}\n');
    writeFileSync(join(root, 'app.py'), 'print(1)\n');
    writeFileSync(join(root, 'README.md'), '# hi\n');
    writeFileSync(join(root, 'node_modules/x/index.js'), 'skip me');
    writeFileSync(join(root, 'big.js'), 'x'.repeat(5000));
    const tgz = execFileSync('tar', ['-czf', '-', '-C', dir, 'owner-repo-abc123'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });

    const files = await readTarGz(Readable.toWeb(Readable.from([tgz])) as never, {
      maxTotalBytes: 1_000_000,
      want: (path, size) => isAnalyzablePath(path) && size < 1000,
    });
    expect(files.map((f) => f.path).sort()).toEqual(['app.py', 'infra/main.tf']);
    expect(files.find((f) => f.path === 'infra/main.tf')!.content.toString()).toContain('aws_s3_bucket');
  });

  it('refuses archives over the size budget', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tar-'));
    mkdirSync(join(dir, 'r'));
    writeFileSync(join(dir, 'r/a.js'), 'x'.repeat(4000));
    const tgz = execFileSync('tar', ['-czf', '-', '-C', dir, 'r'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    await expect(readTarGz(Readable.toWeb(Readable.from([tgz])) as never, { maxTotalBytes: 100, want: () => true })).rejects.toThrow(/too large/);
  });
});
