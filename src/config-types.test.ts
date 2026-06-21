import { describe, it, expect } from "vitest";
import { ConfigSchema } from "./config-types";

const minimal = {
  schema_version: 1,
  site: { domain: "example.com", name: "Example" },
  origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"] },
  tools: [
    {
      name: "search_pages",
      description: "x",
      input_schema: { type: "object", required: [], properties: {} },
      executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml" },
    },
  ],
};

describe("ai_catalog config", () => {
  it("defaults: feature off, canonical path, synthesize mode, empty optionals", () => {
    const c = ConfigSchema.parse(minimal);
    expect(c.features.ai_catalog).toBe(false);
    expect(c.ai_catalog.path).toBe("/.well-known/ai-catalog.json");
    expect(c.ai_catalog.mode).toBe("synthesize");
    expect(c.ai_catalog.host_identifier).toBe("");
    expect(c.ai_catalog.representative_queries).toEqual([]);
    expect(c.ai_catalog.tags).toEqual([]);
    expect(c.cache.ai_catalog_max_age).toBe(300);
  });

  it("accepts overrides and enforces representative_queries max 5", () => {
    const c = ConfigSchema.parse({
      ...minimal,
      features: { ai_catalog: true },
      ai_catalog: { mode: "merge", host_identifier: "did:web:acme.com", tags: ["a"], representative_queries: ["q1", "q2"] },
    });
    expect(c.features.ai_catalog).toBe(true);
    expect(c.ai_catalog.mode).toBe("merge");
    expect(c.ai_catalog.host_identifier).toBe("did:web:acme.com");
    expect(() =>
      ConfigSchema.parse({ ...minimal, ai_catalog: { representative_queries: ["1", "2", "3", "4", "5", "6"] } }),
    ).toThrow();
  });
});
