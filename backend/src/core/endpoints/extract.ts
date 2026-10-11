import type { LinkResult } from '../analysis/link.js';
import type { TfModel, TfResource } from '../terraform/model.js';
import { collectAttributeRefs, resolveString } from '../terraform/references.js';
import type { EndpointAttributes } from './types.js';

type ResourceRef = { type: string; name: string; attribute: string | null };

function firstResourceRef(value: unknown): ResourceRef | null {
  for (const { ref } of collectAttributeRefs({ value })) {
    if (ref.kind === 'resource') return { type: ref.type, name: ref.name, attribute: ref.attribute };
  }
  return null;
}

const asString = (value: unknown, model: TfModel): string | null => {
  const resolved = resolveString(value, model);
  return resolved !== null && resolved !== '' ? resolved : null;
};

/** `GET /orders/{id}` -> method and path; `$default` is the catch-all route. */
function fromRouteKey(routeKey: string): { method: string; path: string; isDefault: boolean } | null {
  if (routeKey === '$default') return { method: 'ANY', path: '/{proxy+}', isDefault: true };
  const match = /^([A-Za-z]+)\s+(\/\S*)$/.exec(routeKey.trim());
  return match ? { method: match[1]!.toUpperCase(), path: match[2]!, isDefault: false } : null;
}

/**
 * Follows a REST API method's `resource_id` up through `aws_api_gateway_resource.parent_id` to the API's
 * root, joining each `path_part`. Null when any link in the chain can't be read.
 */
function restPath(integration: TfResource, byAddress: Map<string, TfResource>, model: TfModel): string | null {
  const segments: string[] = [];
  let ref = firstResourceRef(integration.body.resource_id);
  for (let hops = 0; hops < 30 && ref; hops++) {
    if (ref.type === 'aws_api_gateway_rest_api') return `/${segments.join('/')}`;
    if (ref.type !== 'aws_api_gateway_resource') return null;
    const resource = byAddress.get(`${ref.type}.${ref.name}`);
    const part = resource ? asString(resource.body.path_part, model) : null;
    if (!resource || !part) return null;
    segments.unshift(part);
    ref = firstResourceRef(resource.body.parent_id);
  }
  return null;
}

/**
 * An integration usually writes `http_method = aws_api_gateway_method.x.http_method`, a reference to the
 * method resource, rather than repeating "GET". Follow it.
 */
function restMethod(integration: TfResource, byAddress: Map<string, TfResource>, model: TfModel): string | null {
  const literal = asString(integration.body.http_method, model);
  if (literal) return literal;
  const ref = firstResourceRef(integration.body.http_method);
  const method = ref ? byAddress.get(`${ref.type}.${ref.name}`) : undefined;
  return method ? asString(method.body.http_method, model) : null;
}

/** Terraform keeps authorization on `aws_api_gateway_method`; CloudFormation puts it on the Method itself. */
function restAuthorization(integration: TfResource, httpMethod: string, resources: TfResource[], model: TfModel): string | undefined {
  const own = asString(integration.body.authorization_type, model) ?? asString(integration.body.authorization, model);
  if (own) return own;
  const resourceRef = firstResourceRef(integration.body.resource_id);
  const method = resources.find(
    (r) =>
      r.type === 'aws_api_gateway_method' &&
      firstResourceRef(r.body.resource_id)?.name === resourceRef?.name &&
      asString(r.body.http_method, model)?.toUpperCase() === httpMethod.toUpperCase(),
  );
  return method ? asString(method.body.authorization, model) ?? undefined : undefined;
}

const usable = (authorization: string | null | undefined) => (authorization && authorization.toUpperCase() !== 'NONE' ? authorization : undefined);

/**
 * Marks the graph nodes that are request entry points by writing `attributes.endpoint`. Done during
 * analysis, so the stored graph alone is enough to list endpoints and trace a request later.
 */
export function extractEndpoints(link: LinkResult): { found: number; unresolved: number } {
  const { model, builder } = link;
  const byAddress = new Map(model.resources.map((r) => [r.address, r]));
  let found = 0;
  let unresolved = 0;

  const mark = (resource: TfResource, endpoint: EndpointAttributes | null) => {
    const node = builder.node(resource.address);
    if (!node) return;
    if (!endpoint) {
      unresolved++;
      return;
    }
    node.attributes.endpoint = endpoint;
    found++;
  };

  for (const resource of model.resources) {
    switch (resource.type) {
      case 'aws_apigatewayv2_route': {
        const key = asString(resource.body.route_key, model);
        const parsed = key ? fromRouteKey(key) : null;
        mark(
          resource,
          parsed
            ? {
                kind: 'http_api',
                method: parsed.method,
                path: parsed.path,
                ...(parsed.isDefault ? { isDefault: true } : {}),
                ...(usable(asString(resource.body.authorization_type, model)) ? { authorization: usable(asString(resource.body.authorization_type, model)) } : {}),
              }
            : null,
        );
        break;
      }
      case 'aws_api_gateway_integration': {
        const method = restMethod(resource, byAddress, model);
        const path = restPath(resource, byAddress, model);
        const authorization = method ? usable(restAuthorization(resource, method, model.resources, model)) : undefined;
        mark(resource, method && path ? { kind: 'rest_api', method: method.toUpperCase(), path, ...(authorization ? { authorization } : {}) } : null);
        break;
      }
      case 'aws_lambda_function_url': {
        const authorization = usable(asString(resource.body.authorization_type, model));
        mark(resource, { kind: 'function_url', method: 'ANY', path: '/{proxy+}', isDefault: true, ...(authorization ? { authorization } : {}) });
        break;
      }
    }
  }
  return { found, unresolved };
}
