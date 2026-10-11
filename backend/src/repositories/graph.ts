import type { Db } from '../db/pool.js';
import { decodeCursor, escapeLike, toPage, type Page } from '../db/util.js';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '../core/graph/types.js';
import { mapResourceType } from './resourceTypes.js';

const NODE_SELECT = `n.id, n.kind, n.address, n.name, n.terraform_type, n.parent_node_id, n.file_path, n.line_start, n.line_end,
  n.attributes, rt.terraform_type AS rt_terraform_type, rt.provider AS rt_provider, rt.service AS rt_service,
  rt.display_name AS rt_display_name, rt.category AS rt_category, rt.icon_key AS rt_icon_key, rt.color AS rt_color`;
const NODE_FROM = 'graph_nodes n LEFT JOIN resource_types rt ON rt.terraform_type = n.terraform_type';

function mapNode(row: Record<string, any>): GraphNode {
  return {
    id: row.id,
    kind: row.kind,
    address: row.address,
    name: row.name,
    terraformType: row.terraform_type,
    resourceType: row.rt_terraform_type ? mapResourceType(row, 'rt_') : null,
    parentId: row.parent_node_id,
    filePath: row.file_path,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    attributes: row.attributes ?? {},
  };
}

function mapEdge(row: Record<string, any>): GraphEdge {
  return {
    id: row.id,
    source: row.source_id,
    target: row.target_id,
    relation: row.relation,
    linkMethod: row.link_method,
    confidence: row.confidence,
    evidence: row.evidence ?? {},
    explanation: row.explanation,
  };
}

/** Node as written by the analysis pipeline (ids are generated up front so edges can refer to them). */
export type NewNode = Omit<GraphNode, 'resourceType'>;
export type NewEdge = GraphEdge;

const CHUNK = 500;

export async function insertNodes(db: Db, runId: string, nodes: NewNode[]): Promise<void> {
  for (let i = 0; i < nodes.length; i += CHUNK) {
    const chunk = nodes.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO graph_nodes (id, run_id, kind, address, name, terraform_type, parent_node_id, file_path, line_start, line_end, attributes)
       SELECT t.id, $1, t.kind::node_kind, t.address, t.name, t.terraform_type, NULL, t.file_path, t.line_start, t.line_end, t.attributes::jsonb
       FROM unnest($2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::int[], $9::int[], $10::text[])
         AS t(id, kind, address, name, terraform_type, file_path, line_start, line_end, attributes)`,
      [
        runId,
        chunk.map((n) => n.id),
        chunk.map((n) => n.kind),
        chunk.map((n) => n.address),
        chunk.map((n) => n.name),
        chunk.map((n) => n.terraformType),
        chunk.map((n) => n.filePath),
        chunk.map((n) => n.lineStart),
        chunk.map((n) => n.lineEnd),
        chunk.map((n) => JSON.stringify(n.attributes)),
      ],
    );
  }
  // Parents are set after all nodes exist so the self-reference never dangles.
  const withParent = nodes.filter((n) => n.parentId);
  for (let i = 0; i < withParent.length; i += CHUNK) {
    const chunk = withParent.slice(i, i + CHUNK);
    await db.query(
      `UPDATE graph_nodes n SET parent_node_id = t.parent FROM unnest($1::uuid[], $2::uuid[]) AS t(id, parent) WHERE n.id = t.id`,
      [chunk.map((n) => n.id), chunk.map((n) => n.parentId)],
    );
  }
}

export async function insertEdges(db: Db, runId: string, edges: NewEdge[]): Promise<void> {
  for (let i = 0; i < edges.length; i += CHUNK) {
    const chunk = edges.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO graph_edges (id, run_id, source_id, target_id, relation, link_method, confidence, evidence, explanation)
       SELECT t.id, $1, t.source, t.target, t.relation::edge_relation, t.method::link_method, t.confidence::confidence_level,
              t.evidence::jsonb, t.explanation
       FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
         AS t(id, source, target, relation, method, confidence, evidence, explanation)`,
      [
        runId,
        chunk.map((e) => e.id),
        chunk.map((e) => e.source),
        chunk.map((e) => e.target),
        chunk.map((e) => e.relation),
        chunk.map((e) => e.linkMethod),
        chunk.map((e) => e.confidence),
        chunk.map((e) => JSON.stringify(e.evidence)),
        chunk.map((e) => e.explanation),
      ],
    );
  }
}

export async function loadGraph(db: Db, runId: string, commitSha: string | null): Promise<Graph> {
  const [nodes, edges] = await Promise.all([
    db.query(`SELECT ${NODE_SELECT} FROM ${NODE_FROM} WHERE n.run_id = $1 ORDER BY n.address`, [runId]),
    db.query(
      `SELECT id, source_id, target_id, relation, link_method, confidence, evidence, explanation
       FROM graph_edges WHERE run_id = $1 ORDER BY id`,
      [runId],
    ),
  ]);
  return { runId, commitSha, nodes: nodes.rows.map(mapNode), edges: edges.rows.map(mapEdge) };
}

export async function findNode(db: Db, runId: string, nodeId: string): Promise<GraphNode | null> {
  const { rows } = await db.query(`SELECT ${NODE_SELECT} FROM ${NODE_FROM} WHERE n.run_id = $1 AND n.id = $2`, [runId, nodeId]);
  return rows[0] ? mapNode(rows[0]) : null;
}

export async function searchNodes(
  db: Db,
  runId: string,
  filters: { kind?: NodeKind; terraformType?: string; q?: string; limit: number; cursor?: string },
): Promise<Page<GraphNode>> {
  const where = ['n.run_id = $1'];
  const values: unknown[] = [runId];
  if (filters.kind) {
    values.push(filters.kind);
    where.push(`n.kind = $${values.length}::node_kind`);
  }
  if (filters.terraformType) {
    values.push(filters.terraformType);
    where.push(`n.terraform_type = $${values.length}`);
  }
  if (filters.q) {
    values.push(`%${escapeLike(filters.q)}%`);
    where.push(`(n.name ILIKE $${values.length} ESCAPE '\\' OR n.address ILIKE $${values.length} ESCAPE '\\')`);
  }
  const cursor = decodeCursor(filters.cursor);
  if (cursor && typeof cursor.a === 'string' && typeof cursor.id === 'string') {
    values.push(cursor.a, cursor.id);
    where.push(`(n.address, n.id) > ($${values.length - 1}, $${values.length}::uuid)`);
  }
  values.push(filters.limit + 1);
  const { rows } = await db.query(
    `SELECT ${NODE_SELECT} FROM ${NODE_FROM} WHERE ${where.join(' AND ')} ORDER BY n.address, n.id LIMIT $${values.length}`,
    values,
  );
  return toPage(rows.map(mapNode), filters.limit, (last) => ({ a: last.address, id: last.id }));
}
