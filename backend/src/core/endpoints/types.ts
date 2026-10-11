/**
 * Where a request can enter: an API Gateway HTTP API route, a REST API method, or a Lambda function URL.
 * Stored on the graph node that represents it, as `attributes.endpoint`.
 */
export type EndpointKind = 'http_api' | 'rest_api' | 'function_url';

export interface EndpointAttributes {
  kind: EndpointKind;
  /** Upper-case HTTP method, or `ANY`. */
  method: string;
  /** A path template such as `/orders/{id}`; `{proxy+}` style segments match one or more segments. */
  path: string;
  /** True for a catch-all (`$default` route, function URL), which only wins when nothing else matches. */
  isDefault?: boolean;
  /** How callers authenticate, when the infrastructure says (`JWT`, `AWS_IAM`, ...). Not simulated. */
  authorization?: string;
}
