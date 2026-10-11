export interface FieldError {
  field: string;
  message: string;
}

/** An error that maps directly onto an RFC 9457 problem response. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    readonly detail?: string,
    readonly errors?: FieldError[],
  ) {
    super(detail ?? title);
    this.name = 'AppError';
  }
}

export const badRequest = (code: string, detail?: string) => new AppError(400, code, 'Bad request', detail);
export const unauthorized = (detail = 'Authentication is required.', code = 'unauthorized') =>
  new AppError(401, code, 'Unauthorized', detail);
export const forbidden = (detail = 'Your role does not allow this action.') =>
  new AppError(403, 'forbidden', 'Forbidden', detail);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', 'Not found', `${what} was not found.`);
export const conflict = (code: string, detail: string) => new AppError(409, code, 'Conflict', detail);
export const gone = (code: string, detail: string) => new AppError(410, code, 'Gone', detail);
export const payloadTooLarge = (detail: string) => new AppError(413, 'payload_too_large', 'Payload too large', detail);
export const validationError = (errors: FieldError[], detail = 'The request failed validation.') =>
  new AppError(422, 'validation_failed', 'Validation failed', detail, errors);
export const tooManyRequests = (detail = 'Too many requests. Try again shortly.') =>
  new AppError(429, 'rate_limited', 'Too many requests', detail);
export const badGateway = (service: string, detail?: string) =>
  new AppError(502, 'upstream_failed', 'Upstream service failed', detail ?? `${service} request failed.`);
export const notConfigured = (integration: string) =>
  new AppError(503, 'integration_not_configured', 'Not configured', `${integration} is not configured on this server.`);
