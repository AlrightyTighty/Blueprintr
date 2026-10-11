import { createHash } from 'node:crypto';
import type { FindingSeverity, NewFinding } from '../../repositories/findings.js';
import { evaluateAccess } from './iam.js';
import { actionMatches } from '../terraform/policies.js';
import type { LinkResult, ResolvedCall } from './link.js';

const fingerprint = (...parts: string[]) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
const where = (call: { file: string; line: number }) => `${call.file}:${call.line}`;
const unique = <T>(items: T[]) => [...new Set(items)];

/** Findings that fall out of the linked graph: permission gaps, over-broad IAM, drift and unresolved links. */
export function computeFindings(link: LinkResult): NewFinding[] {
  const findings: NewFinding[] = [];
  const { builder } = link;

  // --- permission gaps ---------------------------------------------------------------------------------------
  const seenGaps = new Set<string>();
  for (const resolved of link.resolved) {
    const role = resolved.lambda?.roleAddress ? link.roles.get(resolved.lambda.roleAddress) : undefined;
    if (!resolved.lambda || !role || role.opaque || role.policies.length === 0) continue; // can't prove anything
    const names = resolved.target.kind === 'unmanaged_resource' ? [resolved.target.name] : link.identifiers.get(resolved.target.address) ?? [];
    const access = evaluateAccess(role, resolved.call.action, resolved.target.address, names);
    if (access.allowed) continue;

    const key = `${resolved.source.address}|${resolved.call.action}|${resolved.target.address}`;
    if (seenGaps.has(key)) continue;
    seenGaps.add(key);

    const roleNode = builder.node(role.roleAddress);
    findings.push({
      kind: 'permission_gap',
      severity: resolved.inferred ? 'medium' : 'high',
      title: `${resolved.source.name} calls ${resolved.call.action} on ${resolved.target.name}, but ${role.roleAddress} doesn't allow it`,
      detail:
        `${where(resolved.call)} calls ${resolved.call.action} on ${resolved.target.address}. ` +
        `The Lambda ${resolved.lambda.address} runs as ${role.roleAddress}, whose policies don't grant that action on this resource, so the call fails with AccessDenied at runtime.` +
        (resolved.inferred ? ' The target was inferred by Gemini, so confirm it is the right resource.' : ''),
      nodeId: resolved.source.id,
      relatedNodeId: roleNode?.id ?? null,
      evidence: {
        action: resolved.call.action,
        resource: resolved.target.address,
        role: role.roleAddress,
        location: where(resolved.call),
        inferred: resolved.inferred,
      },
      fingerprint: fingerprint('permission_gap', resolved.source.address, resolved.call.action, resolved.target.address),
    });
  }

  // --- over-broad IAM ----------------------------------------------------------------------------------------------
  const callsByRole = new Map<string, ResolvedCall[]>();
  for (const resolved of link.resolved) {
    const roleAddress = resolved.lambda?.roleAddress;
    if (roleAddress) callsByRole.set(roleAddress, [...(callsByRole.get(roleAddress) ?? []), resolved]);
  }
  for (const role of link.roles.values()) {
    const mappedLambdas = [...link.lambdas.values()].filter((l) => l.roleAddress === role.roleAddress && l.codeFiles.size > 0);
    if (mappedLambdas.length === 0) continue; // no code to compare against
    const calls = callsByRole.get(role.roleAddress) ?? [];
    for (const policy of role.policies) {
      policy.statements.forEach((statement, index) => {
        if (statement.effect !== 'Allow') return;
        if (statement.actions.every((a) => /^(logs|xray|cloudwatch|ec2:(Create|Describe|Delete)NetworkInterface)/i.test(a))) return;
        const wildcardAction = statement.actions.some((a) => a === '*' || a.endsWith(':*'));
        const wildcardResource = statement.resources.some((r) => r.kind === 'all');
        if (!wildcardAction && !wildcardResource) return;

        const covered = calls.filter((c) => statement.actions.some((a) => actionMatches(a, c.call.action)));
        const usedActions = unique(covered.map((c) => c.call.action)).sort();
        const usedResources = unique(covered.map((c) => (c.target.kind === 'unmanaged_resource' ? c.target.name : c.target.address))).sort();
        const grants = statement.actions.join(', ');
        const scope = wildcardResource ? 'all resources (*)' : 'the listed resources';

        const severity: FindingSeverity = wildcardAction && wildcardResource ? 'high' : 'medium';
        const used = usedActions.length === 0 ? 'no matching calls in the code' : `only ${usedActions.join(', ')} on ${usedResources.join(', ')}`;
        findings.push({
          kind: 'over_broad_iam',
          severity,
          title: `${role.roleAddress} allows ${grants} on ${wildcardResource ? 'everything' : 'its resources'}, but the code uses ${used}`,
          detail:
            `${policy.source} (statement ${index + 1}) grants ${grants} on ${scope}. ` +
            `The code that runs as this role ${usedActions.length === 0 ? 'makes no matching calls' : `uses ${usedActions.join(', ')} on ${usedResources.join(', ')}`}. ` +
            `Narrowing the policy to what is used limits the damage if the function is compromised.`,
          nodeId: builder.node(role.roleAddress)?.id ?? null,
          relatedNodeId: null,
          evidence: { policy: policy.source, statement: index + 1, grants: statement.actions, usedActions, usedResources },
          fingerprint: fingerprint('over_broad_iam', role.roleAddress, policy.source, String(index), statement.actions.join(',')),
        });
      });
    }
  }

  // --- unmanaged resources (drift) ------------------------------------------------------------------------------------
  const unmanagedByName = new Map<string, typeof link.unmanaged>();
  for (const use of link.unmanaged) unmanagedByName.set(use.target.address, [...(unmanagedByName.get(use.target.address) ?? []), use]);
  for (const [address, uses] of unmanagedByName) {
    const first = uses[0]!;
    const service = first.call.op.service;
    findings.push({
      kind: 'unmanaged_resource',
      severity: 'medium',
      title: `"${first.name}" (${service}) is hardcoded in code but not defined in your infrastructure code`,
      detail:
        `${uses.map((u) => `${where(u.call)} (${u.call.action})`).join('; ')}. ` +
        `No resource of this type in the analyzed infrastructure code has that name, so changes to it can't be reviewed or reproduced and it may have drifted.`,
      nodeId: first.target.id,
      relatedNodeId: first.source.id,
      evidence: { service, name: first.name, locations: uses.map((u) => where(u.call)), actions: unique(uses.map((u) => u.call.action)) },
      fingerprint: fingerprint('unmanaged_resource', address),
    });
  }

  // --- unresolved references --------------------------------------------------------------------------------------------
  for (const item of link.unresolvedRefs) {
    findings.push({
      kind: 'unresolved_reference',
      severity: item.target.address.startsWith('module.') ? 'low' : 'medium',
      title: item.reason,
      detail: item.target.attributes['reason'] ? String(item.target.attributes['reason']) : null,
      nodeId: item.source.id,
      relatedNodeId: item.target.id,
      evidence: { reference: item.target.address },
      fingerprint: fingerprint('unresolved_reference', item.source.address, item.target.address),
    });
  }
  for (const missing of link.missingEnv) {
    findings.push({
      kind: 'unresolved_reference',
      severity: 'medium',
      title: `${missing.source.name} reads ${missing.envVar}, but ${missing.lambda.address} doesn't set it`,
      detail: `${where(missing.call)} uses the environment variable ${missing.envVar} to find its ${missing.call.op.service} resource, but the Lambda's environment block doesn't define it, so the lookup will fail at runtime.`,
      nodeId: missing.source.id,
      relatedNodeId: missing.lambda.node.id,
      evidence: { envVar: missing.envVar, location: where(missing.call) },
      fingerprint: fingerprint('unresolved_reference', 'env', missing.source.address, missing.envVar, missing.lambda.address),
    });
  }
  for (const error of link.model.errors) {
    findings.push({
      kind: 'unresolved_reference',
      severity: 'medium',
      title: `Could not parse ${error.file}`,
      detail: `${error.message}. Resources in this file are missing from the graph.`,
      nodeId: null,
      relatedNodeId: null,
      evidence: { file: error.file },
      fingerprint: fingerprint('unresolved_reference', 'parse', error.file),
    });
  }
  return findings;
}

/** Findings for calls whose target stayed unknown after inference. */
export function unresolvedCallFindings(link: LinkResult, unresolved: LinkResult['pending']): NewFinding[] {
  return unresolved.map(({ call, source, reason }) => ({
    kind: 'unresolved_reference' as const,
    severity: 'low' as const,
    title: `Can't tell which ${call.op.service} resource ${source.name} targets with ${call.action}`,
    detail: `${where(call)}: ${reason} Ripplemap couldn't resolve it statically${link.facts ? '' : ''}, so this call is missing from the graph.`,
    nodeId: source.id,
    relatedNodeId: null,
    evidence: { action: call.action, location: where(call), reason },
    fingerprint: fingerprint('unresolved_reference', 'call', source.address, call.action, String(call.line)),
  }));
}
