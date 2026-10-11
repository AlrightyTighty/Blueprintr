import type { NewNode } from '../../repositories/graph.js';
import type { GeminiClient } from '../../integrations/gemini.js';
import { addInferredLink, candidatesFor, type LinkResult, type PendingCall } from './link.js';

export interface InferenceStats {
  attempted: number;
  linked: number;
  skipped: 'not_configured' | 'none_pending' | null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    resourceAddress: {
      type: ['string', 'null'],
      description: 'The address of the candidate resource the call targets, or null if it cannot be determined.',
    },
    reasoning: { type: 'string', description: 'One or two sentences explaining the choice, citing evidence from the code.' },
  },
  required: ['resourceAddress', 'reasoning'],
};

const SYSTEM =
  'You help a static-analysis tool work out which AWS resource a code call targets. ' +
  'You are given the enclosing function and a list of candidate Terraform resources. ' +
  'Choose a candidate only when the code gives clear evidence (names, environment variables, config keys). ' +
  'If it is ambiguous or the evidence is weak, answer null. Never invent a resource that is not in the candidate list.';

function describeCandidates(link: LinkResult, pending: PendingCall, candidates: NewNode[]) {
  return candidates.map((node) => ({
    address: node.address,
    names: link.identifiers.get(node.address) ?? [],
    environmentVariablesPointingAtIt: pending.lambdas.flatMap((lambda) =>
      [...lambda.env.entries()].flatMap(([name, binding]) => (binding.kind === 'ref' && binding.address === node.address ? [name] : [])),
    ),
  }));
}

/**
 * Method 4: asks Gemini to pick the likely resource for calls static analysis couldn't resolve.
 * Resolved links are labelled "inferred". Returns the calls that stayed unresolved.
 */
export async function inferPendingCalls(
  link: LinkResult,
  gemini: GeminiClient | null,
  options: { maxCalls?: number } = {},
): Promise<{ stats: InferenceStats; unresolved: PendingCall[] }> {
  const stats: InferenceStats = { attempted: 0, linked: 0, skipped: null };
  if (link.pending.length === 0) return { stats: { ...stats, skipped: 'none_pending' }, unresolved: [] };
  if (!gemini?.isConfigured()) return { stats: { ...stats, skipped: 'not_configured' }, unresolved: link.pending };

  const unresolved: PendingCall[] = [];
  const limit = options.maxCalls ?? 12;
  for (const pending of link.pending) {
    const candidates = candidatesFor(link, pending);
    if (candidates.length === 0 || stats.attempted >= limit) {
      unresolved.push(pending);
      continue;
    }
    stats.attempted++;
    try {
      const response = await gemini.generate({
        system: SYSTEM,
        temperature: 0,
        jsonSchema: SCHEMA,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: JSON.stringify({
                  call: {
                    action: pending.call.action,
                    file: pending.call.file,
                    line: pending.call.line,
                    targetExpression: pending.call.target.kind === 'unknown' ? pending.call.target.hint : null,
                    whyUnresolved: pending.reason,
                  },
                  candidates: describeCandidates(link, pending, candidates),
                  enclosingFunctionSource: pending.call.context,
                }),
              },
            ],
          },
        ],
      });
      const answer = JSON.parse(response.text ?? '{}') as { resourceAddress?: string | null; reasoning?: string };
      const chosen = candidates.find((c) => c.address === answer.resourceAddress);
      if (chosen) {
        addInferredLink(link, pending, chosen, answer.reasoning ?? 'Inferred by Gemini.');
        stats.linked++;
      } else {
        unresolved.push(pending);
      }
    } catch {
      unresolved.push(pending); // inference is best-effort; a failure must not fail the run
    }
  }
  return { stats, unresolved };
}
