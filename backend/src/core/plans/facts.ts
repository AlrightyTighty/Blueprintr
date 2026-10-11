import type { PlanChangeRow } from '../../repositories/plans.js';
import type { Graph, GraphNode } from '../graph/types.js';

/** Resource types that hold data, where replace/destroy can mean data loss. */
const DATA_BEARING = new Set([
  'aws_dynamodb_table',
  'aws_s3_bucket',
  'aws_sqs_queue',
  'aws_db_instance',
  'aws_rds_cluster',
  'aws_efs_file_system',
  'aws_kinesis_stream',
]);

export interface RiskyChange {
  address: string;
  terraformType: string | null;
  action: 'replace' | 'destroy';
  dataBearing: boolean;
  /** Code that reads, writes or publishes to it, by function/file address. */
  readers: string[];
  writers: string[];
  publishers: string[];
  /** Other resources that depend on it (roles, Lambdas, ...). */
  dependentResources: string[];
}

export interface PlanFacts {
  counts: { create: number; update: number; replace: number; destroy: number; downstream: number };
  risky: RiskyChange[];
  downstreamCode: string[];
  recommendation: 'proceed' | 'caution' | 'stop';
  /** One line per reason, for the briefing and the explanation. */
  reasons: string[];
}

const label = (node: GraphNode | undefined, fallback: string) => node?.address ?? fallback;

/** Deterministic facts about a plan; the AI text is written from these, never instead of them. */
export function planFacts(graph: Graph, changes: PlanChangeRow[]): PlanFacts {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const counts = { create: 0, update: 0, replace: 0, destroy: 0, downstream: 0 };
  for (const change of changes) {
    if (change.impact === 'downstream') counts.downstream++;
    else if (change.action !== 'noop') counts[change.action]++;
  }

  const risky: RiskyChange[] = [];
  for (const change of changes) {
    if (change.impact !== 'direct' || (change.action !== 'replace' && change.action !== 'destroy')) continue;
    const node = change.nodeId ? nodes.get(change.nodeId) : undefined;
    const incoming = node ? graph.edges.filter((e) => e.target === node.id) : [];
    const from = (relation: string) =>
      incoming.filter((e) => e.relation === relation).map((e) => label(nodes.get(e.source), e.source));
    const codeKinds = new Set(['code_function', 'code_file']);
    const codeBy = (relation: string) =>
      incoming
        .filter((e) => e.relation === relation && codeKinds.has(nodes.get(e.source)?.kind ?? ''))
        .map((e) => label(nodes.get(e.source), e.source));
    risky.push({
      address: change.address,
      terraformType: change.terraformType,
      action: change.action,
      dataBearing: DATA_BEARING.has(change.terraformType ?? ''),
      readers: codeBy('reads'),
      writers: codeBy('writes'),
      publishers: codeBy('publishes'),
      dependentResources: [
        ...new Set(
          incoming.flatMap((e) => {
            const source = nodes.get(e.source);
            return source?.kind === 'resource' ? [source.address] : [];
          }),
        ),
      ],
    });
  }

  const downstreamCode = changes
    .filter((c) => c.impact === 'downstream' && c.nodeId && nodes.get(c.nodeId)?.kind === 'code_function')
    .map((c) => c.address);

  const reasons: string[] = [];
  for (const item of risky) {
    const users = [...new Set([...item.readers, ...item.writers, ...item.publishers])];
    const verb = item.action === 'destroy' ? 'destroys' : 'replaces';
    const data = item.dataBearing ? (item.action === 'destroy' ? ' Its data would be deleted.' : ' A replacement starts empty unless the data is migrated first.') : '';
    const code = users.length > 0 ? ` It is used by ${users.length} code ${users.length === 1 ? 'path' : 'paths'}: ${item.readers.length} read, ${item.writers.length} write, ${item.publishers.length} publish.` : '';
    reasons.push(`The plan ${verb} ${item.address}.${data}${code}`);
  }

  let recommendation: PlanFacts['recommendation'] = 'proceed';
  if (risky.length > 0) recommendation = risky.some((r) => r.dataBearing || r.readers.length + r.writers.length + r.publishers.length > 0) ? 'stop' : 'caution';
  else if (changes.some((c) => c.impact === 'direct' && c.action === 'update' && /^aws_iam_/.test(c.terraformType ?? ''))) {
    recommendation = 'caution';
    reasons.push('The plan changes IAM permissions; confirm the code keeps the access it needs.');
  }
  return { counts, risky, downstreamCode, recommendation, reasons };
}
