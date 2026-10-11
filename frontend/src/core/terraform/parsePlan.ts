import type { PlanAction } from '../graph/types';

export interface ParsedPlanChange {
  address: string;
  terraformType: string | null;
  /** Raw Terraform actions, e.g. `["delete", "create"]`. */
  actions: string[];
  action: PlanAction;
}

interface PlanResourceChange {
  address: string;
  type?: string;
  change?: { actions?: string[] };
}

/** Terraform lists a replace as both a delete and a create, in either order. */
function toPlanAction(terraformActions: string[]): PlanAction {
  const hasDelete = terraformActions.includes('delete');
  const hasCreate = terraformActions.includes('create');
  if (hasDelete && hasCreate) return 'replace';
  if (hasDelete) return 'destroy';
  if (hasCreate) return 'create';
  if (terraformActions.includes('update')) return 'update';
  return 'noop';
}

/**
 * Reads the output of `terraform show -json plan.out`. Resources with no change are left out.
 * Throws an Error with a user-readable message if the input isn't a plan.
 */
export function parsePlan(planJsonText: string): ParsedPlanChange[] {
  let parsedPlan: { resource_changes?: PlanResourceChange[] };
  try {
    parsedPlan = JSON.parse(planJsonText);
  } catch {
    throw new Error('That is not valid JSON.');
  }
  if (!Array.isArray(parsedPlan.resource_changes)) {
    throw new Error('No "resource_changes" found. Paste the output of `terraform show -json plan.out`.');
  }

  const parsedChanges: ParsedPlanChange[] = [];
  for (const resourceChange of parsedPlan.resource_changes) {
    const actions = resourceChange.change?.actions ?? [];
    const action = toPlanAction(actions);
    if (action === 'noop') continue;
    parsedChanges.push({
      address: resourceChange.address,
      terraformType: resourceChange.type ?? null,
      actions,
      action,
    });
  }
  return parsedChanges;
}
