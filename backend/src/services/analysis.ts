import { getPool, withTransaction, type Db } from '../db/pool.js';
import { AppError, conflict, notFound, validationError } from '../http/errors.js';
import { PARSER_VERSION, analyze, type AnalysisStage } from '../core/analysis/pipeline.js';
import { integrations } from '../integrations/registry.js';
import * as activity from '../repositories/activity.js';
import * as runs from '../repositories/analysisRuns.js';
import type { RunRow, RunStatus } from '../repositories/analysisRuns.js';
import * as connections from '../repositories/githubConnections.js';
import * as findings from '../repositories/findings.js';
import * as graphRepo from '../repositories/graph.js';
import * as links from '../repositories/projectRepositories.js';
import * as projects from '../repositories/projects.js';
import type { ProjectRow } from '../repositories/projects.js';
import { requireProject, type Actor } from './access.js';
import { githubTokenFor } from './auth.js';
import { toProject, toRun } from './presenters.js';

// Limits keep one analysis within a Lambda's memory and time.
const LIMITS = { maxFileBytes: 512 * 1024, maxTotalBytes: 40 * 1024 * 1024, maxFiles: 4000 };

export interface StartRunInput {
  repositoryLinkId?: string;
  commitSha?: string;
  setAsCurrent?: boolean;
}

// ---- resolving run references ------------------------------------------------------------------------------------

/** A run UUID or "current", scoped to the project. */
export async function resolveRun(db: Db, project: ProjectRow, ref: string): Promise<RunRow> {
  const id = ref === 'current' ? project.currentRunId : ref;
  if (!id) throw notFound('A current analysis (run one first)');
  const run = await runs.findById(db, project.id, id);
  if (!run) throw notFound('Analysis run');
  return run;
}

/** Same, but the run must have finished successfully so its graph is complete. */
export async function resolveReadyRun(db: Db, project: ProjectRow, ref: string): Promise<RunRow> {
  const run = await resolveRun(db, project, ref);
  if (run.status !== 'succeeded') {
    throw conflict('run_not_ready', run.status === 'failed' ? 'That analysis run failed.' : 'That analysis run has not finished yet.');
  }
  return run;
}

// ---- starting a run -------------------------------------------------------------------------------------------------

export async function startRun(actor: Actor, projectId: string, input: StartRunInput) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'editor' });
  return startRunInternal(db, projectId, actor.userId!, input);
}

/** Resolves the commit, records the run, and hands it to the dispatcher. Returns before analysis starts. */
export async function startRunInternal(db: Db, projectId: string, userId: string, input: StartRunInput) {
  const linked = await links.list(db, projectId);
  if (linked.length === 0) throw validationError([{ field: 'repositoryLinkId', message: 'Link a GitHub repository to this project first.' }], 'No repository is linked.');
  let link = input.repositoryLinkId ? linked.find((l) => l.id === input.repositoryLinkId) : undefined;
  if (input.repositoryLinkId && !link) throw validationError([{ field: 'repositoryLinkId', message: 'Not a repository linked to this project.' }]);
  if (!link) {
    if (linked.length > 1) throw validationError([{ field: 'repositoryLinkId', message: 'This project links several repositories; say which one to analyze.' }]);
    link = linked[0]!;
  }

  const connection = link.linkedByConnectionId ? await connections.findById(db, link.linkedByConnectionId) : null;
  if (!connection) throw conflict('no_github_connection', 'No GitHub connection is available for this repository. Link it again with a connected account.');
  const token = await githubTokenFor(db, connection);
  const commitSha = await integrations().github.resolveCommit(token, link.repository.fullName, input.commitSha ?? link.branch);

  const run = await withTransaction(async (tx) => {
    const created = await runs.create(tx, {
      projectId,
      repositoryId: link!.repository.id,
      rootPath: link!.rootPath,
      commitSha,
      branch: link!.branch,
      parserVersion: PARSER_VERSION,
      startedBy: userId,
      stats: { options: { setAsCurrent: input.setAsCurrent ?? true } },
    });
    await activity.insert(tx, {
      projectId,
      actorUserId: userId,
      action: 'analysis.started',
      targetType: 'analysis_run',
      targetId: created.id,
      metadata: { repository: link!.repository.fullName, branch: link!.branch, commitSha },
    });
    return created;
  });

  try {
    await integrations().dispatcher.dispatch(run.id);
  } catch (err) {
    console.error('could not dispatch analysis run', err);
    await runs.updateProgress(db, run.id, { status: 'failed', error: 'Could not start the analysis job.', markFinished: true });
    throw new AppError(502, 'dispatch_failed', 'Upstream service failed', 'Could not start the analysis job.');
  }
  return toRun(run);
}

// ---- executing a run (background) --------------------------------------------------------------------------------------

/**
 * Runs one analysis end to end: download the commit, analyze it, store the graph. Safe to call
 * from the in-process dispatcher or from the Lambda's async self-invocation.
 */
export async function executeRun(runId: string): Promise<void> {
  const db = getPool();
  const projectId = await runs.findProjectId(db, runId);
  if (!projectId) return;
  const run = await runs.findById(db, projectId, runId);
  if (!run || run.status !== 'pending') return; // already picked up, or deleted meanwhile

  const actorId = run.startedBy?.id ?? null;
  const setStage = (stage: string) => runs.updateProgress(db, runId, { stats: { stage } });

  try {
    await runs.updateProgress(db, runId, { status: 'running', markStarted: true, stats: { stage: 'fetching' } });

    const link = run.repository ? await links.findByRepository(db, projectId, run.repository.id, run.rootPath) : null;
    const connection = link?.linkedByConnectionId ? await connections.findById(db, link.linkedByConnectionId) : null;
    if (!run.repository || !connection || !run.commitSha) {
      throw new AppError(409, 'no_github_connection', 'Conflict', 'The repository is no longer linked with a usable GitHub connection.');
    }
    const files = await integrations().github.downloadFiles(await githubTokenFor(db, connection), run.repository.fullName, run.commitSha, {
      rootPath: run.rootPath,
      ...LIMITS,
    });

    const output = await analyze({
      files,
      gemini: integrations().gemini,
      onStage: (stage: AnalysisStage) => setStage(stage),
    });

    await withTransaction(async (tx) => {
      await graphRepo.insertNodes(tx, runId, output.nodes);
      await graphRepo.insertEdges(tx, runId, output.edges);
      await findings.insertMany(tx, runId, output.findings);
      await findings.carryOverDismissals(tx, projectId, runId);
      await runs.updateProgress(tx, runId, { status: 'succeeded', error: null, markFinished: true, stats: { ...output.stats, stage: 'done' } });

      const project = await projects.lockById(tx, projectId);
      const setAsCurrent = (run.stats as { options?: { setAsCurrent?: boolean } }).options?.setAsCurrent !== false;
      if (project && (setAsCurrent || !project.currentRunId)) await projects.setCurrentRun(tx, projectId, runId);

      await activity.insert(tx, {
        projectId,
        actorUserId: actorId,
        action: 'analysis.succeeded',
        targetType: 'analysis_run',
        targetId: runId,
        metadata: { commitSha: run.commitSha, nodes: output.nodes.length, edges: output.edges.length, findings: output.findings.length },
      });
    });
  } catch (err) {
    console.error(`analysis run ${runId} failed`, err);
    const message = err instanceof AppError ? err.detail ?? err.title : 'The analysis failed unexpectedly.';
    await runs.updateProgress(db, runId, { status: 'failed', error: message, markFinished: true }).catch(() => undefined);
    await activity
      .insert(db, { projectId, actorUserId: actorId, action: 'analysis.failed', targetType: 'analysis_run', targetId: runId, metadata: { commitSha: run.commitSha, error: message } })
      .catch(() => undefined);
  }
}

// ---- reading and managing runs ----------------------------------------------------------------------------------------------

export async function listRuns(actor: Actor, projectId: string, query: { commitSha?: string; status?: RunStatus; limit: number; cursor?: string }) {
  const db = getPool();
  await requireProject(db, projectId, actor, { allowShare: true });
  const page = await runs.list(db, projectId, query);
  return { items: page.items.map(toRun), nextCursor: page.nextCursor };
}

export async function getRun(actor: Actor, projectId: string, runRef: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { allowShare: true });
  return toRun(await resolveRun(db, project, runRef));
}

export async function deleteRun(actor: Actor, projectId: string, runRef: string): Promise<void> {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { min: 'editor' });
  const run = await resolveRun(db, project, runRef);
  if (run.isCurrent) throw conflict('run_is_current', 'Choose another current run before deleting this one.');
  if (run.status === 'pending' || run.status === 'running') throw conflict('run_in_progress', 'Wait for the analysis to finish before deleting it.');
  await withTransaction(async (tx) => {
    await runs.remove(tx, run.id);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'analysis.deleted', targetType: 'analysis_run', targetId: run.id, metadata: { commitSha: run.commitSha } });
  });
}

export async function setCurrentRun(actor: Actor, projectId: string, runId: string) {
  const db = getPool();
  const { project, role } = await requireProject(db, projectId, actor, { min: 'editor' });
  const run = await resolveReadyRun(db, project, runId);
  await withTransaction(async (tx) => {
    await projects.setCurrentRun(tx, projectId, run.id);
    await activity.insert(tx, { projectId, actorUserId: actor.userId, action: 'analysis.current_changed', targetType: 'analysis_run', targetId: run.id, metadata: { commitSha: run.commitSha, previous: project.currentRunId } });
  });
  return toProject((await projects.findById(db, projectId))!, { myRole: role, currentRun: toRun({ ...run, isCurrent: true }) });
}

// ---- diff between two runs ------------------------------------------------------------------------------------------------------

export async function diffRuns(actor: Actor, projectId: string, runRef: string, againstId: string) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { allowShare: true });
  const head = await resolveReadyRun(db, project, runRef);
  const base = await resolveReadyRun(db, project, againstId);
  const [headGraph, baseGraph] = await Promise.all([
    graphRepo.loadGraph(db, head.id, head.commitSha),
    graphRepo.loadGraph(db, base.id, base.commitSha),
  ]);

  const shape = (n: (typeof headGraph.nodes)[number]) => JSON.stringify([n.name, n.kind, n.terraformType, n.attributes]);
  const baseNodes = new Map(baseGraph.nodes.map((n) => [n.address, n]));
  const headNodes = new Map(headGraph.nodes.map((n) => [n.address, n]));
  const edgeKeys = (graph: typeof headGraph) => {
    const address = new Map(graph.nodes.map((n) => [n.id, n.address]));
    return graph.edges.map((edge) => ({ edge, key: `${address.get(edge.source)}|${address.get(edge.target)}|${edge.relation}|${edge.linkMethod}` }));
  };
  const baseEdges = edgeKeys(baseGraph);
  const headEdges = edgeKeys(headGraph);
  const baseEdgeKeys = new Set(baseEdges.map((e) => e.key));
  const headEdgeKeys = new Set(headEdges.map((e) => e.key));

  return {
    runId: head.id,
    againstRunId: base.id,
    addedNodes: headGraph.nodes.filter((n) => !baseNodes.has(n.address)),
    removedNodes: baseGraph.nodes.filter((n) => !headNodes.has(n.address)),
    changedNodes: headGraph.nodes.flatMap((after) => {
      const before = baseNodes.get(after.address);
      return before && shape(before) !== shape(after) ? [{ before, after }] : [];
    }),
    addedEdges: headEdges.filter((e) => !baseEdgeKeys.has(e.key)).map((e) => e.edge),
    removedEdges: baseEdges.filter((e) => !headEdgeKeys.has(e.key)).map((e) => e.edge),
  };
}
