/** A reference to another Terraform object found inside an expression. */
export type TfRef =
  | { kind: 'resource'; type: string; name: string; attribute: string | null }
  | { kind: 'data'; type: string; name: string; attribute: string | null }
  | { kind: 'var' | 'local' | 'module'; name: string };

// Provider prefixes we recognise for resource types. A prefix list (rather than "any word with an
// underscore") keeps things like `data_files.json` in a string from being read as a reference.
const PROVIDERS = 'aws|random|null|tls|time|external|archive|http|cloudinit|local|template|custom';
const TYPE = `(?:${PROVIDERS})_[a-z0-9_]+`;

const REF_PATTERN = new RegExp(
  [
    String.raw`\b(var|local|module)\.([A-Za-z_][\w-]*)`,
    String.raw`\bdata\.(${TYPE})\.([A-Za-z_][\w-]*)(?:\[[^\]]*\])?(?:\.([A-Za-z_]\w*))?`,
    String.raw`\b(${TYPE})\.([A-Za-z_][\w-]*)(?:\[[^\]]*\])?(?:\.([A-Za-z_]\w*))?`,
  ].join('|'),
  'g',
);

/** References inside a string. Only strings with interpolation (`${...}`) are expressions. */
export function findRefs(text: string): TfRef[] {
  if (!text.includes('${')) return [];
  const refs: TfRef[] = [];
  for (const m of text.matchAll(REF_PATTERN)) {
    if (m[1]) refs.push({ kind: m[1] as 'var' | 'local' | 'module', name: m[2]! });
    else if (m[3]) refs.push({ kind: 'data', type: m[3], name: m[4]!, attribute: m[5] ?? null });
    else if (m[6]) refs.push({ kind: 'resource', type: m[6], name: m[7]!, attribute: m[8] ?? null });
  }
  return refs;
}

/** `depends_on` entries are bare references, which hcl2json also wraps in `${}`; accept either form. */
export function findDependsOnRefs(value: unknown): TfRef[] {
  const items = Array.isArray(value) ? value : [value];
  return items.flatMap((item) => (typeof item === 'string' ? findRefs(item.includes('${') ? item : `\${${item}}`) : []));
}

export interface AttributeRef {
  /** Dotted path of the attribute, e.g. `environment.0.variables.TABLE_NAME`. */
  path: string;
  ref: TfRef;
}

/** Walks every attribute value, collecting the references in it. */
export function collectAttributeRefs(body: unknown, prefix = ''): AttributeRef[] {
  const found: AttributeRef[] = [];
  const visit = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      for (const ref of findRefs(value)) found.push({ path, ref });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, path ? `${path}.${i}` : String(i)));
    } else if (value && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) {
        if (!path && key === 'depends_on') continue; // handled separately, with its own relation
        visit(inner, path ? `${path}.${key}` : key);
      }
    }
  };
  visit(body, prefix);
  return found;
}

export interface Scope {
  variables: Map<string, unknown>;
  locals: Map<string, unknown>;
}

/**
 * Resolves `${var.x}` / `${local.x}` inside a string from variable defaults and locals.
 * Returns null if anything else (resources, functions, unknown variables) remains.
 */
export function resolveString(value: unknown, scope: Scope, depth = 0): string | null {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return null;
  if (!value.includes('${')) return value;
  if (depth > 5) return null;
  let unresolved = false;
  const out = value.replace(/\$\{\s*(var|local)\.([A-Za-z_][\w-]*)\s*\}/g, (_match, kind: string, name: string) => {
    const source = kind === 'var' ? scope.variables : scope.locals;
    const resolved = source.has(name) ? resolveString(source.get(name), scope, depth + 1) : null;
    if (resolved === null) {
      unresolved = true;
      return '';
    }
    return resolved;
  });
  if (unresolved || out.includes('${')) return null;
  return out;
}
