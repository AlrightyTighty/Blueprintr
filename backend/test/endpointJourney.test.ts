import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis/pipeline.js';
import { traceRequest, type EndpointTrace } from '../src/core/endpoints/trace.js';
import type { Graph } from '../src/core/graph/types.js';
import { buildEndpointJourney } from '../../frontend/src/core/journeys/endpointJourney';
import { loadFixture } from './helpers.js';

// The tour for a "called" endpoint is built in the frontend from the trace the backend returns.
// These tests use real analysis output, so the two sides are checked against each other.
async function setup() {
  const out = await analyze({ files: loadFixture('demo') });
  const graph = { runId: 'run', commitSha: null, nodes: out.nodes.map((n) => ({ ...n, resourceType: null })), edges: out.edges } as unknown as Graph;
  const findings = out.findings.map((f, i) => ({ ...f, id: `f${i}`, runId: 'run', fingerprint: `f${i}` })) as never;
  const trace = (method: string, path: string): EndpointTrace => {
    const outcome = traceRequest(graph, { method, path });
    if (!outcome.found) throw new Error('no match');
    return outcome.trace;
  };
  const address = (id: string) => graph.nodes.find((n) => n.id === id)!.address;
  return { graph, findings, trace, address };
}

describe('endpoint tour', async () => {
  const { graph, findings, trace, address } = await setup();

  it('is one stop per step, in request order, titled with the call', () => {
    const t = trace('POST', '/orders');
    const journey = buildEndpointJourney(graph, findings, t);
    expect(journey).toMatchObject({ kind: 'endpoint', title: 'Follow POST /orders' });
    expect(journey.stops.map((s) => s.nodeId)).toEqual(t.steps.map((s) => s.nodeId));
    expect(address(journey.stops[0]!.nodeId)).toBe('aws_apigatewayv2_api.http');
  });

  it('opens by naming the call and says which route matched, with the path parameters', () => {
    const journey = buildEndpointJourney(graph, findings, trace('GET', '/orders/abc'));
    expect(journey.stops[0]!.script.startsWith('You call GET /orders/abc.')).toBe(true);
    const route = journey.stops[1]!.script;
    expect(route).toContain('The request matches the HTTP API route GET /orders/{id}.');
    expect(route).toContain('Here {id} is abc.');
  });

  it('shows a function with its own lines of code, and the call that reached it', () => {
    const journey = buildEndpointJourney(graph, findings, trace('GET', '/orders/1'));
    const stop = journey.stops.find((s) => address(s.nodeId) === 'src/api/app.js::getOrder')!;
    expect(stop.script).toContain('calls the function getOrder');
    const node = graph.nodes.find((n) => n.address === 'src/api/app.js::getOrder')!;
    expect(stop.codeRefs).toEqual([{ file: 'src/api/app.js', startLine: node.lineStart, endLine: node.lineEnd }]);
  });

  it('shows the exact lines where code touches a resource, and everyone who touches it', () => {
    const journey = buildEndpointJourney(graph, findings, trace('POST', '/orders'));
    const table = journey.stops.find((s) => address(s.nodeId) === 'aws_dynamodb_table.orders')!;
    expect(table.script).toContain('writes to the DynamoDB table orders');
    expect(table.script).toMatch(/saveOrder.* too/);
    expect(table.script).toContain('too, later, in the background'); // the worker also writes it
    expect(table.codeRefs.length).toBeGreaterThanOrEqual(3);
    expect(table.codeRefs.every((r) => r.startLine === r.endLine && r.file.length > 0)).toBe(true);
  });

  it('puts the findings that matter on the stops they belong to, with punctuation', () => {
    const journey = buildEndpointJourney(graph, findings, trace('DELETE', '/orders/1'));
    const cancel = journey.stops.find((s) => address(s.nodeId) === 'src/api/app.js::cancelOrder')!;
    expect(cancel.warnings.join(' ')).toContain('dynamodb:DeleteItem');
    expect(cancel.script).toMatch(/Watch your step: .*doesn't allow it\./);
    const lambda = journey.stops.find((s) => address(s.nodeId) === 'aws_lambda_function.api')!;
    expect(lambda.script).not.toMatch(/it Watch your step/); // each warning is its own sentence
  });

  it('says when the request carries on in the background, and when the handler is shared', () => {
    const journey = buildEndpointJourney(graph, findings, trace('POST', '/orders'));
    const firstAsync = journey.stops.find((s) => address(s.nodeId) === 'aws_lambda_function.worker')!;
    expect(firstAsync.script).toContain('already has its answer');
    expect(firstAsync.script).toContain('carries on in the background');
    const handler = journey.stops.find((s) => address(s.nodeId) === 'src/api/app.js::handler')!;
    expect(handler.script).toContain('One honest note:');
    expect(handler.script).toContain('serves 5 endpoints through one handler');
    expect(journey.stops.filter((s) => s.script.includes('already has its answer'))).toHaveLength(1);
  });

  it('marks inferred hops so the guide never sounds surer than the graph is', () => {
    const t = trace('GET', '/orders/1');
    const readIndex = t.steps.findIndex((s) => s.phase === 'data');
    const inferred: EndpointTrace = {
      ...t,
      steps: t.steps.map((s, i) => (i === readIndex ? { ...s, confidence: 'inferred', uses: s.uses.map((u) => ({ ...u, confidence: 'inferred' })) } : s)),
    };
    const journey = buildEndpointJourney(graph, findings, inferred);
    expect(journey.stops[readIndex]!.inferred).toBe(true);
    expect(journey.stops[readIndex]!.script).toContain('inferred');
    expect(journey.stops.filter((s) => s.inferred)).toHaveLength(1);
  });

  it('closes with what it could not follow', () => {
    const t = trace('GET', '/orders/1');
    const journey = buildEndpointJourney(graph, findings, { ...t, gaps: [...t.gaps, 'No code is mapped to something.'], truncated: true });
    const last = journey.stops[journey.stops.length - 1]!.script;
    expect(last).toContain('One honest note: No code is mapped to something.');
    expect(last).toContain('stops here because the request goes much deeper');
  });

  it('only cites files and lines that exist', async () => {
    const files = new Map(loadFixture('demo').map((f) => [f.path, f.content.split('\n').length]));
    for (const [method, path] of [['POST', '/orders'], ['GET', '/orders/1'], ['DELETE', '/orders/1'], ['PUT', '/uploads/x'], ['POST', '/reports']] as const) {
      for (const stop of buildEndpointJourney(graph, findings, trace(method, path)).stops) {
        for (const ref of stop.codeRefs) {
          const length = files.get(ref.file.split('\\').join('/'));
          expect(length, `${method} ${path}: ${ref.file}`).toBeDefined();
          expect(ref.startLine).toBeGreaterThanOrEqual(1);
          expect(ref.endLine).toBeLessThanOrEqual(length!);
        }
      }
    }
  });
});
