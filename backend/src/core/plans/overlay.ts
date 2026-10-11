import { validationError } from '../../http/errors.js';
import type { NewPlanChange, PlanAction } from '../../repositories/plans.js';
import { reach } from '../graph/traversal.js';
import type { Graph } from '../graph/types.js';

export interface ParsedChange {
  address: string;
  terraformType: string | null;
  actions: string[];
  action: PlanAction;
  changedAttributes: string[];
}

export interface ParsedPlan {
  terraformVersion: string | null;
  changes: ParsedChange[];
}

const SEVERITY: PlanAction[] = ['noop', 'create', 'update', 'replace', 'destroy'];

/** Terraform lists a replace as delete + create, in either order. */
export function toPlanAction(actions: string[]): PlanAction {
  const hasDelete = actions.includes('delete');
  const hasCreate = actions.includes('create');
  if (hasDelete && hasCreate) return 'replace';
  if (hasDelete) return 'destroy';
  if (actions.includes('update')) return 'update';
  if (hasCreate) return 'create';
  return 'noop'; // no-op and read
}

/** `aws_s3_bucket.logs[0]` and `aws_s3_bucket.logs["a"]` are instances of `aws_s3_bucket.logs`. */
export function baseAddress(address: string): string {
  return address.replace(/(\[[^\]]*\])+$/, '');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Names (never values) of the attributes that differ between before and after. */
function changedAttributeNames(change: Record<string, unknown>, action: PlanAction): string[] {
  const before = isRecord(change.before) ? change.before : {};
  const after = isRecord(change.after) ? change.after : {};
  const unknown = isRecord(change.after_unknown) ? change.after_unknown : {};
  const names = new Set<string>();
  if (action === 'create') Object.keys(after).forEach((k) => names.add(k));
  else if (action === 'destroy') Object.keys(before).forEach((k) => names.add(k));
  else {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) names.add(key);
    }
    for (const [key, isUnknown] of Object.entries(unknown)) if (isUnknown === true) names.add(key);
  }
  return [...names].sort().slice(0, 50);
}

/**
 * Reads `terraform show -json` output. Only addresses, actions and attribute *names* are kept: the
 * before/after values (which may be sensitive) are dropped here and never leave this function.
 */
export function parsePlanJson(plan: unknown): ParsedPlan {
  if (!isRecord(plan) || !Array.isArray(plan.resource_changes)) {
    throw validationError(
      [{ field: 'resource_changes', message: 'Not a Terraform plan. Upload the output of `terraform show -json plan.out`.' }],
      'The upload is not a Terraform plan.',
    );
  }

  const merged = new Map<string, ParsedChange>();
  for (const raw of plan.resource_changes) {
    if (!isRecord(raw) || typeof raw.address !== 'string' || !isRecord(raw.change)) continue;
    const actions = Array.isArray(raw.change.actions) ? raw.change.actions.filter((a): a is string => typeof a === 'string') : [];
    const action = toPlanAction(actions);
    const address = baseAddress(raw.address);
    const attributes = changedAttributeNames(raw.change, action);
    const existing = merged.get(address);
    if (!existing) {
      merged.set(address, { address, terraformType: typeof raw.type === 'string' ? raw.type : null, actions, action, changedAttributes: attributes });
    } else {
      // count/for_each: several instances share one node, so keep the most severe outcome.
      if (SEVERITY.indexOf(action) > SEVERITY.indexOf(existing.action)) {
        existing.action = action;
        existing.actions = actions;
      }
      existing.changedAttributes = [...new Set([...existing.changedAttributes, ...attributes])].sort().slice(0, 50);
    }
  }
  return {
    terraformVersion: typeof plan.terraform_version === 'string' ? plan.terraform_version : null,
    changes: [...merged.values()],
  };
}

export interface PlanOverlay {
  changes: NewPlanChange[];
  summary: Record<string, number>;
}

/**
 * Lays a plan over the graph. Changed resources are `direct` (red). Everything that depends on a
 * replaced or destroyed resource, including the code, is `downstream` (amber), with its distance.
 */
export function overlayPlan(graph: Graph, plan: ParsedPlan): PlanOverlay {
  const nodeByAddress = new Map(graph.nodes.map((n) => [n.address, n]));
  const changes: NewPlanChange[] = [];
  const changedNodeIds = new Set<string>();
  const destructive: string[] = [];

  for (const change of plan.changes) {
    if (change.action === 'noop') continue;
    const node = nodeByAddress.get(change.address) ?? null;
    changes.push({
      nodeId: node?.id ?? null,
      address: change.address,
      terraformType: change.terraformType ?? node?.terraformType ?? null,
      actions: change.actions,
      action: change.action,
      impact: 'direct',
      distance: 0,
      changedAttributes: change.changedAttributes,
    });
    if (node) {
      changedNodeIds.add(node.id);
      if (change.action === 'replace' || change.action === 'destroy') destructive.push(node.id);
    }
  }

  const summary: Record<string, number> = { create: 0, update: 0, replace: 0, destroy: 0, downstream: 0 };
  for (const change of changes) summary[change.action] = (summary[change.action] ?? 0) + 1;

  if (destructive.length > 0) {
    const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
    for (const [nodeId, reached] of reach(graph, destructive, 'dependents')) {
      if (changedNodeIds.has(nodeId)) continue;
      const node = nodes.get(nodeId)!;
      changes.push({
        nodeId,
        address: node.address,
        terraformType: node.terraformType,
        actions: [],
        action: 'noop',
        impact: 'downstream',
        distance: reached.distance,
        changedAttributes: [],
      });
      summary.downstream = (summary.downstream ?? 0) + 1;
    }
  }
  return { changes, summary };
}
