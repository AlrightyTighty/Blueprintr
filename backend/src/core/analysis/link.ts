import { posix } from 'node:path';
import type { NewNode } from '../../repositories/graph.js';
import type { CodeCall, CodeFacts, CodeFunction, SdkCall } from '../code/scan.js';
import { extractEndpoints } from '../endpoints/extract.js';
import type { EdgeRelation } from '../graph/types.js';
import { resourceDir, type TfModel, type TfResource } from '../terraform/model.js';
import {
  collectAttributeRefs,
  findDependsOnRefs,
  findRefs,
  resolveString,
  type TfRef,
} from '../terraform/references.js';
import { GraphBuilder } from './graphBuilder.js';
import { buildRoleModels, type RoleModel } from './iam.js';

// ------------------------------------------------------------------------------------------------------------
// Types shared with the rest of the pipeline
// ------------------------------------------------------------------------------------------------------------

export type EnvBinding =
  | { kind: 'ref'; address: string; attribute: string | null }
  | { kind: 'literal'; value: string }
  | { kind: 'unresolved' };

export interface LambdaInfo {
  address: string;
  node: NewNode;
  roleAddress: string | null;
  runtime: string | null;
  handlerFile: string | null;
  handlerFunction: string | null;
  codeDir: string | null;
  codeFiles: Set<string>;
  env: Map<string, EnvBinding>;
}

/** A code call whose target resource is known, with how we know. */
export interface ResolvedCall {
  call: SdkCall;
  source: NewNode;
  target: NewNode;
  lambda: LambdaInfo | null;
  inferred: boolean;
}

export interface PendingCall {
  call: SdkCall;
  source: NewNode;
  lambdas: LambdaInfo[];
  /** Why the target is unknown, for the finding if inference doesn't resolve it. */
  reason: string;
}

export interface MissingEnv {
  call: SdkCall;
  source: NewNode;
  envVar: string;
  lambda: LambdaInfo;
}

export interface UnmanagedUse {
  call: SdkCall;
  source: NewNode;
  target: NewNode;
  name: string;
}

export interface LinkResult {
  builder: GraphBuilder;
  model: TfModel;
  facts: CodeFacts;
  roles: Map<string, RoleModel>;
  lambdas: Map<string, LambdaInfo>;
  /** Names each Terraform resource is known by (e.g. a table's `name`). */
  identifiers: Map<string, string[]>;
  resolved: ResolvedCall[];
  pending: PendingCall[];
  missingEnv: MissingEnv[];
  unmanaged: UnmanagedUse[];
  /** Unresolvable Terraform references (modules, resources not found). */
  unresolvedRefs: { source: NewNode; target: NewNode; reason: string }[];
  /** How many endpoints were found, and how many looked like endpoints but could not be resolved. */
  endpoints: { found: number; unresolved: number };
}

// ------------------------------------------------------------------------------------------------------------
// Terraform helpers
// ------------------------------------------------------------------------------------------------------------

/** Which attribute names a resource, per type. */
const NAME_ATTRIBUTES: Record<string, string[]> = {
  aws_dynamodb_table: ['name'],
  aws_s3_bucket: ['bucket'],
  aws_sqs_queue: ['name'],
  aws_sns_topic: ['name'],
  aws_lambda_function: ['function_name'],
};

/** The Terraform type each SDK service talks to. */
export const SERVICE_RESOURCE_TYPE: Record<string, string> = {
  dynamodb: 'aws_dynamodb_table',
  s3: 'aws_s3_bucket',
  sqs: 'aws_sqs_queue',
  sns: 'aws_sns_topic',
  lambda: 'aws_lambda_function',
};

const SAFE_ATTRIBUTES = new Set([
  'name', 'bucket', 'function_name', 'handler', 'runtime', 'hash_key', 'range_key', 'billing_mode', 'fifo_queue',
  'domain_name', 'type', 'protocol_type', 'stage_name', 'description', 'memory_size', 'timeout', 'architectures',
  'aliases', 'comment', 'zone_id', 'ttl', 'visibility_timeout_seconds', 'source_dir', 'path_part', 'route_key',
  'http_method', 'authorization_type',
]);

function identifierNames(resource: TfResource, scope: TfModel): string[] {
  const keys = NAME_ATTRIBUTES[resource.type] ?? ['name'];
  const names: string[] = [];
  for (const key of keys) {
    const value = resolveString(resource.body[key], scope);
    if (value) names.push(value);
  }
  return names;
}

/** Non-secret configuration worth showing in the UI. Secrets live in env var values, which are never copied. */
function safeAttributes(resource: TfResource, model: TfModel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(resource.body)) {
    if (!SAFE_ATTRIBUTES.has(key)) continue;
    const resolved = resolveString(value, model);
    if (resolved !== null) out[key] = resolved.length > 200 ? `${resolved.slice(0, 200)}…` : resolved;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) out[key] = value.slice(0, 10);
  }
  const envBlock = (Array.isArray(resource.body.environment) ? resource.body.environment[0] : resource.body.environment) as
    | { variables?: Record<string, unknown> }
    | undefined;
  if (envBlock?.variables) out.envVarNames = Object.keys(envBlock.variables);
  if (resource.body.count !== undefined || resource.body.for_each !== undefined) out.expanded = true;
  return out;
}

function lambdaEnv(resource: TfResource, model: TfModel): Map<string, EnvBinding> {
  const env = new Map<string, EnvBinding>();
  const blocks = Array.isArray(resource.body.environment) ? resource.body.environment : [resource.body.environment];
  for (const block of blocks) {
    const variables = block?.variables;
    if (!variables || typeof variables !== 'object') continue;
    for (const [name, value] of Object.entries<unknown>(variables)) {
      const ref = typeof value === 'string' ? findRefs(value).find((r) => r.kind === 'resource') : undefined;
      if (ref && ref.kind === 'resource') {
        env.set(name, { kind: 'ref', address: `${ref.type}.${ref.name}`, attribute: ref.attribute });
        continue;
      }
      const literal = resolveString(value, model);
      env.set(name, literal !== null ? { kind: 'literal', value: literal } : { kind: 'unresolved' });
    }
  }
  return env;
}

/** Edge meaning for a Terraform reference, from the attribute it appears in and the two resource types. */
function relationFor(sourceType: string, targetType: string, path: string): EdgeRelation {
  const attribute = path.split('.')[0]!;
  if (targetType === 'aws_iam_role' && !sourceType.startsWith('aws_iam_') && /(^|_)role(_arn)?$/.test(attribute)) return 'assumes_role';
  if (targetType === 'aws_lambda_function' && /^aws_(apigatewayv2|api_gateway)_integration$/.test(sourceType)) return 'invokes';
  if (targetType === 'aws_lambda_function' && (sourceType === 'aws_lambda_event_source_mapping' || sourceType === 'aws_lambda_function_url')) return 'invokes';
  if (sourceType === 'aws_route53_record' && /^aws_(cloudfront_distribution|apigatewayv2_|api_gateway_|lb|alb)/.test(targetType)) return 'routes_to';
  if (sourceType === 'aws_cloudfront_distribution' && /^aws_(s3_bucket|apigatewayv2_|api_gateway_|lb|alb|lambda_function)/.test(targetType)) return 'routes_to';
  return 'references';
}

/** Folder holding a Lambda's code, from its `source_dir` or the `archive_file` its `filename` points at. */
function resolveCodeDir(lambda: TfResource, model: TfModel): string | null {
  const dir = resourceDir(lambda);
  const candidates: { value: unknown; isFile: boolean }[] = [{ value: lambda.body.source_dir, isFile: false }];
  for (const { ref } of collectAttributeRefs({ f: lambda.body.filename })) {
    if (ref.kind === 'data' && ref.type === 'archive_file') {
      const data = model.data.get(`${ref.type}.${ref.name}`);
      candidates.push({ value: data?.body.source_dir, isFile: false }, { value: data?.body.source_file, isFile: true });
    }
  }
  for (const { value, isFile } of candidates) {
    if (typeof value !== 'string') continue;
    // path.module / path.root: treat as the module folder; relative paths are relative to it.
    const resolved = resolveString(value.replace(/\$\{path\.(?:module|root|cwd)\}/g, '.'), model);
    if (!resolved) continue;
    const path = posix
      .normalize(posix.join(dir, resolved))
      .replace(/^(\.\.\/)+/, '') // climbing out of the analyzed folder: keep what is inside it
      .replace(/^\.$/, '')
      .replace(/\/$/, '');
    if (!isFile) return path;
    const parent = posix.dirname(path);
    return parent === '.' ? '' : parent;
  }
  return null;
}

const stripExtension = (path: string) => path.replace(/\.[^./]+$/, '');

function resolveHandler(
  handler: string | undefined,
  runtime: string | null,
  codeDir: string | null,
  files: string[],
): { file: string | null; fn: string | null } {
  if (!handler || !handler.includes('.')) return { file: null, fn: null };
  const dot = handler.lastIndexOf('.');
  const fn = handler.slice(dot + 1);
  const moduleRef = handler.slice(0, dot);
  const modulePath = runtime?.startsWith('python') ? moduleRef.replace(/\./g, '/') : moduleRef;
  const wanted = codeDir ? posix.join(codeDir, modulePath) : modulePath;
  const exact = files.find((f) => stripExtension(f) === wanted);
  if (exact) return { file: exact, fn };
  // Without a known source folder, a handler like "index.handler" is only trusted if exactly one file fits.
  const matches = files.filter((f) => stripExtension(f).endsWith(`/${modulePath}`) || stripExtension(f) === modulePath);
  return { file: matches.length === 1 ? matches[0]! : null, fn };
}

// ------------------------------------------------------------------------------------------------------------
// Service-level name normalisation for literals found in code
// ------------------------------------------------------------------------------------------------------------

function nameFromLiteral(service: string, value: string): string {
  if (service === 'sqs') return value.slice(value.lastIndexOf('/') + 1);
  if (service === 'sns' || service === 'lambda') return value.startsWith('arn:') ? value.slice(value.lastIndexOf(':') + 1) : value;
  if (service === 's3') return value.startsWith('arn:aws:s3:::') ? value.slice('arn:aws:s3:::'.length).split('/')[0]! : value;
  if (service === 'dynamodb' && value.startsWith('arn:')) return value.slice(value.lastIndexOf('/') + 1);
  return value;
}

// ------------------------------------------------------------------------------------------------------------
// The linker
// ------------------------------------------------------------------------------------------------------------

export function linkGraph(model: TfModel, facts: CodeFacts): LinkResult {
  const builder = new GraphBuilder();
  const result: LinkResult = {
    builder,
    model,
    facts,
    roles: buildRoleModels(model),
    lambdas: new Map(),
    identifiers: new Map(),
    resolved: [],
    pending: [],
    missingEnv: [],
    unmanaged: [],
    unresolvedRefs: [],
    endpoints: { found: 0, unresolved: 0 },
  };

  // 1. Resource nodes ---------------------------------------------------------------------------------------
  for (const resource of model.resources) {
    builder.addNode({
      kind: 'resource',
      address: resource.address,
      name: resource.displayName ?? resource.name,
      terraformType: resource.type,
      filePath: resource.file,
      lineStart: resource.line,
      attributes: { ...safeAttributes(resource, model), ...resource.attributes },
    });
    result.identifiers.set(resource.address, identifierNames(resource, model));
  }

  const unresolved = (address: string, name: string, reason: string): NewNode =>
    builder.addNode({ kind: 'unresolved_ref', address, name, attributes: { reason } });

  // 2. Declared references (method 1: certain) ---------------------------------------------------------------
  for (const resource of model.resources) {
    const source = builder.node(resource.address)!;
    const link = (ref: TfRef, relation: EdgeRelation | null, path: string) => {
      if (ref.kind === 'module') {
        const target = unresolved(`module.${ref.name}`, `module.${ref.name}`, 'Modules are not analyzed (future work).');
        builder.addEdge(source, target, 'references', 'declared_reference', { attribute: path });
        result.unresolvedRefs.push({ source, target, reason: `${resource.address} depends on module.${ref.name}, which is not analyzed.` });
        return;
      }
      if (ref.kind !== 'resource') return; // var/local are resolved separately; data sources feed code mapping
      const address = `${ref.type}.${ref.name}`;
      if (address === resource.address) return;
      let target = builder.node(address);
      if (!target) {
        target = unresolved(address, address, 'Referenced but not declared in the analyzed infrastructure code.');
        result.unresolvedRefs.push({ source, target, reason: `${resource.address} references ${address}, which was not found.` });
      }
      const targetType = target.terraformType ?? ref.type;
      builder.addEdge(source, target, relation ?? relationFor(resource.type, targetType, path), 'declared_reference', {
        attribute: path,
        referencedAttribute: ref.attribute,
      });
    };
    for (const { path, ref } of collectAttributeRefs(resource.body)) link(ref, null, path);
    for (const ref of findDependsOnRefs(resource.body.depends_on)) link(ref, 'depends_on', 'depends_on');
  }

  // IAM: a role depends on every resource its policies name (the role breaks if that resource is replaced).
  for (const role of result.roles.values()) {
    const roleNode = builder.node(role.roleAddress);
    if (!roleNode) continue;
    for (const policy of role.policies) {
      for (const statement of policy.statements) {
        if (statement.effect !== 'Allow') continue;
        for (const resource of statement.resources) {
          if (resource.kind !== 'ref') continue;
          const target = builder.node(`${resource.ref.type}.${resource.ref.name}`);
          if (target) builder.addEdge(roleNode, target, 'grants_access', 'declared_reference', { actions: statement.actions, policy: policy.source });
        }
      }
    }
  }

  // 3. Compute mapping: which Lambda runs which code (method 3: high) -------------------------------------------
  const codeFiles = facts.files;
  const functionsByQualified = new Map<string, CodeFunction>(facts.functions.map((f) => [f.qualified, f]));
  const fileToLambdas = new Map<string, LambdaInfo[]>();

  for (const resource of model.resources.filter((r) => r.type === 'aws_lambda_function')) {
    const node = builder.node(resource.address)!;
    const runtime = typeof resource.body.runtime === 'string' ? resource.body.runtime : null;
    const codeDir = resolveCodeDir(resource, model);
    const handler = resolveHandler(typeof resource.body.handler === 'string' ? resource.body.handler : undefined, runtime, codeDir, codeFiles);
    const roleRef = collectAttributeRefs({ role: resource.body.role }).find(({ ref }) => ref.kind === 'resource' && ref.type === 'aws_iam_role');
    const files = new Set<string>();
    if (codeDir) {
      for (const file of codeFiles) if (file.startsWith(`${codeDir}/`)) files.add(file);
    } else if (handler.file) {
      // No source folder known: the handler's own folder, or just the handler when it sits at the root.
      const folder = posix.dirname(handler.file);
      if (folder === '.') files.add(handler.file);
      else for (const file of codeFiles) if (file.startsWith(`${folder}/`)) files.add(file);
    }

    const info: LambdaInfo = {
      address: resource.address,
      node,
      roleAddress: roleRef && roleRef.ref.kind === 'resource' ? `${roleRef.ref.type}.${roleRef.ref.name}` : null,
      runtime,
      handlerFile: handler.file,
      handlerFunction: handler.fn,
      codeDir,
      codeFiles: files,
      env: lambdaEnv(resource, model),
    };
    result.lambdas.set(resource.address, info);
    for (const file of files) fileToLambdas.set(file, [...(fileToLambdas.get(file) ?? []), info]);
  }

  // Code nodes are created on demand so only relevant files and functions appear in the graph.
  const ensureFile = (path: string): NewNode => {
    const existing = builder.node(path);
    if (existing) return existing;
    const node = builder.addNode({ kind: 'code_file', address: path, name: posix.basename(path), filePath: path });
    for (const lambda of fileToLambdas.get(path) ?? []) {
      builder.addEdge(node, lambda.node, 'runs_code', 'code_mapping', { sourceDir: lambda.codeDir, handler: lambda.handlerFile === path });
    }
    return node;
  };
  const ensureFunction = (qualified: string): NewNode => {
    const existing = builder.node(qualified);
    if (existing) return existing;
    const fn = functionsByQualified.get(qualified)!;
    const file = ensureFile(fn.file);
    const node = builder.addNode({
      kind: 'code_function',
      address: qualified,
      name: fn.name,
      parentId: file.id,
      filePath: fn.file,
      lineStart: fn.lineStart,
      lineEnd: fn.lineEnd,
    });
    for (const lambda of fileToLambdas.get(fn.file) ?? []) {
      const isHandler = lambda.handlerFile === fn.file && lambda.handlerFunction === fn.name;
      builder.addEdge(node, lambda.node, 'runs_code', 'code_mapping', { sourceDir: lambda.codeDir, handler: isHandler });
    }
    return node;
  };
  const sourceNodeFor = (call: { function: string | null; file: string }): NewNode =>
    call.function && functionsByQualified.has(call.function) ? ensureFunction(call.function) : ensureFile(call.file);

  for (const lambda of result.lambdas.values()) {
    if (lambda.handlerFile && lambda.handlerFunction) {
      const qualified = `${lambda.handlerFile}::${lambda.handlerFunction}`;
      if (functionsByQualified.has(qualified)) ensureFunction(qualified);
      else ensureFile(lambda.handlerFile);
    }
  }

  // 4. Code to resources (method 2: env var bridge, plus literal names) ---------------------------------------------
  const findByLiteral = (service: string, value: string): NewNode | undefined => {
    const wanted = nameFromLiteral(service, value);
    const type = SERVICE_RESOURCE_TYPE[service];
    const match = model.resources.find((r) => r.type === type && result.identifiers.get(r.address)?.includes(wanted));
    return match ? builder.node(match.address) : undefined;
  };

  const literalTarget = (call: SdkCall, value: string, source: NewNode, lambda: LambdaInfo | null, via: Record<string, unknown>) => {
    const match = findByLiteral(call.op.service, value);
    if (match) {
      builder.addEdge(source, match, call.op.relation, 'code_mapping', { ...via, match: 'literal_name', value, operations: [call.action], locations: [`${call.file}:${call.line}`] });
      result.resolved.push({ call, source, target: match, lambda, inferred: false });
      return;
    }
    const name = nameFromLiteral(call.op.service, value);
    const unmanaged = builder.addNode({
      kind: 'unmanaged_resource',
      address: `unmanaged:${call.op.service}:${name}`,
      name,
      terraformType: SERVICE_RESOURCE_TYPE[call.op.service] ?? null,
      attributes: { service: call.op.service, reason: 'Named in code but not defined in the analyzed infrastructure code.' },
    });
    builder.addEdge(source, unmanaged, call.op.relation, 'code_mapping', { ...via, hardcoded: true, value, operations: [call.action], locations: [`${call.file}:${call.line}`] });
    result.unmanaged.push({ call, source, target: unmanaged, name });
    result.resolved.push({ call, source, target: unmanaged, lambda, inferred: false });
  };

  for (const call of facts.sdkCalls) {
    const lambdas = fileToLambdas.get(call.file) ?? [];
    const source = sourceNodeFor(call);
    const location = { file: call.file, line: call.line };

    if (call.target.kind === 'literal') {
      literalTarget(call, call.target.value, source, lambdas[0] ?? null, location);
      continue;
    }
    if (call.target.kind === 'env') {
      const envName = call.target.name;
      if (lambdas.length === 0) {
        result.pending.push({ call, source, lambdas, reason: `Reads ${envName}, but the file is not mapped to any Lambda, so the variable can't be traced.` });
        continue;
      }
      for (const lambda of lambdas) {
        const binding = lambda.env.get(envName);
        if (binding?.kind === 'ref') {
          const target = builder.node(binding.address) ?? unresolved(binding.address, binding.address, 'Referenced but not declared in the analyzed infrastructure code.');
          builder.addEdge(source, target, call.op.relation, 'env_var', { ...location, envVar: envName, operations: [call.action], locations: [`${call.file}:${call.line}`] });
          result.resolved.push({ call, source, target, lambda, inferred: false });
        } else if (binding?.kind === 'literal') {
          literalTarget(call, binding.value, source, lambda, { ...location, envVar: envName });
        } else if (binding?.kind === 'unresolved') {
          result.pending.push({ call, source, lambdas: [lambda], reason: `${envName} is set from an expression Ripplemap can't resolve.` });
        } else {
          result.missingEnv.push({ call, source, envVar: envName, lambda });
        }
      }
      continue;
    }
    result.pending.push({
      call,
      source,
      lambdas,
      reason: `The target ${call.target.hint ? `(${call.target.hint}) ` : ''}is built at runtime.`,
    });
  }

  // Env var reads that no SDK call explained still tie the function to the resource the variable names.
  for (const read of facts.envReads) {
    const lambdas = fileToLambdas.get(read.file) ?? [];
    for (const lambda of lambdas) {
      const binding = lambda.env.get(read.name);
      if (binding?.kind !== 'ref') continue;
      const target = builder.node(binding.address);
      if (!target) continue;
      const source = sourceNodeFor(read);
      if (builder.hasEdge(source, target)) continue;
      builder.addEdge(source, target, 'references', 'env_var', { file: read.file, line: read.line, envVar: read.name, note: 'env var read' });
    }
  }

  // 5. Calls between functions ---------------------------------------------------------------------------------------
  // A request enters at a Lambda's handler and often delegates (handler -> getOrder -> table). Only calls on a
  // path from a handler to a function that touches a resource are kept, so helpers don't clutter the graph.
  const handlerNames = [...result.lambdas.values()].flatMap((lambda) =>
    lambda.handlerFile && lambda.handlerFunction && functionsByQualified.has(`${lambda.handlerFile}::${lambda.handlerFunction}`)
      ? [`${lambda.handlerFile}::${lambda.handlerFunction}`]
      : [],
  );
  const calledBy = new Map<string, CodeCall[]>();
  const callersOf = new Map<string, string[]>();
  for (const call of facts.calls) {
    calledBy.set(call.caller, [...(calledBy.get(call.caller) ?? []), call]);
    callersOf.set(call.callee, [...(callersOf.get(call.callee) ?? []), call.caller]);
  }
  const walk = (starts: string[], next: (name: string) => string[]): Set<string> => {
    const seen = new Set(starts);
    const queue = [...starts];
    while (queue.length > 0) {
      for (const name of next(queue.shift()!)) {
        if (!seen.has(name)) {
          seen.add(name);
          queue.push(name);
        }
      }
    }
    return seen;
  };
  const reachableFromHandlers = walk(handlerNames, (name) => (calledBy.get(name) ?? []).map((call) => call.callee));
  const touchesResources = [...builder.nodes.values()].filter((n) => n.kind === 'code_function').map((n) => n.address);
  const leadsToResources = walk(touchesResources, (name) => callersOf.get(name) ?? []);
  for (const call of facts.calls) {
    if (!reachableFromHandlers.has(call.caller) || !leadsToResources.has(call.callee)) continue;
    builder.addEdge(ensureFunction(call.caller), ensureFunction(call.callee), 'calls', 'code_mapping', {
      file: call.file,
      line: call.line,
    });
  }

  // 6. Endpoints a caller can reach (API Gateway routes, REST methods, function URLs) -------------------------------
  result.endpoints = extractEndpoints(result);

  return result;
}

/** Records an inferred (Gemini) target for a pending call. */
export function addInferredLink(link: LinkResult, pending: PendingCall, target: NewNode, explanation: string): void {
  const { call, source } = pending;
  link.builder.addEdge(
    source,
    target,
    call.op.relation,
    'gemini_inference',
    { file: call.file, line: call.line, operations: [call.action], locations: [`${call.file}:${call.line}`], inferred: true },
    explanation,
  );
  link.resolved.push({ call, source, target, lambda: pending.lambdas[0] ?? null, inferred: true });
}

/** Candidate Terraform resources a call of this service could target. */
export function candidatesFor(link: LinkResult, pending: PendingCall): NewNode[] {
  const type = SERVICE_RESOURCE_TYPE[pending.call.op.service];
  return link.model.resources
    .filter((r) => r.type === type)
    .map((r) => link.builder.node(r.address)!)
    .filter(Boolean);
}
