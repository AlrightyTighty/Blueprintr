import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis/pipeline.js';
import { listEndpoints, type EndpointInfo } from '../src/core/endpoints/list.js';
import { closestEndpoints, matchRequest, normalizePath } from '../src/core/endpoints/match.js';
import { traceEndpoint, traceRequest, type EndpointTrace } from '../src/core/endpoints/trace.js';
import { scanCode } from '../src/core/code/scan.js';
import { runGraphQuery } from '../src/core/graph/query.js';
import type { Graph } from '../src/core/graph/types.js';
import { loadFixture } from './helpers.js';

async function graphOf(files: { path: string; content: string }[]): Promise<Graph> {
  const out = await analyze({ files });
  return { runId: 'run', commitSha: null, nodes: out.nodes.map((n) => ({ ...n, resourceType: null })), edges: out.edges };
}

const endpoint = (method: string, path: string, extra: Partial<EndpointInfo> = {}): EndpointInfo => ({
  id: `${method} ${path} ${extra.address ?? ''}`,
  address: extra.address ?? `route:${method} ${path}`,
  kind: 'http_api',
  method,
  path,
  apiNodeId: null,
  functionNodeId: null,
  ...extra,
});

const winner = (endpoints: EndpointInfo[], method: string, path: string) => {
  const result = matchRequest(endpoints, method, path);
  return result ? `${result.best.endpoint.method} ${result.best.endpoint.path}` : null;
};

describe('matching a request to an endpoint (as API Gateway would)', () => {
  const endpoints = [
    endpoint('GET', '/orders/{id}'),
    endpoint('GET', '/orders/recent'),
    endpoint('ANY', '/orders/{id}'),
    endpoint('GET', '/files/{proxy+}'),
    endpoint('POST', '/orders'),
    endpoint('GET', '/'),
    endpoint('ANY', '/{proxy+}', { isDefault: true }),
  ];

  it('prefers a literal segment over a parameter over a greedy segment over the catch-all', () => {
    expect(winner(endpoints, 'GET', '/orders/recent')).toBe('GET /orders/recent');
    expect(winner(endpoints, 'GET', '/orders/123')).toBe('GET /orders/{id}');
    expect(winner(endpoints, 'GET', '/files/a/b/c.txt')).toBe('GET /files/{proxy+}');
    expect(winner(endpoints, 'GET', '/nothing/here')).toBe('ANY /{proxy+}');
  });

  it('prefers an exact method over ANY, and uses ANY when nothing more specific exists', () => {
    expect(winner(endpoints, 'GET', '/orders/9')).toBe('GET /orders/{id}');
    expect(winner(endpoints, 'DELETE', '/orders/9')).toBe('ANY /orders/{id}');
    expect(winner(endpoints, 'POST', '/orders')).toBe('POST /orders');
  });

  it('ignores query strings and trailing or duplicate slashes, and accepts any method case', () => {
    expect(winner(endpoints, 'get', '/orders/123/?expand=items#top')).toBe('GET /orders/{id}');
    expect(winner(endpoints, 'GET', '//orders//123')).toBe('GET /orders/{id}');
    expect(normalizePath('orders/1/')).toBe('/orders/1');
    expect(winner(endpoints, 'GET', '')).toBe('GET /');
  });

  it('treats paths as case-sensitive', () => {
    expect(winner(endpoints, 'GET', '/Orders/recent')).toBe('ANY /{proxy+}');
  });

  it('extracts path parameters, including greedy ones', () => {
    expect(matchRequest(endpoints, 'GET', '/orders/42')!.best.params).toEqual({ id: '42' });
    expect(matchRequest(endpoints, 'GET', '/files/a/b')!.best.params).toEqual({ proxy: 'a/b' });
    expect(matchRequest(endpoints, 'GET', '/orders/a%20b')!.best.params).toEqual({ id: 'a b' });
  });

  it('requires {proxy+} to match at least one segment, but lets the catch-all take the root', () => {
    const onlyGreedy = [endpoint('GET', '/files/{proxy+}')];
    expect(winner(onlyGreedy, 'GET', '/files')).toBeNull();
    expect(winner(onlyGreedy, 'GET', '/files/x')).toBe('GET /files/{proxy+}');
    expect(winner([endpoint('ANY', '/{proxy+}', { isDefault: true })], 'GET', '/')).toBe('ANY /{proxy+}');
  });

  it('returns equally good matches (the same route on two APIs) as alternates', () => {
    const two = [endpoint('GET', '/health', { address: 'a.route' }), endpoint('GET', '/health', { address: 'b.route' })];
    const result = matchRequest(two, 'GET', '/health')!;
    expect(result.best.endpoint.address).toBe('a.route');
    expect(result.alternates.map((m) => m.endpoint.address)).toEqual(['b.route']);
  });

  it('suggests the nearest endpoints when nothing matches', () => {
    const none = endpoints.filter((e) => !e.isDefault);
    expect(matchRequest(none, 'GET', '/orderz')).toBeNull();
    expect(closestEndpoints(none, 'GET', '/orders/x/y/z', 2).map((e) => e.path)).toEqual(['/orders/{id}', '/orders/recent']);
    expect(closestEndpoints(none, 'DELETE', '/zzz', 2)).toHaveLength(2);
  });
});

describe('finding endpoints in infrastructure code', () => {
  const tf = (body: string) => [{ path: 'main.tf', content: body }];
  const lambda = `
resource "aws_lambda_function" "fn" {
  function_name = "fn"
  handler       = "app.handler"
  runtime       = "nodejs20.x"
}`;

  it('reads HTTP API routes, including $default and ANY', async () => {
    const graph = await graphOf(
      tf(`${lambda}
resource "aws_apigatewayv2_api" "http" { name = "a" }
resource "aws_apigatewayv2_integration" "i" {
  api_id          = aws_apigatewayv2_api.http.id
  integration_uri = aws_lambda_function.fn.invoke_arn
}
resource "aws_apigatewayv2_route" "get" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "get /orders/{id}"
  authorization_type = "JWT"
  target             = "integrations/\${aws_apigatewayv2_integration.i.id}"
}
resource "aws_apigatewayv2_route" "any" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "ANY /items"
  target    = "integrations/\${aws_apigatewayv2_integration.i.id}"
}
resource "aws_apigatewayv2_route" "fallback" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/\${aws_apigatewayv2_integration.i.id}"
}
resource "aws_apigatewayv2_route" "broken" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = var.not_set
}`),
    );
    const found = listEndpoints(graph).map((e) => [e.method, e.path, e.isDefault ?? false, e.authorization ?? null]);
    expect(found).toEqual(
      expect.arrayContaining([
        ['GET', '/orders/{id}', false, 'JWT'],
        ['ANY', '/items', false, null],
        ['ANY', '/{proxy+}', true, null],
      ]),
    );
    expect(found).toHaveLength(3); // the route whose key can't be read is not guessed at
    const all = listEndpoints(graph);
    expect(all.every((e) => e.apiNodeId !== null && e.functionNodeId !== null)).toBe(true);
  });

  it('assembles REST API paths from nested resources', async () => {
    const graph = await graphOf(
      tf(`${lambda}
resource "aws_api_gateway_rest_api" "rest" { name = "r" }
resource "aws_api_gateway_resource" "orders" {
  rest_api_id = aws_api_gateway_rest_api.rest.id
  parent_id   = aws_api_gateway_rest_api.rest.root_resource_id
  path_part   = "orders"
}
resource "aws_api_gateway_resource" "order" {
  rest_api_id = aws_api_gateway_rest_api.rest.id
  parent_id   = aws_api_gateway_resource.orders.id
  path_part   = "{id}"
}
resource "aws_api_gateway_method" "get_order" {
  rest_api_id   = aws_api_gateway_rest_api.rest.id
  resource_id   = aws_api_gateway_resource.order.id
  http_method   = "GET"
  authorization = "AWS_IAM"
}
resource "aws_api_gateway_integration" "get_order" {
  rest_api_id = aws_api_gateway_rest_api.rest.id
  resource_id = aws_api_gateway_resource.order.id
  http_method = aws_api_gateway_method.get_order.http_method
  uri         = aws_lambda_function.fn.invoke_arn
}
resource "aws_api_gateway_integration" "root" {
  rest_api_id = aws_api_gateway_rest_api.rest.id
  resource_id = aws_api_gateway_rest_api.rest.root_resource_id
  http_method = "POST"
  uri         = aws_lambda_function.fn.invoke_arn
}`),
    );
    const found = listEndpoints(graph).map((e) => `${e.kind} ${e.method} ${e.path} ${e.authorization ?? ''}`.trim());
    expect(found).toContain('rest_api POST /');
    expect(found).toContain('rest_api GET /orders/{id} AWS_IAM');
  });

  it('reads Lambda function URLs as a catch-all', async () => {
    const graph = await graphOf([
      ...tf(`${lambda}
resource "aws_lambda_function_url" "url" {
  function_name      = aws_lambda_function.fn.function_name
  authorization_type = "NONE"
}`),
    ]);
    const [url] = listEndpoints(graph);
    expect(url).toMatchObject({ kind: 'function_url', method: 'ANY', path: '/{proxy+}', isDefault: true, apiNodeId: null });
    expect(url!.functionNodeId).not.toBeNull();
    expect(url!.authorization).toBeUndefined(); // NONE means open; nothing to report
  });

  it('reads REST API paths and function URLs from CloudFormation', async () => {
    const graph = await graphOf([
      {
        path: 't.yaml',
        content: `Resources:
  Fn:
    Type: AWS::Lambda::Function
    Properties: { Handler: app.handler, Runtime: nodejs20.x }
  Url:
    Type: AWS::Lambda::Url
    Properties: { TargetFunctionArn: !GetAtt Fn.Arn, AuthType: AWS_IAM }
  Api:
    Type: AWS::ApiGateway::RestApi
  Orders:
    Type: AWS::ApiGateway::Resource
    Properties: { RestApiId: !Ref Api, ParentId: !GetAtt Api.RootResourceId, PathPart: orders }
  Get:
    Type: AWS::ApiGateway::Method
    Properties:
      RestApiId: !Ref Api
      ResourceId: !Ref Orders
      HttpMethod: GET
      AuthorizationType: NONE
      Integration: { Type: AWS_PROXY, Uri: !Sub 'arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/\${Fn.Arn}/invocations' }
`,
      },
    ]);
    const found = listEndpoints(graph).map((e) => `${e.kind} ${e.method} ${e.path} ${e.authorization ?? ''}`.trim());
    expect(found.sort()).toEqual(['function_url ANY /{proxy+} AWS_IAM', 'rest_api GET /orders']);
  });
});

describe('call graph', () => {
  const calls = (files: { path: string; content: string }[]) =>
    scanCode(files).calls.map((c) => `${c.caller} -> ${c.callee}`).sort();

  it('follows bare calls inside a file, but not declarations, methods or itself', () => {
    expect(
      calls([
        {
          path: 'a.js',
          content: `function leaf() {}
function mid() { leaf(); leaf(); mid(); obj.leaf(); }
const top = async () => {
  mid();
  function inner() {
    leaf();
  }
};
class K { leaf() {} }`,
        },
      ]),
    ).toEqual(['a.js::inner -> a.js::leaf', 'a.js::mid -> a.js::leaf', 'a.js::mid -> a.js::leaf', 'a.js::top -> a.js::mid']);
  });

  it('follows require and import across files, with renames and namespaces', () => {
    expect(
      calls([
        { path: 'src/app.js', content: "const { save, load: fetchIt } = require('./db');\nconst util = require('./lib/util.js');\nexports.handler = async () => { save(); fetchIt(); util.fmt(); };" },
        { path: 'src/db.js', content: 'function save() {}\nfunction load() {}\nmodule.exports = { save, load };' },
        { path: 'src/lib/util.js', content: 'function fmt() {}\nmodule.exports = { fmt };' },
        { path: 'src/main.ts', content: "import { save as put } from './db';\nimport * as u from './lib/util';\nimport def from './db';\nexport function run() { put(); u.fmt(); }" },
      ]),
    ).toEqual(['src/app.js::handler -> src/db.js::load', 'src/app.js::handler -> src/db.js::save', 'src/app.js::handler -> src/lib/util.js::fmt', 'src/main.ts::run -> src/db.js::save', 'src/main.ts::run -> src/lib/util.js::fmt']);
  });

  it('ignores packages and imports that are not analyzed files', () => {
    expect(calls([{ path: 'a.js', content: "const { get } = require('lodash');\nconst x = require('./missing');\nfunction f() { get(); x.go(); }" }])).toEqual([]);
  });

  it('follows Python imports, relative imports and module attributes', () => {
    expect(
      calls([
        { path: 'svc/main.py', content: 'from .store import put, get as fetch\nimport svc.helpers as h\nfrom svc import util\n\ndef handler(event, ctx):\n    put(1)\n    fetch(2)\n    h.clean()\n    util.pad()\n' },
        { path: 'svc/store.py', content: 'def put(x):\n    pass\n\ndef get(x):\n    pass\n' },
        { path: 'svc/helpers.py', content: 'def clean():\n    pass\n' },
        { path: 'svc/util/__init__.py', content: 'def pad():\n    pass\n' },
      ]),
    ).toEqual(['svc/main.py::handler -> svc/helpers.py::clean', 'svc/main.py::handler -> svc/store.py::get', 'svc/main.py::handler -> svc/store.py::put', 'svc/main.py::handler -> svc/util/__init__.py::pad']);
  });

  it('only keeps calls on a path from a handler to something that uses a resource', async () => {
    const graph = await graphOf(loadFixture('demo'));
    const functions = graph.nodes.filter((n) => n.kind === 'code_function').map((n) => n.address);
    expect(functions).not.toContain('src/api/app.js::formatDate'); // a helper would never appear
    const calledFromHandler = graph.edges.filter((e) => e.relation === 'calls').map((e) => graph.nodes.find((n) => n.id === e.target)!.name);
    expect(calledFromHandler.sort()).toEqual(['archiveReport', 'cancelOrder', 'getOrder', 'process', 'saveOrder', 'storeUpload']);
    expect(graph.edges.filter((e) => e.relation === 'calls').every((e) => e.linkMethod === 'code_mapping' && e.confidence === 'high')).toBe(true);
  });

  it('makes a resource change reach the handler (blast radius)', async () => {
    const graph = await graphOf(loadFixture('demo'));
    const table = graph.nodes.find((n) => n.address === 'aws_dynamodb_table.orders')!;
    const { reach } = await import('../src/core/graph/traversal.js');
    const dependents = [...reach(graph, [table.id], 'dependents').keys()].map((id) => graph.nodes.find((n) => n.id === id)!.address);
    expect(dependents).toContain('src/api/app.js::handler');
    expect(dependents).toContain('aws_apigatewayv2_route.get_order'); // and through the Lambda, the routes
  });
});

describe('tracing a request', () => {
  const nameOf = (graph: Graph, trace: EndpointTrace) => trace.steps.map((s) => graph.nodes.find((n) => n.id === s.nodeId)!.address);

  it('follows POST /orders from the API through the handler to the data, then into the worker', async () => {
    const graph = await graphOf(loadFixture('demo'));
    const outcome = traceRequest(graph, { method: 'POST', path: '/orders' });
    if (!outcome.found) throw new Error('expected a match');
    const { trace } = outcome;

    expect(trace.match).toMatchObject({ method: 'POST', path: '/orders', kind: 'http_api', pathParams: {} });
    const names = nameOf(graph, trace);
    expect(names.slice(0, 5)).toEqual([
      'aws_apigatewayv2_api.http',
      'aws_apigatewayv2_route.post_order',
      'aws_apigatewayv2_integration.api',
      'aws_lambda_function.api',
      'src/api/app.js::handler',
    ]);
    expect(names).toEqual(expect.arrayContaining(['src/api/app.js::saveOrder', 'aws_dynamodb_table.orders', 'aws_sqs_queue.jobs']));
    // The background half: the queue triggers the worker Lambda, which runs its code.
    const asyncNames = trace.steps.filter((s) => s.async).map((s) => graph.nodes.find((n) => n.id === s.nodeId)!.address);
    expect(asyncNames).toEqual(['aws_lambda_function.worker', 'src/worker/main.py::handler', 'src/worker/main.py::process']);
    expect(trace.steps.find((s) => s.async)!.relation).toBe('invokes');
    expect(trace.steps.find((s) => s.async)!.edgeIds).toHaveLength(2); // queue -> trigger -> worker
    // Each step says where it came from, and the first has no parent.
    expect(trace.steps[0]!.fromNodeId).toBeNull();
    expect(trace.steps.slice(1).every((s) => s.fromNodeId !== null)).toBe(true);
    // Every edge it cites exists in the graph, and the trace returns them for highlighting.
    const edgeIds = new Set(graph.edges.map((e) => e.id));
    expect(trace.steps.flatMap((s) => s.edgeIds).every((id) => edgeIds.has(id))).toBe(true);
    expect(trace.edges.length).toBeGreaterThan(5);
    expect(trace.summary).toContain('POST /orders is handled by POST /orders');
    expect(trace.summary).toContain('in the background');
  });

  it('says honestly that a shared handler can not be narrowed to one route', async () => {
    const graph = await graphOf(loadFixture('demo'));
    const outcome = traceRequest(graph, { method: 'GET', path: '/orders/123' });
    if (!outcome.found) throw new Error('expected a match');
    expect(outcome.trace.match.pathParams).toEqual({ id: '123' });
    expect(outcome.trace.codeScope).toBe('shared_handler');
    expect(outcome.trace.gaps.join(' ')).toContain('serves 5 endpoints through one handler');
  });

  it('is exact when a Lambda serves a single endpoint', async () => {
    const graph = await graphOf([
      {
        path: 'main.tf',
        content: `
resource "aws_dynamodb_table" "t" { name = "t" }
resource "aws_lambda_function" "get" {
  function_name = "get"
  handler       = "get.handler"
  runtime       = "nodejs20.x"
  filename      = "x.zip"
  environment { variables = { TABLE = aws_dynamodb_table.t.name } }
}
resource "aws_apigatewayv2_api" "a" { name = "a" }
resource "aws_apigatewayv2_integration" "i" {
  api_id          = aws_apigatewayv2_api.a.id
  integration_uri = aws_lambda_function.get.invoke_arn
}
resource "aws_apigatewayv2_route" "r" {
  api_id    = aws_apigatewayv2_api.a.id
  route_key = "GET /things"
  target    = "integrations/\${aws_apigatewayv2_integration.i.id}"
}`,
      },
      { path: 'get.js', content: "const { GetCommand } = require('@aws-sdk/lib-dynamodb');\nconst read = (c) => c.send(new GetCommand({ TableName: process.env.TABLE }));\nexports.handler = async () => read(client);" },
    ]);
    const outcome = traceRequest(graph, { method: 'GET', path: '/things' });
    if (!outcome.found) throw new Error('expected a match');
    expect(outcome.trace.codeScope).toBe('endpoint');
    expect(outcome.trace.gaps).toEqual([]);
    expect(nameOf(graph, outcome.trace)).toEqual(['aws_apigatewayv2_api.a', 'aws_apigatewayv2_route.r', 'aws_apigatewayv2_integration.i', 'aws_lambda_function.get', 'get.js::handler', 'get.js::read', 'aws_dynamodb_table.t']);
  });

  it('starts at the domain and CDN when they route to the API', async () => {
    const graph = await graphOf([
      {
        path: 'main.tf',
        content: `
resource "aws_lambda_function" "fn" {
  function_name = "fn"
  handler       = "app.handler"
  runtime       = "nodejs20.x"
}
resource "aws_apigatewayv2_api" "a" { name = "a" }
resource "aws_apigatewayv2_integration" "i" {
  api_id          = aws_apigatewayv2_api.a.id
  integration_uri = aws_lambda_function.fn.invoke_arn
}
resource "aws_apigatewayv2_route" "r" {
  api_id    = aws_apigatewayv2_api.a.id
  route_key = "GET /x"
  target    = "integrations/\${aws_apigatewayv2_integration.i.id}"
}
resource "aws_cloudfront_distribution" "cdn" {
  origin { domain_name = aws_apigatewayv2_api.a.api_endpoint }
}
resource "aws_route53_record" "dns" {
  name = "api.example.com"
  alias { name = aws_cloudfront_distribution.cdn.domain_name }
}`,
      },
    ]);
    const outcome = traceRequest(graph, { method: 'GET', path: '/x' });
    if (!outcome.found) throw new Error('expected a match');
    expect(nameOf(graph, outcome.trace).slice(0, 4)).toEqual(['aws_route53_record.dns', 'aws_cloudfront_distribution.cdn', 'aws_apigatewayv2_api.a', 'aws_apigatewayv2_route.r']);
    expect(outcome.trace.steps.map((s) => s.phase).slice(0, 4)).toEqual(['front_door', 'front_door', 'api', 'route']);
  });

  it('reports a gap instead of guessing when the integration is not a Lambda', async () => {
    const graph = await graphOf([
      {
        path: 'main.tf',
        content: `
resource "aws_apigatewayv2_api" "a" { name = "a" }
resource "aws_apigatewayv2_integration" "proxy" {
  api_id          = aws_apigatewayv2_api.a.id
  integration_uri = "https://backend.example.com"
}
resource "aws_apigatewayv2_route" "r" {
  api_id    = aws_apigatewayv2_api.a.id
  route_key = "GET /x"
  target    = "integrations/\${aws_apigatewayv2_integration.proxy.id}"
}`,
      },
    ]);
    const outcome = traceRequest(graph, { method: 'GET', path: '/x' });
    if (!outcome.found) throw new Error('expected a match');
    expect(nameOf(graph, outcome.trace)).toEqual(['aws_apigatewayv2_api.a', 'aws_apigatewayv2_route.r']);
    expect(outcome.trace.gaps[0]).toContain('does not point at a Lambda function');
  });

  it('reports a gap when the handler code can not be found', async () => {
    const graph = await graphOf([
      {
        path: 'main.tf',
        content: `
resource "aws_lambda_function" "fn" {
  function_name = "fn"
  handler       = "index.handler"
  runtime       = "nodejs20.x"
}
resource "aws_lambda_function_url" "u" { function_name = aws_lambda_function.fn.function_name }`,
      },
      { path: 'a/index.js', content: 'exports.handler = async () => {};' },
      { path: 'b/index.js', content: 'exports.handler = async () => {};' },
    ]);
    const outcome = traceRequest(graph, { method: 'GET', path: '/anything/at/all' });
    if (!outcome.found) throw new Error('expected a match');
    expect(nameOf(graph, outcome.trace)).toEqual(['aws_lambda_function_url.u', 'aws_lambda_function.fn']);
    expect(outcome.trace.gaps.join(' ')).toContain('No code is mapped to aws_lambda_function.fn');
  });

  it('traces a REST API method from CDK synth output, resolving the cross-stack table', async () => {
    const graph = await graphOf(loadFixture('cdk-synth'));
    const outcome = traceRequest(graph, { method: 'GET', path: '/orders/7' });
    if (!outcome.found) throw new Error('expected a match');
    expect(outcome.trace.match).toMatchObject({ kind: 'rest_api', path: '/orders/{id}', pathParams: { id: '7' } });
    expect(nameOf(graph, outcome.trace)).toEqual(expect.arrayContaining(['aws_dynamodb_table.DataStack_OrdersTableABC12345']));
  });

  it('lets the caller pick between equally good endpoints', async () => {
    const graph = await graphOf(loadFixture('demo'));
    const [first] = listEndpoints(graph);
    const outcome = traceRequest(graph, { method: 'GET', path: '/not/the/same', endpointId: first!.id });
    if (!outcome.found) throw new Error('expected a match');
    expect(outcome.trace.match.endpointId).toBe(first!.id);
    expect(traceRequest(graph, { method: 'GET', path: '/x', endpointId: 'no-such-endpoint' })).toMatchObject({ found: false, reason: 'unknown_endpoint' });
  });

  it('says what it knows when nothing matches, or when there are no endpoints at all', async () => {
    const graph = await graphOf(loadFixture('demo'));
    const miss = traceRequest(graph, { method: 'GET', path: '/orderz/1' });
    expect(miss).toMatchObject({ found: false, reason: 'no_match' });
    if (!miss.found) expect(miss.closest.length).toBeGreaterThan(0);
    const bare = await graphOf([{ path: 'main.tf', content: 'resource "aws_sqs_queue" "q" { name = "q" }' }]);
    expect(traceRequest(bare, { method: 'GET', path: '/' })).toMatchObject({ found: false, reason: 'no_endpoints' });
  });

  it('terminates when queues feed each other, and caps very long traces', async () => {
    const buckets = Array.from({ length: 80 }, (_, i) => `await c.send(new PutObjectCommand({ Bucket: 'bucket-${i}', Key: 'k' }));`).join('\n  ');
    const graph = await graphOf([
      {
        path: 'main.tf',
        content: `
resource "aws_sqs_queue" "a" { name = "a" }
resource "aws_sqs_queue" "b" { name = "b" }
resource "aws_lambda_function" "one" {
  function_name = "one"
  handler       = "one.handler"
  runtime       = "nodejs20.x"
  filename      = "x.zip"
  environment { variables = { OUT = aws_sqs_queue.b.url, IN = aws_sqs_queue.a.url } }
}
resource "aws_lambda_function" "two" {
  function_name = "two"
  handler       = "two.handler"
  runtime       = "nodejs20.x"
  filename      = "x.zip"
  environment { variables = { OUT = aws_sqs_queue.a.url } }
}
resource "aws_lambda_event_source_mapping" "m1" {
  event_source_arn = aws_sqs_queue.a.arn
  function_name    = aws_lambda_function.one.arn
}
resource "aws_lambda_event_source_mapping" "m2" {
  event_source_arn = aws_sqs_queue.b.arn
  function_name    = aws_lambda_function.two.arn
}
resource "aws_lambda_function_url" "u" { function_name = aws_lambda_function.one.function_name }`,
      },
      { path: 'one.js', content: `exports.handler = async () => {\n  await c.send(new SendMessageCommand({ QueueUrl: process.env.OUT }));\n  ${buckets}\n};` },
      { path: 'two.js', content: "exports.handler = async () => { await c.send(new SendMessageCommand({ QueueUrl: process.env.OUT })); };" },
    ]);
    const outcome = traceRequest(graph, { method: 'GET', path: '/' });
    if (!outcome.found) throw new Error('expected a match');
    expect(outcome.trace.truncated).toBe(true);
    expect(outcome.trace.steps.length).toBeLessThanOrEqual(60);
    expect(new Set(outcome.trace.steps.map((s) => s.nodeId)).size).toBe(outcome.trace.steps.length); // never visits a node twice
    expect(outcome.trace.summary).toContain('cut short');
  });

  it('answers "what happens on POST /orders" through the graph query used by Ask and voice', async () => {
    const graph = await graphOf(loadFixture('demo'));
    const result = runGraphQuery(graph, { op: 'endpoint', node: 'POST /orders' }, { findings: [] });
    expect(result.summary).toContain('POST /orders is handled by POST /orders');
    expect(result.results[0]!.distance).toBe(1);
    expect(result.results.map((r) => r.node.address)).toContain('aws_dynamodb_table.orders');
    expect(runGraphQuery(graph, { op: 'endpoint', node: 'orders' }, { findings: [] }).summary).toContain('method and a path');
    expect(runGraphQuery(graph, { op: 'endpoint', node: 'GET /nope' }, { findings: [] }).summary).toContain('No endpoint matches');
  });

  it('keeps the trace deterministic', async () => {
    const graph = await graphOf(loadFixture('cfn'));
    const a = traceRequest(graph, { method: 'DELETE', path: '/orders/1' });
    const b = traceRequest(graph, { method: 'DELETE', path: '/orders/1' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const direct = listEndpoints(graph).find((e) => e.method === 'DELETE')!;
    expect(traceEndpoint(graph, direct, { method: 'DELETE', path: '/orders/1' }).steps.length).toBeGreaterThan(5);
  });
});
