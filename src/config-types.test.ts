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

describe("site.domain validation", () => {
  it("accepts a bare hostname and a hostname:port", () => {
    expect(ConfigSchema.parse({ ...minimal, site: { domain: "example.com", name: "x" } }).site.domain).toBe(
      "example.com",
    );
    expect(ConfigSchema.parse({ ...minimal, site: { domain: "localhost:8787", name: "x" } }).site.domain).toBe(
      "localhost:8787",
    );
  });

  it("rejects a domain containing CRLF (header/text injection vector)", () => {
    expect(() =>
      ConfigSchema.parse({ ...minimal, site: { domain: "example.com\r\nSet-Cookie: x=1", name: "x" } }),
    ).toThrow();
  });

  it("rejects a domain containing a double-quote", () => {
    expect(() => ConfigSchema.parse({ ...minimal, site: { domain: 'example.com"', name: "x" } })).toThrow();
  });

  it("rejects a domain carrying a scheme or path", () => {
    expect(() => ConfigSchema.parse({ ...minimal, site: { domain: "https://example.com", name: "x" } })).toThrow();
    expect(() => ConfigSchema.parse({ ...minimal, site: { domain: "example.com/foo", name: "x" } })).toThrow();
  });
});

describe("forms selector grammar", () => {
  const form = (selector: string, params: Array<{ selector: string; description: string }> = []) => ({
    ...minimal,
    forms: [{ name: "contact", description: "Contact form.", selector, params }],
  });

  it("accepts supported form and param selectors", () => {
    const c = ConfigSchema.parse(
      form('form[action="/a,b"]#contact', [
        { selector: "input[name=email]", description: "Email." },
        { selector: "> input", description: "Direct child input." },
        { selector: "li:nth-child(2n+1) input", description: "Odd rows." },
      ]),
    );
    expect(c.forms[0]!.selector).toBe('form[action="/a,b"]#contact');
  });

  it("rejects a form selector lol-html cannot parse, naming the construct", () => {
    const r = ConfigSchema.safeParse(form("form:has(input)"));
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "forms.0.selector");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain(":has");
    }
  });

  it("rejects sibling combinators, pseudo-elements and selector lists in a form selector", () => {
    for (const sel of ["form + form", "form ~ div", "form::before", "form#a, form#b", "form:hover"]) {
      expect(ConfigSchema.safeParse(form(sel)).success, sel).toBe(false);
    }
  });

  it("rejects a leading child combinator in a form selector but not in a param selector", () => {
    expect(ConfigSchema.safeParse(form("> input")).success).toBe(false);
    expect(ConfigSchema.safeParse(form("form#c", [{ selector: "> input", description: "d" }])).success).toBe(true);
  });

  it("rejects an unsupported param selector at the param path", () => {
    const r = ConfigSchema.safeParse(
      form("form#c", [{ selector: "input:has(+ label)", description: "d" }]),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "forms.0.params.0.selector");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain(":has");
    }
    expect(
      ConfigSchema.safeParse(form("form#c", [{ selector: "input, select", description: "d" }])).success,
    ).toBe(false);
  });

  it("still requires form selectors to start with `form`", () => {
    const r = ConfigSchema.safeParse(form("div#contact"));
    expect(r.success).toBe(false);
  });
});

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
