import type { Db } from '../db/pool.js';
import { decodeCursor, iso, toPage, type Page } from '../db/util.js';
import { mapUserSummary, type UserSummary } from './projects.js';

export type PlanAction = 'create' | 'update' | 'replace' | 'destroy' | 'noop';
export type PlanImpact = 'direct' | 'downstream';

export interface PlanRow {
  id: string;
  projectId: string;
  runId: string;
  terraformVersion: string | null;
  summary: Record<string, number>;
  aiExplanation: string | null;
  briefingScript: string | null;
  briefingAudioKey: string | null;
  createdBy: UserSummary | null;
  createdAt: string;
}

export interface PlanChangeRow {
  id: string;
  nodeId: string | null;
  address: string;
  terraformType: string | null;
  actions: string[];
  action: PlanAction;
  impact: PlanImpact;
  distance: number;
  changedAttributes: string[];
}

export type NewPlanChange = Omit<PlanChangeRow, 'id'>;

const SELECT = `pa.id, pa.project_id, pa.run_id, pa.terraform_version, pa.summary, pa.ai_explanation, pa.briefing_script,
  pa.briefing_audio_key, pa.created_at,
  u.id AS u_id, u.username::text AS u_username, u.display_name AS u_display_name, u.avatar_url AS u_avatar_url`;
const FROM = 'plan_analyses pa LEFT JOIN users u ON u.id = pa.created_by';

function map(row: Record<string, any>): PlanRow {
  return {
    id: row.id,
    projectId: row.project_id,
    runId: row.run_id,
    terraformVersion: row.terraform_version,
    summary: row.summary ?? {},
    aiExplanation: row.ai_explanation,
    briefingScript: row.briefing_script,
    briefingAudioKey: row.briefing_audio_key,
    createdBy: mapUserSummary(row, 'u_'),
    createdAt: iso(row.created_at),
  };
}

export async function create(
  db: Db,
  input: { projectId: string; runId: string; createdBy: string; terraformVersion: string | null; summary: Record<string, number> },
): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO plan_analyses (project_id, run_id, created_by, terraform_version, summary)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.projectId, input.runId, input.createdBy, input.terraformVersion, JSON.stringify(input.summary)],
  );
  return rows[0].id;
}

export async function insertChanges(db: Db, planId: string, changes: NewPlanChange[]): Promise<void> {
  if (changes.length === 0) return;
  await db.query(
    `INSERT INTO plan_changes (plan_id, node_id, address, terraform_type, actions, action, impact, distance, changed_attributes)
     SELECT $1, t.node_id, t.address, t.terraform_type, string_to_array(t.actions, ','), t.action::plan_action,
            t.impact::plan_impact, t.distance, ARRAY(SELECT jsonb_array_elements_text(t.changed::jsonb))
     FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::text[])
       AS t(node_id, address, terraform_type, actions, action, impact, distance, changed)
     ON CONFLICT (plan_id, address) DO NOTHING`,
    [
      planId,
      changes.map((c) => c.nodeId),
      changes.map((c) => c.address),
      changes.map((c) => c.terraformType),
      changes.map((c) => c.actions.join(',')),
      changes.map((c) => c.action),
      changes.map((c) => c.impact),
      changes.map((c) => c.distance),
      changes.map((c) => JSON.stringify(c.changedAttributes)),
    ],
  );
}

export async function findById(db: Db, projectId: string, planId: string): Promise<PlanRow | null> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE pa.project_id = $1 AND pa.id = $2`, [projectId, planId]);
  return rows[0] ? map(rows[0]) : null;
}

export async function listChanges(db: Db, planId: string): Promise<PlanChangeRow[]> {
  const { rows } = await db.query(
    `SELECT id, node_id, address, terraform_type, actions, action, impact, distance, changed_attributes
     FROM plan_changes WHERE plan_id = $1
     ORDER BY CASE impact WHEN 'direct' THEN 0 ELSE 1 END, distance, address`,
    [planId],
  );
  return rows.map((row) => ({
    id: row.id,
    nodeId: row.node_id,
    address: row.address,
    terraformType: row.terraform_type,
    actions: row.actions,
    action: row.action,
    impact: row.impact,
    distance: row.distance,
    changedAttributes: row.changed_attributes,
  }));
}

export async function list(db: Db, projectId: string, filters: { limit: number; cursor?: string }): Promise<Page<PlanRow>> {
  const where = ['pa.project_id = $1'];
  const values: unknown[] = [projectId];
  const cursor = decodeCursor(filters.cursor);
  if (cursor && typeof cursor.k === 'string' && typeof cursor.id === 'string') {
    values.push(cursor.k, cursor.id);
    where.push(`(pa.created_at, pa.id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
  }
  values.push(filters.limit + 1);
  const { rows } = await db.query(
    `SELECT ${SELECT}, pa.created_at::text AS sort_key FROM ${FROM}
     WHERE ${where.join(' AND ')} ORDER BY pa.created_at DESC, pa.id DESC LIMIT $${values.length}`,
    values,
  );
  const mapped = rows.map((row) => ({ plan: map(row), key: row.sort_key as string }));
  const page = toPage(mapped, filters.limit, (last) => ({ k: last.key, id: last.plan.id }));
  return { items: page.items.map((i) => i.plan), nextCursor: page.nextCursor };
}

export async function remove(db: Db, planId: string): Promise<void> {
  await db.query('DELETE FROM plan_analyses WHERE id = $1', [planId]);
}

export async function setExplanation(db: Db, planId: string, explanationJson: string): Promise<void> {
  await db.query('UPDATE plan_analyses SET ai_explanation = $2 WHERE id = $1', [planId, explanationJson]);
}

export async function setBriefing(db: Db, planId: string, input: { script: string; audioKey: string }): Promise<void> {
  await db.query('UPDATE plan_analyses SET briefing_script = $2, briefing_audio_key = $3 WHERE id = $1', [
    planId,
    input.script,
    input.audioKey,
  ]);
}

export async function clearBriefing(db: Db, planId: string): Promise<void> {
  await db.query('UPDATE plan_analyses SET briefing_script = NULL, briefing_audio_key = NULL WHERE id = $1', [planId]);
}
