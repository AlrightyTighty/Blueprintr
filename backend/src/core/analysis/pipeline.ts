import type { GeminiClient } from '../../integrations/gemini.js';
import type { NewEdge, NewNode } from '../../repositories/graph.js';
import type { NewFinding } from '../../repositories/findings.js';
import { scanCode, languageOf } from '../code/scan.js';
import { parseTerraform, type SourceFile } from '../terraform/model.js';
import { computeFindings, unresolvedCallFindings } from './findings.js';
import { inferPendingCalls, type InferenceStats } from './inference.js';
import { linkGraph } from './link.js';

/** Bump when the analysis output changes, so old runs can be told apart from new ones. */
export const PARSER_VERSION = '0.1.0';

export type AnalysisStage = 'parsing_terraform' | 'scanning_code' | 'linking' | 'inferring' | 'findings';

export interface PipelineInput {
  files: SourceFile[];
  /** Used for method 4 (inference). Omit, or pass an unconfigured client, to skip it. */
  gemini?: GeminiClient | null;
  onStage?: (stage: AnalysisStage) => Promise<void> | void;
}

export interface PipelineOutput {
  nodes: NewNode[];
  edges: NewEdge[];
  findings: NewFinding[];
  stats: Record<string, unknown>;
}

const countBy = <T>(items: T[], key: (item: T) => string) => {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
};

/**
 * Terraform + app code in, graph and findings out. Pure static analysis: files are only read as
 * text, nothing is executed, and no file contents leave this function except (optionally) the few
 * functions sent to Gemini for inference.
 */
export async function analyze(input: PipelineInput): Promise<PipelineOutput> {
  const stage = async (s: AnalysisStage) => void (await input.onStage?.(s));

  await stage('parsing_terraform');
  const model = await parseTerraform(input.files);

  await stage('scanning_code');
  const facts = scanCode(input.files.filter((f) => languageOf(f.path)));

  await stage('linking');
  const link = linkGraph(model, facts);

  await stage('inferring');
  const inference = await inferPendingCalls(link, input.gemini ?? null);

  await stage('findings');
  const findings = [...computeFindings(link), ...unresolvedCallFindings(link, inference.unresolved)];

  const nodes = [...link.builder.nodes.values()];
  const edges = link.builder.edges;
  const stats = {
    terraformFiles: input.files.filter((f) => f.path.endsWith('.tf')).length,
    codeFiles: facts.files.length,
    terraformResources: model.resources.length,
    nodes: nodes.length,
    nodesByKind: countBy(nodes, (n) => n.kind),
    edges: edges.length,
    edgesByMethod: countBy(edges, (e) => e.linkMethod),
    inferredEdges: edges.filter((e) => e.confidence === 'inferred').length,
    findings: findings.length,
    findingsByKind: countBy(findings, (f) => f.kind),
    inference: inference.stats satisfies InferenceStats,
  };
  return { nodes, edges, findings, stats };
}
