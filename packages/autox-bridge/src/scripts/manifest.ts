import { z } from 'zod';

const nonempty = z.string().refine(value => value.trim().length > 0, 'Must be a nonempty string');
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
// Zod records deliberately skip __proto__; reject it BEFORE parsing so invalid
// declarations/inputs are not silently sanitized into valid ones.
const safeKeys = z.unknown().superRefine((value, context) => {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (reserved.has(key)) context.addIssue({ code: 'custom', path: [key], message: 'Reserved parameter name' });
    }
  }
});
const parameterName = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'Invalid parameter name')
  .refine(value => !reserved.has(value), 'Reserved parameter name');

function parameterSchema<T extends 'string' | 'number' | 'boolean', S extends z.ZodType<string | number | boolean>>(type: T, value: S) {
  return z.strictObject({
    type: z.literal(type),
    description: nonempty.optional(),
    required: z.boolean().optional(),
    default: value.optional(),
    enum: z.array(value).min(1).optional(),
  });
}

export const scriptValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const scriptParameterSchema = z.discriminatedUnion('type', [
  parameterSchema('string', z.string()),
  parameterSchema('number', z.number()),
  parameterSchema('boolean', z.boolean()),
]).superRefine((parameter, context) => {
  if (parameter.default !== undefined && parameter.enum && !(parameter.enum as (string | number | boolean)[]).includes(parameter.default)) {
    context.addIssue({ code: 'custom', path: ['default'], message: 'Default must belong to enum' });
  }
});

export const scriptManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z.string().max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'Expected a lowercase kebab-case name'),
  description: nonempty,
  runtime: z.literal('autox'),
  // Portable slash-separated relative path, not a URI, drive path or traversal.
  entry: nonempty.refine(value => !/[\\:\x00-\x1f]/.test(value)
    && !value.split('/').some(part => !part || part === '.' || part === '..') && value.endsWith('.js'),
  'entry must be a relative .js path inside the script directory'),
  parameters: safeKeys.pipe(z.record(parameterName, scriptParameterSchema)).optional(),
});

export function parseManifest(value: unknown): z.infer<typeof scriptManifestSchema> {
  return scriptManifestSchema.parse(value);
}

/** Build a strict schema from validated declarations. No coercion or unknown-key stripping. */
export function validateInput(manifest: z.infer<typeof scriptManifestSchema>, input: unknown): Record<string, z.infer<typeof scriptValueSchema>> {
  const shape: Record<string, z.ZodType> = Object.create(null);
  for (const [name, parameter] of Object.entries(manifest.parameters ?? {})) {
    const error = (issue: { input: unknown }) => issue.input === undefined ? `Missing required parameter: ${name}` : `Parameter ${name} must be ${parameter.type}`;
    let field: z.ZodType<string | number | boolean> = parameter.type === 'string' ? z.string({ error })
      : parameter.type === 'number' ? z.number({ error }) : z.boolean({ error });
    if (parameter.enum) {
      const allowed: readonly (string | number | boolean)[] = parameter.enum;
      field = field.refine(value => allowed.includes(value), `Parameter ${name} is not in its enum`);
    }
    shape[name] = parameter.default !== undefined ? field.default(parameter.default)
      : parameter.required ? field : field.optional();
  }
  const parsed = safeKeys.pipe(z.strictObject(shape)).parse(input);
  // Preserve omission of absent optional keys and the existing null-prototype result.
  return Object.assign(Object.create(null), parsed);
}
