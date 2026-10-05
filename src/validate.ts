/**
 * Runtime validator for tool input against the limited JSON Schema subset we
 * accept in `[tools.input_schema]`. Build-time validation is done by Zod
 * (config-types.ts). This module runs at request time inside the Worker.
 *
 * Subset:
 *   - type: object only at the top level
 *   - properties: keyed by name, each with type string|integer|number|boolean|array
 *   - per-property: pattern (string), enum (any scalar type), minimum, maximum (integer and
 *     number), items (for array)
 *   - required: list of property names that must be present
 *
 * Returns { ok: true, value } or { ok: false, message } so callers can
 * convert into the executor envelope.
 */

import type { InputSchemaConfig, InputSchemaProperty_ } from "./config-types";

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Own-property test. `in` and a plain `obj[key]` read also see what every object inherits
 * (constructor, toString, hasOwnProperty, __proto__ ...), so an input or a schema that
 * names one of those would satisfy a required check it never met, or be typed against
 * Object.prototype. Every lookup by a name from the request or the schema goes through here.
 */
function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** What declaredProperties needs of an input schema. */
export interface DeclaredProperties {
  properties?: Record<string, unknown>;
}

/**
 * The properties of a validated input that the tool's schema declares, in a fresh object: own
 * entries of `input` whose name is an own key of `schema.properties`. validateInput tolerates
 * unknown properties (the URL template may read them), so this is what may leave the Worker
 * as a body: an undeclared property, and a `__proto__`, `constructor` or `toString` entry, never
 * does. Such a name cannot be declared (the build refuses it), and `__proto__` is skipped here
 * too, so it cannot become the prototype of the result.
 */
export function declaredProperties(schema: DeclaredProperties, input: Record<string, unknown>): Record<string, unknown> {
  const declared = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key === "__proto__" || !hasOwn(declared, key)) continue;
    out[key] = input[key];
  }
  return out;
}

export function validateInput(schema: InputSchemaConfig, raw: unknown): ValidationResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "input must be an object" };
  }
  const input = raw as Record<string, unknown>;

  // Required keys present, as own properties of the input.
  for (const r of schema.required ?? []) {
    if (!hasOwn(input, r)) {
      return { ok: false, message: `missing required field "${r}"` };
    }
  }

  // Validate each provided property against its schema (if declared).
  const props = schema.properties ?? {};
  for (const [key, value] of Object.entries(input)) {
    const propSchema = hasOwn(props, key) ? props[key] : undefined;
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
  // enum holds for every scalar type, after the type (and range) checks: the value must be
  // one of the listed values by strict equality, so "20" is not 20 and "true" is not true.
  // An array is not a scalar and matches no listed value; the enum of its entries sits on
  // `items`, checked in the recursive call above. (The build refuses an enum on an array
  // property, and one whose values do not fit the declared type: src/config-types.ts.)
  if (s.type !== "array" && s.enum && !s.enum.includes(value as string | number | boolean)) {
    return { ok: false, message: `"${key}" must be one of ${s.enum.join(", ")}` };
  }
  return { ok: true, value: { [key]: value } };
}
