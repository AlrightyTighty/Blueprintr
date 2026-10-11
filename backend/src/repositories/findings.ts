import type { Db } from '../db/pool.js';
import { decodeCursor, iso, isoOrNull, toPage, type Page } from '../db/util.js';
import { mapUserSummary, type UserSummary } from './projects.js';

export type FindingKind = 'permission_gap' | 'over_broad_iam' | 'unmanaged_resource' | 'unresolved_reference';
export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface FindingRow {
  id: string;
  runId: string;
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  detail: string | null;
  nodeId: string | null;
  relatedNodeId: string | null;
  evidence: Record<string, unknown>;
  fingerprint: string;
  dismissedAt: string | null;
  dismissedBy: UserSummary | null;
}

export interface NewFinding {
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  detail: string | null;
  nodeId: string | null;
  relatedNodeId: string | null;
  evidence: Record<string, unknown>;
  fingerprint: string;
}

const SELECT = `f.id, f.run_id, f.kind, f.severity, f.title, f.detail, f.node_id, f.related_node_id, f.evidence, f.fingerprint,
  f.dismissed_at, u.id AS u_id, u.username::text AS u_username, u.display_name AS u_display_name, u.avatar_url AS u_avatar_url`;
const FROM = 'findings f LEFT JOIN users u ON u.id = f.dismissed_by';

function map(row: Record<string, any>): FindingRow {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    nodeId: row.node_id,
    relatedNodeId: row.related_node_id,
    evidence: row.evidence ?? {},
    fingerprint: row.fingerprint,
    dismissedAt: isoOrNull(row.dismissed_at),
    dismissedBy: mapUserSummary(row, 'u_'),
  };
}

export async function insertMany(db: Db, runId: string, findings: NewFinding[]): Promise<void> {
  if (findings.length === 0) return;
  await db.query(
    `INSERT INTO findings (run_id, kind, severity, title, detail, node_id, related_node_id, evidence, fingerprint)
     SELECT $1, t.kind::finding_kind, t.severity::finding_severity, t.title, t.detail, t.node_id, t.related_node_id,
            t.evidence::jsonb, t.fingerprint
     FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::uuid[], $7::uuid[], $8::text[], $9::text[])
       AS t(kind, severity, title, detail, node_id, related_node_id, evidence, fingerprint)
     ON CONFLICT (run_id, fingerprint) DO NOTHING`,
    [
      runId,
      findings.map((f) => f.kind),
      findings.map((f) => f.severity),
      findings.map((f) => f.title),
      findings.map((f) => f.detail),
      findings.map((f) => f.nodeId),
      findings.map((f) => f.relatedNodeId),
      findings.map((f) => JSON.stringify(f.evidence)),
      findings.map((f) => f.fingerprint),
    ],
  );
}

/** Copies dismissals from the project's earlier runs onto matching fingerprints in `runId`. */
export async function carryOverDismissals(db: Db, projectId: string, runId: string): Promise<void> {
  await db.query(
    `UPDATE findings f SET dismissed_at = prev.dismissed_at, dismissed_by = prev.dismissed_by
     FROM (
       SELECT DISTINCT ON (pf.fingerprint) pf.fingerprint, pf.dismissed_at, pf.dismissed_by
       FROM findings pf JOIN analysis_runs pr ON pr.id = pf.run_id
       WHERE pr.project_id = $1 AND pf.run_id <> $2 AND pf.dismissed_at IS NOT NULL
       ORDER BY pf.fingerprint, pf.dismissed_at DESC
     ) prev
     WHERE f.run_id = $2 AND f.fingerprint = prev.fingerprint`,
    [projectId, runId],
  );
}

export async function list(
  db: Db,
  runId: string,
  filters: { kind?: FindingKind; severity?: FindingSeverity; dismissed?: boolean; nodeId?: string; limit: number; cursor?: string },
): Promise<Page<FindingRow>> {
  const where = ['f.run_id = $1'];
  const values: unknown[] = [runId];
  if (filters.kind) {
    values.push(filters.kind);
    where.push(`f.kind = $${values.length}::finding_kind`);
  }
  if (filters.severity) {
    values.push(filters.severity);
    where.push(`f.severity = $${values.length}::finding_severity`);
  }
  if (filters.dismissed !== undefined) where.push(filters.dismissed ? 'f.dismissed_at IS NOT NULL' : 'f.dismissed_at IS NULL');
  if (filters.nodeId) {
    values.push(filters.nodeId);
    where.push(`(f.node_id = $${values.length}::uuid OR f.related_node_id = $${values.length}::uuid)`);
  }
  // Most severe first. Enum order is info < low < medium < high < critical.
  const cursor = decodeCursor(filters.cursor);
  if (cursor && typeof cursor.s === 'string' && typeof cursor.id === 'string') {
    values.push(cursor.s, cursor.id);
    where.push(`(f.severity, f.id) < ($${values.length - 1}::finding_severity, $${values.length}::uuid)`);
  }
  values.push(filters.limit + 1);
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(' AND ')} ORDER BY f.severity DESC, f.id DESC LIMIT $${values.length}`,
    values,
  );
  return toPage(rows.map(map), filters.limit, (last) => ({ s: last.severity, id: last.id }));
}

export async function listAllForRun(db: Db, runId: string): Promise<FindingRow[]> {
  const { rows } = await db.query(`SELECT ${SELECT} FROM ${FROM} WHERE f.run_id = $1 ORDER BY f.severity DESC, f.id`, [runId]);
  return rows.map(map);
}

/** Scoped to the project, so a finding id from another project is simply not found. */
export async function findById(db: Db, projectId: string, findingId: string): Promise<FindingRow | null> {
  const { rows } = await db.query(
    `SELECT ${SELECT} FROM ${FROM} JOIN analysis_runs ar ON ar.id = f.run_id WHERE ar.project_id = $1 AND f.id = $2`,
    [projectId, findingId],
  );
  return rows[0] ? map(rows[0]) : null;
}

export async function setDismissed(db: Db, findingId: string, userId: string | null): Promise<void> {
  await db.query(
    `UPDATE findings SET dismissed_at = CASE WHEN $2::uuid IS NULL THEN NULL ELSE now() END, dismissed_by = $2::uuid WHERE id = $1`,
    [findingId, userId],
  );
}

/** Open (not dismissed) findings by severity. */
export async function openCounts(db: Db, runId: string): Promise<Record<string, number>> {
  const { rows } = await db.query(
    `SELECT severity, count(*)::int AS n FROM findings WHERE run_id = $1 AND dismissed_at IS NULL GROUP BY severity`,
    [runId],
  );
  return Object.fromEntries(rows.map((r) => [r.severity, r.n]));
}

export { iso };
