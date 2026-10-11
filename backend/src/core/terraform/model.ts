import { parse } from '@cdktf/hcl2json';
import { dirname } from 'node:path/posix';
import { fromPolicyDocumentData, type PolicyStatement } from './policies.js';
import type { Scope } from './references.js';

export interface SourceFile {
  path: string;
  content: string;
}

export interface TfResource {
  type: string;
  name: string;
  /** `aws_dynamodb_table.orders` */
  address: string;
  file: string;
  line: number | null;
  /** The block body with hcl2json's one-element-array wrapping removed. */
  body: Record<string, any>;
  /** What to show as the node name when it differs from `name` (the address label), e.g. a CDK construct path. */
  displayName?: string;
  /** Extra non-secret facts to put on the node, e.g. where the resource came from. */
  attributes?: Record<string, unknown>;
}

export interface TfDataBlock {
  type: string;
  name: string;
  file: string;
  body: Record<string, any>;
}

export interface TfModel extends Scope {
  resources: TfResource[];
  data: Map<string, TfDataBlock>; // key: `type.name`
  policyDocuments: Map<string, PolicyStatement[]>; // aws_iam_policy_document by name
  modules: { name: string; file: string }[];
  /** Files that could not be parsed. */
  errors: { file: string; message: string }[];
}

const unwrap = (value: unknown): Record<string, any> => {
  const first = Array.isArray(value) ? value[0] : value;
  return first && typeof first === 'object' ? (first as Record<string, any>) : {};
};

function lineOf(content: string, pattern: RegExp): number | null {
  const match = pattern.exec(content);
  if (!match) return null;
  return content.slice(0, match.index).split('\n').length;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Parses `.tf` files with HashiCorp's HCL parser (WASM). One bad file doesn't stop the others. */
export async function parseTerraform(files: SourceFile[]): Promise<TfModel> {
  const model: TfModel = {
    resources: [],
    data: new Map(),
    policyDocuments: new Map(),
    modules: [],
    errors: [],
    variables: new Map(),
    locals: new Map(),
  };

  for (const file of files.filter((f) => f.path.endsWith('.tf'))) {
    let doc: Record<string, any>;
    try {
      doc = (await parse(file.path, file.content)) as Record<string, any>;
    } catch (err) {
      model.errors.push({ file: file.path, message: err instanceof Error ? err.message.split('\n')[0]! : 'Could not parse file' });
      continue;
    }

    for (const [type, byName] of Object.entries<any>(doc.resource ?? {})) {
      for (const [name, body] of Object.entries<any>(byName)) {
        model.resources.push({
          type,
          name,
          address: `${type}.${name}`,
          file: file.path,
          line: lineOf(file.content, new RegExp(`resource\\s+"${escapeRegex(type)}"\\s+"${escapeRegex(name)}"`)),
          body: unwrap(body),
        });
      }
    }
    for (const [type, byName] of Object.entries<any>(doc.data ?? {})) {
      for (const [name, body] of Object.entries<any>(byName)) {
        const unwrapped = unwrap(body);
        model.data.set(`${type}.${name}`, { type, name, file: file.path, body: unwrapped });
        if (type === 'aws_iam_policy_document') model.policyDocuments.set(name, fromPolicyDocumentData(unwrapped));
      }
    }
    for (const [name, body] of Object.entries<any>(doc.variable ?? {})) {
      const variable = unwrap(body);
      if ('default' in variable) model.variables.set(name, variable.default);
    }
    for (const block of Array.isArray(doc.locals) ? doc.locals : doc.locals ? [doc.locals] : []) {
      for (const [name, value] of Object.entries(block as Record<string, unknown>)) model.locals.set(name, value);
    }
    for (const name of Object.keys(doc.module ?? {})) model.modules.push({ name, file: file.path });
  }
  return model;
}

/** Folder of the Terraform file that declares a resource (for resolving `source_dir` paths). */
export function resourceDir(resource: TfResource): string {
  return dirname(resource.file) === '.' ? '' : dirname(resource.file);
}
