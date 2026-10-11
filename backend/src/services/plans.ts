import { getPool, withTransaction } from '../db/pool.js';
import { notFound } from '../http/errors.js';
import { overlayPlan, parsePlanJson } from '../core/plans/overlay.js';
import * as activity from '../repositories/activity.js';
import * as graphRepo from '../repositories/graph.js';
import * as plans from '../repositories/plans.js';
import { requireProject, type Actor } from './access.js';
import { resolveReadyRun } from './analysis.js';
import { toPlan, toPlanDetail } from './presenters.js';

/**
 * Overlays a `terraform show -json` plan on a run. The JSON is parsed in memory and dropped:
 * only addresses, actions and changed attribute names are stored, never values.
 */
export async function uploadPlan(actor: Actor, projectId: string, runRef: string, planJson: unknown) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'editor' });
  const run = await resolveReadyRun(db, project, runRef);
  const parsed = parsePlanJson(planJson);
  const graph = await graphRepo.loadGraph(db, run.id, run.commitSha);
  const overlay = overlayPlan(graph, parsed);

  const planId = await withTransaction(async (tx) => {
    const id = await plans.create(tx, { projectId, runId: run.id, createdBy: actor.userId!, terraformVersion: parsed.terraformVersion, summary: overlay.summary });
    await plans.insertChanges(tx, id, overlay.changes);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'plan.uploaded', targetType: 'plan', targetId: id, metadata: { runId: run.id, summary: overlay.summary } });
    return id;
  });
  return getPlan(actor, projectId, planId);
}

export async function listPlans(actor: Actor, projectId: string, query: { limit: number; cursor?: string }) {
  const db = getPool();
  await requireProject(db, projectId, actor, { allowShare: true });
  const page = await plans.list(db, projectId, query);
  return { items: page.items.map(toPlan), nextCursor: page.nextCursor };
}

export async function getPlan(actor: Actor, projectId: string, planId: string) {
  const db = getPool();
  await requireProject(db, projectId, actor, { allowShare: true });
  const plan = await plans.findById(db, projectId, planId);
  if (!plan) throw notFound('Plan');
  return toPlanDetail(plan, await plans.listChanges(db, planId));
}

export async function deletePlan(actor: Actor, projectId: string, planId: string): Promise<void> {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'editor' });
  await withTransaction(async (tx) => {
    const plan = await plans.findById(tx, projectId, planId);
    if (!plan) throw notFound('Plan');
    await plans.remove(tx, planId);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'plan.deleted', targetType: 'plan', targetId: planId, metadata: { runId: plan.runId } });
  });
}
