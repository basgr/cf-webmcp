/**
 * Runtime validator for tool input against the limited JSON Schema subset we
 * accept in `[tools.input_schema]`. Build-time validation is done by Zod
 * (config-types.ts). This module runs at request time inside the Worker.
 *
 * Subset:
 *   - type: object only at the top level
 *   - properties: keyed by name, each with type string|integer|number|boolean|array
 *   - per-property: pattern (string), enum, minimum, maximum, items (for array)
 *   - required: list of property names that must be present
 *
 * Returns { ok: true, value } or { ok: false, message } so callers can
 * convert into the executor envelope.
 */

import type { InputSchemaConfig, InputSchemaProperty_ } from "./config-types";

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

export function validateInput(schema: InputSchemaConfig, raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "input must be an object" };
  }
  const input = raw as Record<string, unknown>;

  // Required keys present.
  for (const r of schema.required ?? []) {
    if (!(r in input)) {
      return { ok: false, message: `missing required field "${r}"` };
    }
  }

  // Validate each provided property against its schema (if declared).
  const props = schema.properties ?? {};
  for (const [key, value] of Object.entries(input)) {
    const propSchema = props[key];
    if (!propSchema) {
      // Unknown properties are tolerated (passed through). Tools that want
      // strictness can use a regex or specific schema constraint on input.
      continue;
    }
    const result = validateProperty(propSchema as InputSchemaProperty_, key, value);
    if (!result.ok) return result;
  }
  return { ok: true, value: input };
}

function validateProperty(
  schema: InputSchemaProperty_,
  key: string,
  value: unknown,
): ValidationResult {
  const s = schema as {
    type: string;
    pattern?: string;
    enum?: Array<string | number | boolean>;
    minimum?: number;
    maximum?: number;
    items?: InputSchemaProperty_;
  };

  switch (s.type) {
    case "string":
      if (typeof value !== "string") return { ok: false, message: `"${key}" must be a string` };
      if (s.pattern) {
        try {
          if (!new RegExp(s.pattern).test(value)) {
            return { ok: false, message: `"${key}" does not match pattern ${s.pattern}` };
          }
        } catch {
          return { ok: false, message: `"${key}" has malformed pattern in schema` };
        }
      }
      if (s.enum && !s.enum.includes(value)) {
        return { ok: false, message: `"${key}" must be one of ${s.enum.join(", ")}` };
      }
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return { ok: false, message: `"${key}" must be an integer` };
      }
      if (s.minimum !== undefined && value < s.minimum)
        return { ok: false, message: `"${key}" < minimum ${s.minimum}` };
      if (s.maximum !== undefined && value > s.maximum)
        return { ok: false, message: `"${key}" > maximum ${s.maximum}` };
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, message: `"${key}" must be a number` };
      }
      if (s.minimum !== undefined && value < s.minimum)
        return { ok: false, message: `"${key}" < minimum ${s.minimum}` };
      if (s.maximum !== undefined && value > s.maximum)
        return { ok: false, message: `"${key}" > maximum ${s.maximum}` };
      break;
    case "boolean":
      if (typeof value !== "boolean") return { ok: false, message: `"${key}" must be a boolean` };
      break;
    case "array":
      if (!Array.isArray(value)) return { ok: false, message: `"${key}" must be an array` };
      if (s.items) {
        for (let i = 0; i < value.length; i++) {
          const r = validateProperty(s.items, `${key}[${i}]`, value[i]);
          if (!r.ok) return r;
        }
      }
      break;
    default:
      return { ok: false, message: `"${key}" has unsupported schema type "${s.type}"` };
  }
  return { ok: true, value: { [key]: value } };
}
