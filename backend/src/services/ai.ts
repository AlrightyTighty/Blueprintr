import { getPool } from '../db/pool.js';
import { forbidden, notConfigured, notFound } from '../http/errors.js';
import { planFacts, type PlanFacts } from '../core/plans/facts.js';
import type { FunctionDeclaration, GeminiContent } from '../integrations/gemini.js';
import { integrations } from '../integrations/registry.js';
import { signToken } from '../lib/jwt.js';
import * as graphRepo from '../repositories/graph.js';
import * as members from '../repositories/projectMembers.js';
import * as projects from '../repositories/projects.js';
import * as plans from '../repositories/plans.js';
import type { PlanRow } from '../repositories/plans.js';
import { requireProject, type Actor } from './access.js';
import { resolveReadyRun } from './analysis.js';
import { queryGraphForRun } from './graph.js';
import type { QueryRequest } from '../core/graph/query.js';

type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface PlanExplanation {
  explanation: string;
  risks: { address: string; severity: Severity; summary: string }[];
  saferAlternatives: { address: string; suggestion: string }[];
  model: string;
  generatedAt: string;
}

const PERSONA =
  'You are an on-call infrastructure engineer: steady, unhurried, plain-spoken, and never alarmist. ' +
  'You only state what the supplied facts support, and you say so when something is uncertain. ' +
  'Links marked "inferred" are guesses by a model, so treat them as such.';

// ---- shared loading --------------------------------------------------------------------------------------------------

async function loadPlan(actor: Actor, projectId: string, planId: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'editor' });
  const plan = await plans.findById(db, projectId, planId);
  if (!plan) throw notFound('Plan');
  const run = await resolveReadyRun(db, project, plan.runId);
  const [graph, changes] = await Promise.all([graphRepo.loadGraph(db, run.id, run.commitSha), plans.listChanges(db, plan.id)]);
  return { db, project, plan, run, graph, changes, facts: planFacts(graph, changes) };
}

// ---- plan explanation ---------------------------------------------------------------------------------------------------

function ruleBasedExplanation(facts: PlanFacts): Omit<PlanExplanation, 'generatedAt'> {
  const severityFor = (r: PlanFacts['risky'][number]): Severity => (r.action === 'destroy' && r.dataBearing ? 'critical' : r.dataBearing ? 'high' : 'medium');
  return {
    explanation: facts.reasons.length > 0 ? facts.reasons.join(' ') : 'This plan makes no destructive changes, and nothing downstream of it is affected.',
    risks: facts.risky.map((r) => ({
      address: r.address,
      severity: severityFor(r),
      summary: `${r.action === 'destroy' ? 'Destroyed' : 'Replaced'}; ${r.readers.length} reading, ${r.writers.length} writing and ${r.publishers.length} publishing code paths depend on it.`,
    })),
    saferAlternatives: facts.risky.map((r) => ({
      address: r.address,
      suggestion:
        r.action === 'destroy'
          ? 'Add lifecycle { prevent_destroy = true } until the code that uses it is gone, and take a backup first.'
          : r.dataBearing
            ? 'Stage the change: create the new resource, migrate the data, switch the code over, then remove the old one. create_before_destroy alone does not copy data.'
            : 'Use lifecycle { create_before_destroy = true } so the old resource keeps serving until the new one is ready.',
    })),
    model: 'rule-based',
  };
}

const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    explanation: { type: 'string', description: 'Two to four plain sentences on what this plan does to the running system.' },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'] },
          summary: { type: 'string' },
        },
        required: ['address', 'severity', 'summary'],
      },
    },
    saferAlternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: { address: { type: 'string' }, suggestion: { type: 'string' } },
        required: ['address', 'suggestion'],
      },
    },
  },
  required: ['explanation', 'risks', 'saferAlternatives'],
};

export async function explainPlan(actor: Actor, projectId: string, planId: string, refresh: boolean): Promise<PlanExplanation> {
  const { db, plan, facts } = await loadPlan(actor, projectId, planId);
  if (plan.aiExplanation && !refresh) return JSON.parse(plan.aiExplanation) as PlanExplanation;

  const gemini = integrations().gemini;
  let result: Omit<PlanExplanation, 'generatedAt'>;
  if (gemini.isConfigured()) {
    const response = await gemini.generate({
      system:
        `${PERSONA} Review a Terraform plan for the team applying it. Explain what it does to the running system in plain English, ` +
        'name the specific risks (data loss, code that will break, permissions that disappear), and suggest safer alternatives such as ' +
        'create_before_destroy, prevent_destroy or a staged migration. Use the resource addresses exactly as given.',
      jsonSchema: EXPLAIN_SCHEMA,
      contents: [{ role: 'user', parts: [{ text: JSON.stringify({ counts: facts.counts, risky: facts.risky, downstreamCode: facts.downstreamCode, recommendation: facts.recommendation }) }] }],
    });
    const parsed = JSON.parse(response.text ?? '{}') as Partial<PlanExplanation>;
    result = {
      explanation: parsed.explanation ?? ruleBasedExplanation(facts).explanation,
      risks: parsed.risks ?? [],
      saferAlternatives: parsed.saferAlternatives ?? [],
      model: gemini.model,
    };
  } else {
    result = ruleBasedExplanation(facts);
  }
  const explanation: PlanExplanation = { ...result, generatedAt: new Date().toISOString() };
  await plans.setExplanation(db, plan.id, JSON.stringify(explanation));
  return explanation;
}

// ---- voice briefing ---------------------------------------------------------------------------------------------------------

const RECOMMENDATION_LINE: Record<PlanFacts['recommendation'], string> = {
  stop: "I'd stop here and sort out the data and the code that depends on it before applying.",
  caution: "I'd go carefully and double-check the items above before applying.",
  proceed: 'Nothing here looks risky to me. This one looks safe to apply.',
};

function ruleBasedScript(facts: PlanFacts): string {
  const { counts } = facts;
  const parts: string[] = [];
  const changes = [
    counts.create && `creates ${counts.create}`,
    counts.update && `modifies ${counts.update}`,
    counts.replace && `replaces ${counts.replace}`,
    counts.destroy && `destroys ${counts.destroy}`,
  ].filter(Boolean);
  parts.push(changes.length > 0 ? `This plan ${changes.join(', ')}.` : 'This plan changes nothing.');
  parts.push(...facts.reasons.slice(0, 3));
  if (facts.downstreamCode.length > 0) parts.push(`${facts.downstreamCode.length} code paths sit downstream of those changes.`);
  parts.push(RECOMMENDATION_LINE[facts.recommendation]);
  return parts.join(' ');
}

async function writeScript(facts: PlanFacts): Promise<string> {
  const gemini = integrations().gemini;
  if (!gemini.isConfigured()) return ruleBasedScript(facts);
  const response = await gemini.generate({
    system:
      `${PERSONA} Write a spoken pre-flight briefing, 60 to 110 words, to be read aloud before someone runs terraform apply. ` +
      'Plain sentences only: no markdown, no bullet points, no resource addresses spelled character by character (say "the orders table"). ' +
      'Say what changes, what depends on it, and end with your recommendation, matching the recommendation field exactly (stop, caution or proceed). ' +
      'Example of the right tone: "This plan replaces one resource and modifies three. The replaced table is read by two functions and written by one. I\'d stop here."',
    temperature: 0.4,
    contents: [{ role: 'user', parts: [{ text: JSON.stringify({ counts: facts.counts, risky: facts.risky, recommendation: facts.recommendation, downstreamCodeCount: facts.downstreamCode.length }) }] }],
  });
  return (response.text ?? ruleBasedScript(facts)).replace(/[*_`#]/g, '').trim();
}

export async function createBriefing(actor: Actor, projectId: string, planId: string, refresh: boolean) {
  const { db, plan, facts } = await loadPlan(actor, projectId, planId);
  const { elevenlabs, audio } = integrations();
  if (!audio.isConfigured()) throw notConfigured('Audio storage');
  if (!elevenlabs.isConfigured()) throw notConfigured('ElevenLabs');

  let script = plan.briefingScript;
  let key = plan.briefingAudioKey;
  if (!script || !key || refresh) {
    script = await writeScript(facts);
    key = `briefings/${projectId}/${planId}.mp3`;
    await audio.put(key, await elevenlabs.synthesize(script));
    await plans.setBriefing(db, planId, { script, audioKey: key });
  }
  const ttl = 15 * 60;
  return {
    script,
    audioUrl: await audio.signedUrl(key, ttl),
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
    recommendation: facts.recommendation,
  };
}

// ---- Q&A over the graph (Gemini function calling) --------------------------------------------------------------------------------

const GRAPH_TOOL: FunctionDeclaration = {
  name: 'graph_query',
  description:
    'Query the analyzed code and infrastructure graph. Use "touches" to see what code and roles use a resource (or what resources a function uses), ' +
    '"dependents" for everything that would be affected if a node changed, "dependencies" for what a node relies on, ' +
    '"path" to see how two nodes connect, and "findings" for problems attached to a node.',
  parameters: {
    type: 'object',
    properties: {
      op: { type: 'string', enum: ['touches', 'dependents', 'dependencies', 'path', 'findings'] },
      node: { type: 'string', description: 'A resource or code name or address, e.g. "orders" or "aws_dynamodb_table.orders".' },
      to: { type: 'string', description: 'Second node, only for op=path.' },
      maxDepth: { type: 'integer', description: 'How many hops to follow, default 10.' },
    },
    required: ['op', 'node'],
  },
};

export async function ask(actor: Actor, projectId: string, input: { question: string; runId: string; planId?: string }) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'editor' }); // permissions before configuration
  const gemini = integrations().gemini;
  if (!gemini.isConfigured()) throw notConfigured('Gemini');
  const run = await resolveReadyRun(db, project, input.runId);
  const graph = await graphRepo.loadGraph(db, run.id, run.commitSha);
  let planContext = '';
  if (input.planId) {
    const plan = await plans.findById(db, projectId, input.planId);
    if (!plan) throw notFound('Plan');
    planContext = ` A Terraform plan is loaded: ${JSON.stringify(plan.summary)}. Query results mark affected nodes with [plan: ...].`;
  }

  const contents: GeminiContent[] = [{ role: 'user', parts: [{ text: input.question }] }];
  const toolCalls: { op: string; node: string }[] = [];
  const cited = new Set<string>();
  const system =
    `${PERSONA} You answer questions about one project's code and AWS infrastructure. Answer ONLY from graph_query results; never guess or use outside knowledge about this project. ` +
    `If the tool finds nothing, say so. Name resources by their address. Mention when a link is "inferred". Keep answers under 120 words, plain text.${planContext}`;

  for (let turn = 0; turn < 6; turn++) {
    const response = await gemini.generate({ system, contents, tools: [GRAPH_TOOL], temperature: 0 });
    if (response.functionCalls.length === 0) {
      return { answer: response.text ?? "I couldn't work out an answer from the graph.", citedNodeIds: [...cited], toolCalls };
    }
    contents.push(response.content);
    const parts = [];
    for (const call of response.functionCalls) {
      const args = call.args as Partial<QueryRequest>;
      const request: QueryRequest = { op: (args.op ?? 'touches') as QueryRequest['op'], node: String(args.node ?? ''), to: args.to ? String(args.to) : undefined, maxDepth: args.maxDepth ? Number(args.maxDepth) : undefined };
      toolCalls.push({ op: request.op, node: request.node });
      const result = await queryGraphForRun(graph, run.id, request, input.planId);
      for (const n of result.resolved) cited.add(n.id);
      for (const r of result.results) cited.add(r.node.id);
      parts.push({
        functionResponse: {
          name: call.name,
          response: {
            summary: result.summary,
            nodes: result.results.slice(0, 40).map((r) => ({ address: r.node.address, kind: r.node.kind, distance: r.distance, weakestConfidence: r.weakestConfidence })),
            findings: result.findings.slice(0, 10).map((f) => ({ severity: f.severity, kind: f.kind, title: f.title })),
          },
        },
      });
    }
    contents.push({ role: 'user', parts });
  }
  return { answer: "I couldn't settle on an answer within the allowed number of lookups. Try a narrower question.", citedNodeIds: [...cited], toolCalls };
}

// ---- voice agent ---------------------------------------------------------------------------------------------------------------------------

const SESSION_MINUTES = 15;

export async function createVoiceSession(actor: Actor, projectId: string, input: { runId: string; planId?: string }) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'editor' });
  const run = await resolveReadyRun(db, project, input.runId);
  let plan: PlanRow | null = null;
  if (input.planId) {
    plan = await plans.findById(db, projectId, input.planId);
    if (!plan) throw notFound('Plan');
  }
  const { signedUrl, agentId } = await integrations().elevenlabs.getSignedUrl();
  const { token } = await signToken('voice_tool', { pid: projectId, rid: run.id, plan: plan?.id ?? null }, SESSION_MINUTES * 60 * 2, actor.userId!);
  return {
    signedUrl,
    agentId,
    expiresAt: new Date(Date.now() + SESSION_MINUTES * 60 * 1000).toISOString(),
    toolToken: token,
    dynamicVariables: {
      project_name: project.name,
      run_id: run.id,
      commit: run.commitSha?.slice(0, 7) ?? 'unknown',
      plan_summary: plan ? JSON.stringify(plan.summary) : 'no plan loaded',
    },
  };
}

export interface VoiceToolClaims {
  sub?: string;
  pid: string;
  rid: string;
  plan: string | null;
}

/** Called by the ElevenLabs agent. The token pins project, run and plan; the request can only narrow it. */
export async function voiceGraphQuery(claims: VoiceToolClaims, request: QueryRequest & { runId?: string; planId?: string }) {
  const db = getPool();
  const project = await projects.findById(db, claims.pid);
  if (!project || project.deletedAt || !claims.sub) throw notFound('Project');
  const role = await members.getRole(db, claims.pid, claims.sub);
  if (!role || role === 'viewer') throw forbidden('The user who started this voice session no longer has access.');
  const run = await resolveReadyRun(db, project, request.runId ?? claims.rid);
  const graph = await graphRepo.loadGraph(db, run.id, run.commitSha);
  return queryGraphForRun(graph, run.id, request, request.planId ?? claims.plan);
}

