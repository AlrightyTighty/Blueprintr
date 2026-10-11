import { actionMatches, parsePolicyAttribute, type PolicyResource, type PolicyStatement } from '../terraform/policies.js';
import { collectAttributeRefs, type TfRef } from '../terraform/references.js';
import type { TfModel, TfResource } from '../terraform/model.js';

export interface RolePolicy {
  /** Address of the policy resource, or the role itself for inline/managed policies. */
  source: string;
  statements: PolicyStatement[];
}

export interface RoleModel {
  roleAddress: string;
  policies: RolePolicy[];
  /** True when some attached policy could not be read, so absence of a permission proves nothing. */
  opaque: boolean;
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

type ResourceRef = Extract<TfRef, { kind: 'resource' }>;

function resourceRefs(value: unknown, type: string): ResourceRef[] {
  return collectAttributeRefs(value).flatMap(({ ref }) => (ref.kind === 'resource' && ref.type === type ? [ref] : []));
}

/** Policies for AWS-managed policy ARNs we understand. Everything else is neither allowed nor opaque. */
function managedPolicyStatements(arn: string): PolicyStatement[] {
  const name = arn.slice(arn.lastIndexOf('/') + 1);
  const all: PolicyResource[] = [{ kind: 'all' }];
  const allow = (actions: string[]): PolicyStatement[] => [{ effect: 'Allow', actions, resources: all }];
  switch (name) {
    case 'AdministratorAccess': return allow(['*']);
    case 'AmazonDynamoDBFullAccess': return allow(['dynamodb:*']);
    case 'AmazonS3FullAccess': return allow(['s3:*']);
    case 'AmazonSQSFullAccess': return allow(['sqs:*']);
    case 'AmazonSNSFullAccess': return allow(['sns:*']);
    case 'AWSLambda_FullAccess': return allow(['lambda:*']);
    case 'AmazonS3ReadOnlyAccess': return allow(['s3:Get*', 's3:List*']);
    case 'AmazonDynamoDBReadOnlyAccess': return allow(['dynamodb:Get*', 'dynamodb:BatchGet*', 'dynamodb:Query', 'dynamodb:Scan', 'dynamodb:Describe*', 'dynamodb:List*']);
    default: return [];
  }
}

/** Reads every role's effective policies out of the Terraform (inline, attached, managed). */
export function buildRoleModels(model: TfModel): Map<string, RoleModel> {
  const roles = new Map<string, RoleModel>();
  const byAddress = new Map<string, TfResource>(model.resources.map((r) => [r.address, r]));
  const roleModel = (address: string): RoleModel => {
    let entry = roles.get(address);
    if (!entry) roles.set(address, (entry = { roleAddress: address, policies: [], opaque: false }));
    return entry;
  };
  const addPolicy = (roleAddress: string, source: string, statements: PolicyStatement[] | null) => {
    const entry = roleModel(roleAddress);
    if (statements === null) entry.opaque = true;
    else entry.policies.push({ source, statements });
  };

  for (const resource of model.resources) {
    const { type, body, address } = resource;

    if (type === 'aws_iam_role') {
      roleModel(address);
      for (const arn of asArray(body.managed_policy_arns)) {
        if (typeof arn === 'string') addPolicy(address, `${address} (managed)`, managedPolicyStatements(arn));
      }
      for (const inline of asArray(body.inline_policy)) {
        addPolicy(address, `${address} (inline)`, parsePolicyAttribute((inline as any)?.policy, model.policyDocuments));
      }
    }

    if (type === 'aws_iam_role_policy') {
      const statements = parsePolicyAttribute(body.policy, model.policyDocuments);
      for (const role of resourceRefs(body.role, 'aws_iam_role')) addPolicy(`${role.type}.${role.name}`, address, statements);
    }

    if (type === 'aws_iam_role_policy_attachment' || type === 'aws_iam_policy_attachment') {
      const roles = resourceRefs(type === 'aws_iam_policy_attachment' ? body.roles : body.role, 'aws_iam_role');
      let statements: PolicyStatement[] | null = [];
      const policyRef = resourceRefs(body.policy_arn, 'aws_iam_policy')[0];
      if (policyRef) {
        const policy = byAddress.get(`${policyRef.type}.${policyRef.name}`);
        statements = policy ? parsePolicyAttribute(policy.body.policy, model.policyDocuments) : null;
      } else if (typeof body.policy_arn === 'string') {
        statements = managedPolicyStatements(body.policy_arn);
      }
      for (const role of roles) addPolicy(`${role.type}.${role.name}`, policyRef ? `${policyRef.type}.${policyRef.name}` : address, statements);
    }
  }
  return roles;
}

/** Identifiers (names) a resource is known by, used to match literal names and ARNs in code and policies. */
export function arnMentions(resource: PolicyResource, names: string[], address: string): boolean {
  if (resource.kind === 'all') return true;
  if (resource.kind === 'ref') return `${resource.ref.type}.${resource.ref.name}` === address;
  return names.some((name) => new RegExp(`(?:[:/])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[/:*]|$)`).test(resource.arn));
}

export interface Permission {
  allowed: boolean;
  /** Statement/policy that granted it, when allowed. */
  grantedBy: string | null;
}

/** Does the role allow `action` on the resource? Explicit denies win. */
export function evaluateAccess(role: RoleModel, action: string, resourceAddress: string, resourceNames: string[]): Permission {
  let grantedBy: string | null = null;
  for (const policy of role.policies) {
    for (const statement of policy.statements) {
      if (!statement.actions.some((pattern) => actionMatches(pattern, action))) continue;
      if (!statement.resources.some((r) => arnMentions(r, resourceNames, resourceAddress))) continue;
      if (statement.effect === 'Deny') return { allowed: false, grantedBy: null };
      grantedBy ??= policy.source;
    }
  }
  return { allowed: grantedBy !== null, grantedBy };
}
