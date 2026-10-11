import { LineCounter, isAlias, isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml';

/** One resource from a CloudFormation template, with intrinsic functions in long form (`{ Ref: x }`). */
export interface CfnResource {
  logicalId: string;
  type: string;
  properties: Record<string, unknown>;
  metadata: Record<string, unknown>;
  dependsOn: string[];
  line: number | null;
}

export interface CfnOutput {
  name: string;
  value: unknown;
  /** The export name, when the output is exported for other stacks. */
  exportName: unknown;
}

export interface CfnTemplate {
  path: string;
  parameters: Map<string, unknown>;
  mappings: Record<string, unknown>;
  resources: CfnResource[];
  outputs: CfnOutput[];
}

export type CfnParseResult = { kind: 'template'; template: CfnTemplate } | { kind: 'error'; message: string } | null;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Short-form YAML tags (`!Ref x`) become the JSON long form (`{ Ref: x }`) that `cdk synth` emits. */
function applyTag(tag: string, value: unknown): unknown {
  const name = tag.replace(/^!/, '');
  if (name === 'Ref' || name === 'Condition') return { [name]: value };
  if (name === 'GetAtt') {
    if (typeof value === 'string') {
      const dot = value.indexOf('.');
      return { 'Fn::GetAtt': dot === -1 ? [value, ''] : [value.slice(0, dot), value.slice(dot + 1)] };
    }
    return { 'Fn::GetAtt': value };
  }
  return { [`Fn::${name}`]: value };
}

/** YAML aliases can expand exponentially ("billion laughs"), so reading stops after this many nodes. */
const MAX_NODES = 200_000;
class TooLarge extends Error {}

function toValue(node: unknown, doc: Document, budget = { used: 0 }): unknown {
  if (++budget.used > MAX_NODES) throw new TooLarge('The template is too large or too deeply aliased to read.');
  if (isAlias(node)) return toValue(node.resolve(doc), doc, budget);
  let value: unknown;
  if (isScalar(node)) value = node.value;
  else if (isSeq(node)) value = node.items.map((item) => toValue(item, doc, budget));
  else if (isMap(node)) {
    const out: Record<string, unknown> = {};
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      out[key] = toValue(pair.value, doc, budget);
    }
    value = out;
  } else return null;
  const tag = (node as Node).tag;
  return typeof tag === 'string' && tag.startsWith('!') && !tag.startsWith('!!') ? applyTag(tag, value) : value;
}

/**
 * Reads a CloudFormation template (YAML or JSON; JSON is a subset of YAML). Returns null for files
 * that are not templates, so it is safe to call on any `.yaml`/`.yml`/`.json` file. The text is only
 * parsed as data; nothing in it is executed.
 */
export function parseCfnTemplate(path: string, text: string): CfnParseResult {
  // Cheap checks first: most JSON/YAML files in a repository are not templates.
  if (!text.includes('Resources') || !(/(AWS|Custom)::/.test(text) || text.includes('AWSTemplateFormatVersion'))) return null;

  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const looksIntended = text.includes('AWSTemplateFormatVersion');
  if (doc.errors.length > 0) {
    return looksIntended ? { kind: 'error', message: doc.errors[0]!.message.split('\n')[0]! } : null;
  }

  let root: unknown;
  try {
    root = toValue(doc.contents, doc);
  } catch (err) {
    if (err instanceof TooLarge) return { kind: 'error', message: err.message };
    throw err;
  }
  if (!isRecord(root) || !isRecord(root['Resources'])) return null;
  const resourceEntries = Object.entries(root['Resources']);
  const isTemplate =
    root['AWSTemplateFormatVersion'] !== undefined ||
    resourceEntries.some(([, r]) => isRecord(r) && typeof r['Type'] === 'string' && /^(AWS|Custom)::/.test(r['Type']));
  if (!isTemplate) return null;

  // Line numbers come from the syntax tree, since the plain values carry no positions.
  const lineOf = new Map<string, number>();
  if (isMap(doc.contents)) {
    const resourcesNode = doc.contents.items.find((p) => isScalar(p.key) && p.key.value === 'Resources')?.value;
    if (isMap(resourcesNode)) {
      for (const pair of resourcesNode.items) {
        if (isScalar(pair.key) && pair.key.range) lineOf.set(String(pair.key.value), lineCounter.linePos(pair.key.range[0]).line);
      }
    }
  }

  const resources: CfnResource[] = [];
  for (const [logicalId, raw] of resourceEntries) {
    if (!isRecord(raw) || typeof raw['Type'] !== 'string') continue;
    const dependsOn = raw['DependsOn'];
    resources.push({
      logicalId,
      type: raw['Type'],
      properties: isRecord(raw['Properties']) ? raw['Properties'] : {},
      metadata: isRecord(raw['Metadata']) ? raw['Metadata'] : {},
      dependsOn: (Array.isArray(dependsOn) ? dependsOn : dependsOn ? [dependsOn] : []).filter((d): d is string => typeof d === 'string'),
      line: lineOf.get(logicalId) ?? null,
    });
  }

  const parameters = new Map<string, unknown>();
  if (isRecord(root['Parameters'])) {
    for (const [name, def] of Object.entries(root['Parameters'])) if (isRecord(def) && 'Default' in def) parameters.set(name, def['Default']);
  }

  const outputs: CfnOutput[] = [];
  if (isRecord(root['Outputs'])) {
    for (const [name, def] of Object.entries(root['Outputs'])) {
      if (isRecord(def)) outputs.push({ name, value: def['Value'], exportName: isRecord(def['Export']) ? def['Export']['Name'] : undefined });
    }
  }

  return {
    kind: 'template',
    template: { path, parameters, mappings: isRecord(root['Mappings']) ? root['Mappings'] : {}, resources, outputs },
  };
}
