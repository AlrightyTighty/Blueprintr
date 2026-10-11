import { z } from 'zod';
import { validationError } from './errors.js';

/** Parses `data` with `schema`, throwing a 422 problem with per-field errors on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  throw validationError(
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message,
    })),
  );
}

// Shared building blocks -----------------------------------------------------

export const uuid = z.string().uuid();
export const username = z.string().regex(/^[A-Za-z0-9_-]{3,39}$/, '3-39 characters: letters, digits, "_" or "-"');
export const password = z.string().min(10, 'At least 10 characters').max(128);
export const email = z.string().email().max(254);

/** Query-string boolean: only "true"/"false" are accepted. */
export const queryBoolean = z.enum(['true', 'false']).transform((v) => v === 'true');

export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(2000).optional(),
});

export const projectParams = z.object({ projectId: uuid });

/** A run UUID or the literal "current". */
export const runRef = z.union([uuid, z.literal('current')]);

export const confidenceEnum = z.enum(['certain', 'high', 'inferred']);
export const projectRoleEnum = z.enum(['owner', 'editor', 'viewer']);
export const invitableRoleEnum = z.enum(['editor', 'viewer']);
export const nodeKindEnum = z.enum(['resource', 'code_file', 'code_function', 'unmanaged_resource', 'unresolved_ref']);
export const findingKindEnum = z.enum(['permission_gap', 'over_broad_iam', 'unmanaged_resource', 'unresolved_reference']);
export const findingSeverityEnum = z.enum(['info', 'low', 'medium', 'high', 'critical']);
export const runStatusEnum = z.enum(['pending', 'running', 'succeeded', 'failed']);
