import type { PlanAction } from '../graph/types';

interface PlanResourceChange {
  address: string;
  change: { actions: string[] };
}

export type PlanActionsByAddress = Map<string, PlanAction>;

/** Terraform lists a replace as both a delete and a create, in either order. */
function toPlanAction(terraformActions: string[]): PlanAction {
  const hasDelete = terraformActions.includes('delete');
  const hasCreate = terraformActions.includes('create');
  if (hasDelete && hasCreate) return 'replace';
  if (hasDelete) return 'destroy';
  if (terraformActions.includes('update')) return 'modify';
  return 'none';
}

/**
 * Reads the output of `terraform show -json plan.out`.
 * Throws an Error with a user-readable message if the input isn't a plan.
 */
export function parsePlan(planJsonText: string): PlanActionsByAddress {
  let parsedPlan: { resource_changes?: PlanResourceChange[] };
  try {
    parsedPlan = JSON.parse(planJsonText);
  } catch {
    throw new Error('That is not valid JSON.');
  }
  if (!Array.isArray(parsedPlan.resource_changes)) {
    throw new Error('No "resource_changes" found. Paste the output of `terraform show -json plan.out`.');
  }

  const actionsByAddress: PlanActionsByAddress = new Map();
  for (const resourceChange of parsedPlan.resource_changes) {
    const action = toPlanAction(resourceChange.change?.actions ?? []);
    if (action !== 'none') actionsByAddress.set(resourceChange.address, action);
  }
  return actionsByAddress;
}
