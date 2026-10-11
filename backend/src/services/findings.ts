import { getPool, withTransaction } from '../db/pool.js';
import { notFound } from '../http/errors.js';
import * as activity from '../repositories/activity.js';
import * as findingsRepo from '../repositories/findings.js';
import type { FindingKind, FindingSeverity } from '../repositories/findings.js';
import { requireProject, type Actor } from './access.js';
import { resolveReadyRun } from './analysis.js';

export async function listFindings(
  actor: Actor,
  projectId: string,
  runRef: string,
  query: { kind?: FindingKind; severity?: FindingSeverity; dismissed?: boolean; limit: number; cursor?: string },
) {
  const db = getPool();
  const { project } = await requireProject(db, projectId, actor, { allowShare: true });
  const run = await resolveReadyRun(db, project, runRef);
  return findingsRepo.list(db, run.id, query);
}

async function setDismissed(actor: Actor, projectId: string, findingId: string, dismissed: boolean) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'editor' });
  return withTransaction(async (tx) => {
    const finding = await findingsRepo.findById(tx, projectId, findingId);
    if (!finding) throw notFound('Finding');
    const already = (finding.dismissedAt !== null) === dismissed;
    if (!already) {
      await findingsRepo.setDismissed(tx, findingId, dismissed ? actor.userId : null);
      await activity.insert(tx, {
        projectId,
        actorUserId: actor.userId,
        action: dismissed ? 'finding.dismissed' : 'finding.restored',
        targetType: 'finding',
        targetId: findingId,
        metadata: { title: finding.title, kind: finding.kind, severity: finding.severity },
      });
    }
    return (await findingsRepo.findById(tx, projectId, findingId))!;
  });
}

export const dismissFinding = (actor: Actor, projectId: string, findingId: string) => setDismissed(actor, projectId, findingId, true);
export const restoreFinding = (actor: Actor, projectId: string, findingId: string) => setDismissed(actor, projectId, findingId, false);
