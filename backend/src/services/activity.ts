import { getPool } from '../db/pool.js';
import * as activity from '../repositories/activity.js';
import { requireProject, type Actor } from './access.js';

/** The audit trail is for the people who work on the project, so viewers don't get it. */
export async function listProjectActivity(
  actor: Actor,
  projectId: string,
  query: { action?: string; actorId?: string; limit: number; cursor?: string },
) {
  const db = getPool();
  await requireProject(db, projectId, actor, { min: 'editor' });
  return activity.listForProject(db, projectId, query);
}
