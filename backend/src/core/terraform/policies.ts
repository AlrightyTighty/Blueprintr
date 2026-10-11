import { parseHclExpression, unwrapJsonencode } from './hclExpr.js';
import { findRefs, type TfRef } from './references.js';

export interface PolicyStatement {
  effect: 'Allow' | 'Deny';
  actions: string[];
  /** `*` or one or more targets; refs are to Terraform resources whose ARN the statement names. */
  resources: PolicyResource[];
}

export type PolicyResource =
  | { kind: 'all' }
  | { kind: 'ref'; ref: Extract<TfRef, { kind: 'resource' }> }
  | { kind: 'arn'; arn: string };

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

function toResources(value: unknown): PolicyResource[] {
  const out: PolicyResource[] = [];
  for (const item of asArray(value)) {
    if (typeof item !== 'string') continue;
    if (item === '*') {
      out.push({ kind: 'all' });
      continue;
    }
    const refs = findRefs(item).filter((r): r is Extract<TfRef, { kind: 'resource' }> => r.kind === 'resource');
    if (refs.length > 0) for (const ref of refs) out.push({ kind: 'ref', ref });
    else out.push({ kind: 'arn', arn: item });
  }
  return out;
}

/** Statements from an AWS policy document object (`{ Statement: [...] }`) in IAM JSON casing. */
function fromIamJson(doc: unknown): PolicyStatement[] | null {
  if (!doc || typeof doc !== 'object') return null;
  const statements = asArray((doc as Record<string, unknown>)['Statement']);
  if (statements.length === 0 && !('Statement' in (doc as object))) return null;
  const out: PolicyStatement[] = [];
  for (const raw of statements) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    out.push({
      effect: s['Effect'] === 'Deny' ? 'Deny' : 'Allow',
      actions: asArray(s['Action']).filter((a): a is string => typeof a === 'string'),
      resources: toResources(s['Resource']),
    });
  }
  return out;
}

/** Statements from a `data "aws_iam_policy_document"` block body. */
export function fromPolicyDocumentData(body: Record<string, unknown>): PolicyStatement[] {
  return asArray(body['statement']).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const s = raw as Record<string, unknown>;
    return [
      {
        effect: s['effect'] === 'Deny' ? ('Deny' as const) : ('Allow' as const),
        actions: asArray(s['actions']).filter((a): a is string => typeof a === 'string'),
        resources: toResources(s['resources']),
      },
    ];
  });
}

/**
 * Statements from a resource's `policy` attribute. Handles a heredoc/JSON string, `jsonencode({...})`,
 * and a reference to an `aws_iam_policy_document` data source. Returns null when it can't tell.
 */
export function parsePolicyAttribute(
  value: unknown,
  policyDocuments: Map<string, PolicyStatement[]>,
): PolicyStatement[] | null {
  if (typeof value !== 'string') return null;

  const docRef = /\$\{\s*data\.aws_iam_policy_document\.([\w-]+)\.json\s*\}/.exec(value);
  if (docRef) return policyDocuments.get(docRef[1]!) ?? null;

  const inner = unwrapJsonencode(value);
  if (inner !== null) {
    const parsed = parseHclExpression(inner);
    return parsed === undefined ? null : fromIamJson(parsed);
  }

  try {
    return fromIamJson(JSON.parse(value));
  } catch {
    return null;
  }
}

/** Does an IAM action pattern (`dynamodb:Get*`, `s3:*`, `*`) cover `action`? Case-insensitive. */
export function actionMatches(pattern: string, action: string): boolean {
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
  return regex.test(action);
}
