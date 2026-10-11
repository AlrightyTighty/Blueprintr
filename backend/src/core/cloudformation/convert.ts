import { posix } from 'node:path';
import type { TfModel, TfResource } from '../terraform/model.js';
import type { CfnResource, CfnTemplate } from './template.js';
import { isIgnoredType, snakeCase, terraformTypeFor } from './types.js';

/**
 * Turns CloudFormation resources into the same shape the Terraform reader produces, so one linker,
 * one IAM analysis and one set of findings serve both. The key step is rewriting intrinsic functions:
 *
 *   { Ref: Table }                          ->  "${aws_dynamodb_table.Table.name}"
 *   { "Fn::GetAtt": [Role, Arn] }           ->  "${aws_iam_role.Role.arn}"
 *   { "Fn::Sub": "arn:${Queue.Arn}/x" }     ->  "arn:${aws_sqs_queue.Queue.arn}/x"
 *
 * which is exactly the reference syntax `core/terraform/references.ts` already understands.
 */

interface Entry {
  type: string;
  name: string;
}

interface Context {
  template: CfnTemplate;
  /** logical id -> where it landed in the model */
  entries: Map<string, Entry>;
  exports: Map<string, { value: unknown; context: Context }>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `{ Ref: AWS::NoValue }` means "leave this out". */
const isNoValue = (v: unknown): boolean => isRecord(v) && v['Ref'] === 'AWS::NoValue';
const unresolved = (what: string) => `\${unresolved.${what.replace(/[^A-Za-z0-9_]/g, '_')}}`;

/** What `Ref` returns, per type: the attribute name used in the generated reference. */
const REF_ATTRIBUTE: Record<string, string> = {
  aws_sqs_queue: 'url',
  aws_dynamodb_table: 'name',
  aws_s3_bucket: 'bucket',
  aws_lambda_function: 'function_name',
  aws_iam_role: 'name',
  aws_sns_topic: 'arn',
};

// ---- intrinsic functions -------------------------------------------------------------------------------------------

function ref(name: string, ctx: Context): string {
  if (name.startsWith('AWS::')) return `\${pseudo.${name.slice(5)}}`;
  const entry = ctx.entries.get(name);
  if (entry) return `\${${entry.type}.${entry.name}.${REF_ATTRIBUTE[entry.type] ?? 'id'}}`;
  if (ctx.template.parameters.has(name)) return String(ctx.template.parameters.get(name));
  return `\${var.${name.replace(/[^A-Za-z0-9_]/g, '_')}}`; // a parameter with no default
}

function getAtt(logicalId: string, attribute: string, ctx: Context): string {
  const entry = ctx.entries.get(logicalId);
  if (!entry) return unresolved(`${logicalId}.${attribute}`);
  return `\${${entry.type}.${entry.name}.${snakeCase(attribute) || 'id'}}`;
}

function sub(text: string, variables: Record<string, unknown>, ctx: Context): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, inner: string) => {
    if (inner.startsWith('!')) return `{${inner.slice(1)}}`; // an escaped literal
    if (inner in variables) {
      const value = expr(variables[inner], ctx);
      return typeof value === 'string' || typeof value === 'number' ? String(value) : unresolved(inner);
    }
    const dot = inner.indexOf('.');
    return dot === -1 ? ref(inner, ctx) : getAtt(inner.slice(0, dot), inner.slice(dot + 1), ctx);
  });
}

function findInMap(args: unknown[], ctx: Context): unknown {
  const keys = args.map((a) => expr(a, ctx));
  if (keys.some((k) => typeof k !== 'string' || k.includes('${'))) return unresolved('FindInMap');
  const [mapName, first, second] = keys as string[];
  const value = (ctx.template.mappings as any)?.[mapName!]?.[first!]?.[second!];
  return value === undefined ? unresolved('FindInMap') : expr(value, ctx);
}

/** Rewrites any CloudFormation value; strings in the result use `${type.name.attr}` references. */
export function expr(value: unknown, ctx: Context, depth = 0): unknown {
  if (depth > 40) return unresolved('depth');
  if (Array.isArray(value)) return value.filter((v) => !isNoValue(v)).map((v) => expr(v, ctx, depth + 1));
  if (!isRecord(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1) {
    const key = keys[0]!;
    const arg = value[key];
    switch (key) {
      case 'Ref':
        return typeof arg === 'string' ? ref(arg, ctx) : unresolved('Ref');
      case 'Fn::GetAtt': {
        const [logical, attribute] = Array.isArray(arg) ? arg : [];
        const attr = typeof attribute === 'string' ? attribute : isRecord(attribute) ? '' : '';
        return typeof logical === 'string' ? getAtt(logical, attr, ctx) : unresolved('GetAtt');
      }
      case 'Fn::Sub':
        if (typeof arg === 'string') return sub(arg, {}, ctx);
        if (Array.isArray(arg) && typeof arg[0] === 'string') return sub(arg[0], isRecord(arg[1]) ? arg[1] : {}, ctx);
        return unresolved('Sub');
      case 'Fn::Join': {
        if (!Array.isArray(arg) || typeof arg[0] !== 'string' || !Array.isArray(arg[1])) return unresolved('Join');
        const parts = arg[1].map((p) => expr(p, ctx, depth + 1));
        return parts.every((p) => typeof p === 'string' || typeof p === 'number') ? parts.join(arg[0]) : unresolved('Join');
      }
      case 'Fn::Select': {
        const [index, list] = Array.isArray(arg) ? arg : [];
        const i = Number(expr(index, ctx, depth + 1));
        return Array.isArray(list) && Number.isInteger(i) && i in list ? expr(list[i], ctx, depth + 1) : unresolved('Select');
      }
      case 'Fn::If': {
        // Which branch applies depends on stack parameters, so prefer the one that sets a value.
        const [, whenTrue, whenFalse] = Array.isArray(arg) ? arg : [];
        return expr(isNoValue(whenTrue) ? whenFalse : whenTrue, ctx, depth + 1);
      }
      case 'Fn::FindInMap':
        return Array.isArray(arg) ? findInMap(arg, ctx) : unresolved('FindInMap');
      case 'Fn::Base64':
        return expr(arg, ctx, depth + 1);
      case 'Fn::ImportValue': {
        const name = expr(arg, ctx, depth + 1);
        const exported = typeof name === 'string' ? ctx.exports.get(name) : undefined;
        return exported ? expr(exported.value, exported.context, depth + 1) : unresolved(`import_${String(name)}`);
      }
      default:
        if (key.startsWith('Fn::') || key === 'Condition') return unresolved(key.replace('Fn::', ''));
    }
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => !isNoValue(v))
      .map(([k, v]) => [k, expr(v, ctx, depth + 1)]),
  );
}

// ---- per-type property shapes --------------------------------------------------------------------------------------------

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]);

/** The Terraform-shaped body the linker expects, built from CloudFormation properties. */
function bodyFor(tfType: string, resource: CfnResource, ctx: Context): Record<string, unknown> {
  const p = resource.properties;
  const x = (key: string): unknown => (p[key] === undefined ? undefined : expr(p[key], ctx));
  const nested = (...path: string[]): unknown => {
    let current: unknown = p;
    for (const key of path) current = isRecord(current) ? current[key] : undefined;
    return current === undefined ? undefined : expr(current, ctx);
  };
  const policyJson = (doc: unknown): string | undefined => (doc === undefined ? undefined : JSON.stringify(expr(doc, ctx)));

  // Start from every property (top-level keys in snake_case) so references are never lost,
  // then add the specific names the analysis reads.
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(p)) body[snakeCase(key)] = expr(value, ctx);

  const set = (key: string, value: unknown) => {
    if (value !== undefined) body[key] = value;
  };

  switch (tfType) {
    case 'aws_lambda_function': {
      set('function_name', x('FunctionName'));
      set('handler', x('Handler'));
      set('runtime', x('Runtime'));
      const variables = nested('Environment', 'Variables');
      if (isRecord(variables)) body.environment = [{ variables }];
      // Un-staged CDK assets (cdk synth --no-staging) point at the real source folder.
      const assetPath = resource.metadata['aws:asset:path'];
      if (typeof assetPath === 'string' && !/^asset\./.test(posix.basename(assetPath))) body.source_dir = assetPath;
      break;
    }
    case 'aws_dynamodb_table': {
      set('name', x('TableName'));
      const hash = asList(p['KeySchema']).find((k) => isRecord(k) && k['KeyType'] === 'HASH');
      if (isRecord(hash)) set('hash_key', expr(hash['AttributeName'], ctx));
      break;
    }
    case 'aws_s3_bucket':
      set('bucket', x('BucketName'));
      break;
    case 'aws_sqs_queue':
      set('name', x('QueueName'));
      break;
    case 'aws_sns_topic':
      set('name', x('TopicName'));
      break;
    case 'aws_iam_role': {
      set('name', x('RoleName'));
      const inline = asList(p['Policies']).flatMap((policy) =>
        isRecord(policy) ? [{ name: expr(policy['PolicyName'], ctx), policy: policyJson(policy['PolicyDocument']) }] : [],
      );
      if (inline.length > 0) body.inline_policy = inline;
      set('managed_policy_arns', x('ManagedPolicyArns'));
      break;
    }
    case 'aws_iam_role_policy': // AWS::IAM::Policy, and AWS::IAM::ManagedPolicy that names roles
      set('name', x('PolicyName'));
      set('role', x('Roles'));
      set('policy', policyJson(p['PolicyDocument']));
      break;
    case 'aws_iam_policy':
      set('name', x('ManagedPolicyName'));
      set('policy', policyJson(p['PolicyDocument']));
      break;
    case 'aws_s3_bucket_policy':
      set('bucket', x('Bucket'));
      set('policy', policyJson(p['PolicyDocument']));
      break;
    case 'aws_sqs_queue_policy':
      set('queue_url', x('Queues'));
      set('policy', policyJson(p['PolicyDocument']));
      break;
    case 'aws_lambda_permission':
      set('function_name', x('FunctionName'));
      set('source_arn', x('SourceArn'));
      break;
    case 'aws_lambda_event_source_mapping':
      set('event_source_arn', x('EventSourceArn'));
      set('function_name', x('FunctionName'));
      break;
    case 'aws_apigatewayv2_api':
      set('name', x('Name'));
      break;
    case 'aws_apigatewayv2_integration':
      set('api_id', x('ApiId'));
      set('integration_uri', x('IntegrationUri'));
      break;
    case 'aws_apigatewayv2_route':
      set('api_id', x('ApiId'));
      set('target', x('Target'));
      break;
    case 'aws_api_gateway_integration':
      set('rest_api_id', x('RestApiId'));
      set('uri', nested('Integration', 'Uri'));
      break;
    case 'aws_cloudfront_distribution': {
      set('aliases', nested('DistributionConfig', 'Aliases'));
      const origins = nested('DistributionConfig', 'Origins');
      if (Array.isArray(origins)) body.origin = origins.map((o) => (isRecord(o) ? { domain_name: o['DomainName'], origin_id: o['Id'] } : o));
      break;
    }
    case 'aws_route53_record': {
      set('name', x('Name'));
      set('zone_id', x('HostedZoneId'));
      const alias = nested('AliasTarget');
      if (isRecord(alias)) body.alias = [{ name: alias['DNSName'], zone_id: alias['HostedZoneId'] }];
      break;
    }
    case 'aws_route53_zone':
      set('name', x('Name'));
      break;
  }

  if (resource.dependsOn.length > 0) {
    body.depends_on = resource.dependsOn.flatMap((id) => {
      const entry = ctx.entries.get(id);
      return entry ? [`${entry.type}.${entry.name}`] : [];
    });
  }
  return body;
}

// ---- naming ---------------------------------------------------------------------------------------------------------------------

/** `MyStack/Api/ServiceRole/Resource` -> `Api/ServiceRole`: the construct path a developer would recognise. */
function constructName(metadata: Record<string, unknown>): string | undefined {
  const path = metadata['aws:cdk:path'];
  if (typeof path !== 'string') return undefined;
  const segments = path.split('/').slice(1); // drop the stack
  while (segments.length > 1 && (segments.at(-1) === 'Resource' || segments.at(-1) === 'Default')) segments.pop();
  return segments.length > 0 ? segments.join('/') : undefined;
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

function templateLabel(path: string): string {
  return sanitize(posix.basename(path).replace(/\.(template\.)?(json|ya?ml)$/i, ''));
}

/** Adds the resources of every template to `model`. Returns how many resources were added. */
export function addCloudFormation(model: TfModel, templates: CfnTemplate[]): number {
  const taken = new Set(model.resources.map((r) => r.address));
  const several = templates.length > 1;

  // Pass 1: decide every address, so references (including across stacks) can be written.
  const contexts: Context[] = [];
  const exports = new Map<string, { value: unknown; context: Context }>();
  for (const template of templates) {
    const entries = new Map<string, Entry>();
    for (const resource of template.resources) {
      if (isIgnoredType(resource.type)) continue;
      const type = terraformTypeFor(resource.type);
      let name = `${several ? `${templateLabel(template.path)}_` : ''}${sanitize(resource.logicalId)}`;
      while (taken.has(`${type}.${name}`)) name += '_cfn';
      taken.add(`${type}.${name}`);
      entries.set(resource.logicalId, { type, name });
    }
    contexts.push({ template, entries, exports });
  }
  for (const context of contexts) {
    for (const output of context.template.outputs) {
      const name = output.exportName === undefined ? undefined : expr(output.exportName, context);
      if (typeof name === 'string' && !name.includes('${')) exports.set(name, { value: output.value, context });
    }
  }

  // Pass 2: convert.
  let added = 0;
  for (const context of contexts) {
    for (const resource of context.template.resources) {
      const entry = context.entries.get(resource.logicalId);
      if (!entry) continue;
      const converted: TfResource = {
        type: entry.type,
        name: entry.name,
        address: `${entry.type}.${entry.name}`,
        file: context.template.path,
        line: resource.line,
        body: bodyFor(entry.type, resource, context),
        displayName: constructName(resource.metadata) ?? resource.logicalId,
        attributes: { iac: 'cloudformation', cfnType: resource.type, logicalId: resource.logicalId },
      };
      model.resources.push(converted);
      added++;
    }
  }
  return added;
}
