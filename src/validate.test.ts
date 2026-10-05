import { describe, it, expect } from "vitest";
import { declaredProperties, validateInput } from "./validate";
import type { InputSchemaConfig } from "./config-types";

const schema: InputSchemaConfig = {
  type: "object",
  required: ["query"],
  properties: {
    query: { type: "string" },
    limit: { type: "integer", minimum: 1, maximum: 50 },
    slug: { type: "string", pattern: "^[a-z0-9-]+$" },
    active: { type: "boolean" },
    tags: { type: "array", items: { type: "string" } },
  },
};

describe("validateInput", () => {
  it("accepts a valid input", () => {
    const r = validateInput(schema, { query: "hello", limit: 10 });
    expect(r.ok).toBe(true);
  });

  it("rejects missing required field", () => {
    const r = validateInput(schema, { limit: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/missing required/i);
  });

  it("rejects wrong type", () => {
    const r = validateInput(schema, { query: 123 });
    expect(r.ok).toBe(false);
  });

  it("rejects integer out of range", () => {
    const r = validateInput(schema, { query: "x", limit: 999 });
    expect(r.ok).toBe(false);
  });

  it("rejects string not matching pattern", () => {
    const r = validateInput(schema, { query: "x", slug: "Bad Slug" });
    expect(r.ok).toBe(false);
  });

  it("accepts boolean", () => {
    const r = validateInput(schema, { query: "x", active: true });
    expect(r.ok).toBe(true);
  });

  it("validates array items", () => {
    const r = validateInput(schema, { query: "x", tags: ["a", "b"] });
    expect(r.ok).toBe(true);
    const bad = validateInput(schema, { query: "x", tags: ["a", 5] });
    expect(bad.ok).toBe(false);
  });

  it("tolerates extra properties", () => {
    const r = validateInput(schema, { query: "x", extra: "anything" });
    expect(r.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(validateInput(schema, null).ok).toBe(false);
    expect(validateInput(schema, "string").ok).toBe(false);
    expect(validateInput(schema, [1, 2, 3]).ok).toBe(false);
  });
});

describe("validateInput: enum on every scalar type", () => {
  const enums: InputSchemaConfig = {
    type: "object",
    required: [],
    properties: {
      kind: { type: "string", enum: ["a", "b"] },
      size: { type: "integer", enum: [10, 20, 50] },
      ratio: { type: "number", enum: [0.5, 1.5] },
      live: { type: "boolean", enum: [true] },
      sizes: { type: "array", items: { type: "integer", enum: [1, 2] } },
    },
  };

  it("still enforces a string enum", () => {
    expect(validateInput(enums, { kind: "a" }).ok).toBe(true);
    const r = validateInput(enums, { kind: "c" });
    expect(r).toEqual({ ok: false, message: '"kind" must be one of a, b' });
  });

  it("enforces an integer enum", () => {
    expect(validateInput(enums, { size: 20 }).ok).toBe(true);
    expect(validateInput(enums, { size: 30 })).toEqual({ ok: false, message: '"size" must be one of 10, 20, 50' });
  });

  it("enforces a number enum", () => {
    expect(validateInput(enums, { ratio: 1.5 }).ok).toBe(true);
    expect(validateInput(enums, { ratio: 2 })).toEqual({ ok: false, message: '"ratio" must be one of 0.5, 1.5' });
  });

  it("enforces a boolean enum", () => {
    expect(validateInput(enums, { live: true }).ok).toBe(true);
    expect(validateInput(enums, { live: false })).toEqual({ ok: false, message: '"live" must be one of true' });
  });

  it("enforces an enum on array items", () => {
    expect(validateInput(enums, { sizes: [1, 2, 1] }).ok).toBe(true);
    expect(validateInput(enums, { sizes: [1, 3] })).toEqual({ ok: false, message: '"sizes[1]" must be one of 1, 2' });
  });

  it("does not coerce: the string \"20\" is not the integer 20, and \"true\" is not true", () => {
    expect(validateInput(enums, { size: "20" }).ok).toBe(false);
    expect(validateInput(enums, { live: "true" }).ok).toBe(false);
  });

  it("checks the type before the enum, so a wrong type keeps its own message", () => {
    expect(validateInput(enums, { size: "x" })).toEqual({ ok: false, message: '"size" must be an integer' });
  });
});

describe("validateInput: names that exist on every object", () => {
  /** The body as the exec route parses it: JSON.parse makes "__proto__" an own property. */
  const parse = (text: string): unknown => JSON.parse(text);

  const requiring = (name: string): InputSchemaConfig => ({
    type: "object",
    required: [name],
    properties: { [name]: { type: "string" } },
  });

  it.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__", "isPrototypeOf"])(
    "a required %s is not satisfied by the name Object.prototype carries",
    (name) => {
      expect(validateInput(requiring(name), {})).toEqual({ ok: false, message: `missing required field "${name}"` });
      expect(validateInput(requiring(name), parse("{}"))).toEqual({ ok: false, message: `missing required field "${name}"` });
    },
  );

  it("a required constructor is satisfied by an own constructor", () => {
    expect(validateInput(requiring("constructor"), parse('{"constructor":"x"}')).ok).toBe(true);
  });

  it("a required __proto__ is satisfied by an own __proto__ from JSON, and typed like any property", () => {
    expect(validateInput(requiring("__proto__"), parse('{"__proto__":"x"}')).ok).toBe(true);
    expect(validateInput(requiring("__proto__"), parse('{"__proto__":5}'))).toEqual({
      ok: false,
      message: '"__proto__" must be a string',
    });
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "an undeclared %s in the input is an unknown property: tolerated, not checked against Object.prototype",
    (name) => {
      const input = parse(`{"query":"x","${name}":{"deep":1}}`);
      const r = validateInput(schema, input);
      expect(r.ok).toBe(true);
    },
  );

  it("an undeclared __proto__ does not change what the validated value inherits", () => {
    const r = validateInput(schema, parse('{"query":"x","__proto__":{"polluted":true}}'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    }
  });

  it("a declared property that shares such a name is validated against its own schema", () => {
    const declared: InputSchemaConfig = { type: "object", required: [], properties: { constructor: { type: "integer" } } };
    expect(validateInput(declared, parse('{"constructor":"x"}'))).toEqual({
      ok: false,
      message: '"constructor" must be an integer',
    });
    expect(validateInput(declared, parse('{"constructor":3}')).ok).toBe(true);
    expect(validateInput(declared, parse("{}")).ok).toBe(true);
  });
});

describe("declaredProperties", () => {
  const declared = { properties: { q: { type: "string" }, limit: { type: "integer" } } };
  const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;

  it("keeps the declared properties the input has, with their values, in a fresh object", () => {
    const input = { q: "a", limit: 3 };
    const out = declaredProperties(declared, input);
    expect(out).toEqual({ q: "a", limit: 3 });
    expect(out).not.toBe(input);
  });

  it("drops what the schema does not declare", () => {
    expect(declaredProperties(declared, { q: "a", role: "admin", nested: { x: 1 } })).toEqual({ q: "a" });
  });

  it("drops __proto__, constructor and toString from the input, and never sets a prototype", () => {
    const out = declaredProperties(declared, parse('{"q":"a","__proto__":{"isAdmin":true},"constructor":1,"toString":"t"}'));
    expect(out).toEqual({ q: "a" });
    expect(Object.keys(out)).toEqual(["q"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect((out as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  it("does not take a declared name from the prototype chain: an input without it has no such entry", () => {
    const schema = { properties: { constructor: { type: "string" }, toString: { type: "string" } } };
    expect(declaredProperties(schema, {})).toEqual({});
    expect(declaredProperties(schema, parse('{"constructor":"c"}'))).toEqual({ constructor: "c" });
  });

  it("does not treat a property named like an inherited one as declared when the schema merely inherits it", () => {
    expect(declaredProperties({ properties: {} }, parse('{"constructor":"c","hasOwnProperty":1}'))).toEqual({});
    expect(declaredProperties({}, { q: "a" })).toEqual({});
  });
});
