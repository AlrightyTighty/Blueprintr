// Graph, findings, plan and AI calls for one project. Each function calls the real endpoint from
// backend/openapi.yaml, or uses bundled demo data for the demo project (see config.ts).
import { apiGet, apiPost } from '../api';
import { isDemoProject } from '../config';
import { demoFindings, demoGraph } from '../demo/demoData';
import type {
  AskResult,
  Briefing,
  Finding,
  Graph,
  Page,
  PlanAnalysisDetail,
  PlanChange,
  PlanExplanation,
} from '../core/graph/types';
import { answerOffline, createOfflineBriefing, createOfflineExplanation } from './mockAi';

/** AI results carry whether they came from the offline stand-ins, so the UI can say so. */
export interface AiResult<Data> {
  data: Data;
  isOffline: boolean;
}

/** What the AI features need to know about the loaded graph and plan. */
export interface PlanContext {
  projectId: string;
  graph: Graph;
  planChanges: PlanChange[];
  /** Null for a plan analysed locally, which the backend knows nothing about. */
  planId: string | null;
}

export async function fetchGraph(projectId: string): Promise<Graph> {
  if (isDemoProject(projectId)) return demoGraph;
  return apiGet<Graph>(`/projects/${projectId}/runs/current/graph`);
}

export async function fetchFindings(projectId: string, runId: string): Promise<Finding[]> {
  if (isDemoProject(projectId)) return demoFindings;

  const findings: Finding[] = [];
  let cursor: string | null = null;
  do {
    const query: string = `?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page: Page<Finding> = await apiGet<Page<Finding>>(
      `/projects/${projectId}/runs/${runId}/findings${query}`,
    );
    findings.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return findings;
}

/** Uploads plan JSON for server-side analysis. The caller falls back to local analysis on failure. */
export function uploadPlan(projectId: string, planJsonText: string): Promise<PlanAnalysisDetail> {
  return apiPost<PlanAnalysisDetail>(`/projects/${projectId}/runs/current/plans`, JSON.parse(planJsonText));
}

function usesOfflineStandIn(context: PlanContext): boolean {
  return isDemoProject(context.projectId) || context.planId === null;
}

export async function explainPlan(context: PlanContext): Promise<AiResult<PlanExplanation>> {
  if (usesOfflineStandIn(context)) {
    return { data: createOfflineExplanation(context.planChanges), isOffline: true };
  }
  const data = await apiPost<PlanExplanation>(`/projects/${context.projectId}/plans/${context.planId}/explain`);
  return { data, isOffline: false };
}

export async function createBriefing(context: PlanContext): Promise<AiResult<Briefing>> {
  if (usesOfflineStandIn(context)) {
    return { data: createOfflineBriefing(context.planChanges), isOffline: true };
  }
  const data = await apiPost<Briefing>(`/projects/${context.projectId}/plans/${context.planId}/briefing`);
  return { data, isOffline: false };
}

export async function askQuestion(question: string, context: PlanContext): Promise<AiResult<AskResult>> {
  if (isDemoProject(context.projectId)) {
    return { data: answerOffline(context.graph, question), isOffline: true };
  }
  const data = await apiPost<AskResult>(`/projects/${context.projectId}/ask`, {
    question,
    runId: 'current',
    ...(context.planId ? { planId: context.planId } : {}),
  });
  return { data, isOffline: false };
}
