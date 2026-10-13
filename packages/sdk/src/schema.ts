import { z, type ZodType } from 'zod';
import { Ajv } from 'ajv';

export type Schema = ZodType | Record<string, unknown>;
export type InputOf<S extends Schema> = S extends ZodType ? z.infer<S> : Record<string, unknown>;
export type OutputOf<S extends Schema> = S extends ZodType ? z.infer<S> : unknown;

export function schemaJson(schema: Schema): Record<string, unknown> {
  return schema instanceof z.ZodType
    ? z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
    : schema;
}

const ajv = new Ajv({ strict: false, allErrors: true });

export function validateValue<S extends Schema>(schema: S, value: unknown, label: string): InputOf<S> {
  if (schema instanceof z.ZodType) return schema.parse(value) as InputOf<S>;
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(`${label} does not match its JSON Schema: ${ajv.errorsText(validate.errors)}`);
  return value as InputOf<S>;
}
