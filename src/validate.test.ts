import { describe, it, expect } from "vitest";
import { validateInput } from "./validate";
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
