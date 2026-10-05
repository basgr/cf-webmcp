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

describe("[tools.annotations]", () => {
  const withAnnotations = (annotations: unknown) => ({
    ...minimal,
    tools: [{ ...minimal.tools[0]!, annotations }],
  });

  it("accepts consequential_hint beside the other two hints", () => {
    const parsed = ConfigSchema.parse(
      withAnnotations({ read_only_hint: true, untrusted_content_hint: false, consequential_hint: true }),
    );
    expect(parsed.tools[0]!.annotations).toEqual({
      read_only_hint: true,
      untrusted_content_hint: false,
      consequential_hint: true,
    });
  });

  it("rejects a non-boolean consequential_hint", () => {
    expect(() => ConfigSchema.parse(withAnnotations({ consequential_hint: "yes" }))).toThrow();
  });

  it("adds no default: an omitted hint stays out of the parsed config", () => {
    expect(ConfigSchema.parse(minimal).tools[0]!.annotations).toBeUndefined();
    expect(ConfigSchema.parse(withAnnotations({ read_only_hint: true })).tools[0]!.annotations).toEqual({
      read_only_hint: true,
    });
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

describe("positive selector grammar in forms", () => {
  const form = (selector: string, params: Array<{ selector: string; description: string }> = []) => ({
    ...minimal,
    forms: [{ name: "contact", description: "Contact form.", selector, params }],
  });

  it("rejects typos that make HTMLRewriter throw, at the build", () => {
    for (const sel of [
      "form[action=/contact]",
      "form[data-id=123]",
      "input[name=2fa]",
      "form#123",
      "form.",
      "form:not()",
      "form:nth-child(foo)",
      "form:first-child(x)",
      "form/* x */",
    ]) {
      const selector = sel.startsWith("form") ? sel : `form ${sel}`;
      const r = ConfigSchema.safeParse(form(selector));
      expect(r.success, selector).toBe(false);
    }
  });

  it("rejects the same typos in a param selector, at the param path", () => {
    const r = ConfigSchema.safeParse(form("form#c", [{ selector: "input[name=2fa]", description: "d" }]));
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "forms.0.params.0.selector");
      expect(issue).toBeDefined();
      expect(issue!.message).toMatch(/quote/);
    }
  });
});

describe("dom_extract selector and strip", () => {
  const withExecutor = (executor: Record<string, unknown>) => ({
    ...minimal,
    tools: [
      {
        name: "read_page",
        description: "x",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "dom_extract", url_template: "https://example.com/page", ...executor },
      },
    ],
  });

  it("accepts the defaults and a comma list (the selector stands alone, so a list is fine)", () => {
    expect(ConfigSchema.safeParse(withExecutor({})).success).toBe(true);
    expect(ConfigSchema.safeParse(withExecutor({ selector: "main, article, [role=main]" })).success).toBe(true);
    expect(ConfigSchema.safeParse(withExecutor({ selector: "article.post > div.content" })).success).toBe(true);
    expect(
      ConfigSchema.safeParse(withExecutor({ strip: ["nav", "footer", ".cookie-banner", "div[aria-hidden=true]", "a, b"] }))
        .success,
    ).toBe(true);
  });

  it("rejects an unsupported selector, naming the construct at the selector path", () => {
    const r = ConfigSchema.safeParse(withExecutor({ selector: "main:has(a)" }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path.join(".") === "tools.0.executor.selector");
      expect(issue).toBeDefined();
      expect(issue!.message).toContain(":has");
    }
  });

  it("rejects an unsupported entry in strip, at the index of the bad entry", () => {
    const r = ConfigSchema.safeParse(withExecutor({ strip: ["nav", "aside:hover", "footer"] }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const paths = r.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("tools.0.executor.strip.1");
      expect(paths).not.toContain("tools.0.executor.strip.0");
      expect(paths).not.toContain("tools.0.executor.strip.2");
    }
  });

  it("rejects sibling combinators, a leading combinator and an empty selector", () => {
    for (const selector of ["main + p", "main ~ p", "> main", "", "main[role=]"]) {
      expect(ConfigSchema.safeParse(withExecutor({ selector })).success, JSON.stringify(selector)).toBe(false);
    }
    expect(ConfigSchema.safeParse(withExecutor({ strip: [""] })).success).toBe(false);
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

describe("path validation (PathString)", () => {
  // Every config field that holds a URL path of this Worker's own. Each one ends up in a Location
  // header, a Link header or a probe URL, so each one must stay a path on this host.
  const pathFields: Array<{ name: string; withPath: (p: string) => Record<string, unknown> }> = [
    { name: "manifest.path", withPath: (p) => ({ manifest: { path: p } }) },
    { name: "manifest.aliases", withPath: (p) => ({ manifest: { aliases: [p] } }) },
    { name: "webmcp_landing.path", withPath: (p) => ({ webmcp_landing: { path: p } }) },
    { name: "llms_txt.path", withPath: (p) => ({ llms_txt: { path: p } }) },
    { name: "robots_txt.path", withPath: (p) => ({ robots_txt: { path: p } }) },
    { name: "agents_md.path", withPath: (p) => ({ agents_md: { path: p } }) },
    { name: "agents_md.aliases", withPath: (p) => ({ agents_md: { aliases: [p] } }) },
    { name: "api_catalog.path", withPath: (p) => ({ api_catalog: { path: p } }) },
    { name: "ai_catalog.path", withPath: (p) => ({ ai_catalog: { path: p } }) },
    { name: "agent_skills.path", withPath: (p) => ({ agent_skills: { path: p } }) },
    { name: "agent_skills.aliases", withPath: (p) => ({ agent_skills: { aliases: [p] } }) },
    { name: "agent_skills_index.path", withPath: (p) => ({ agent_skills_index: { path: p } }) },
    { name: "paths.namespace", withPath: (p) => ({ paths: { namespace: p } }) },
  ];

  const rejected: Array<[string, string]> = [
    ["a leading // (protocol-relative: the browser would go to evil.example)", "//evil.example/mcp/"],
    ["a bare //", "//"],
    ["a leading ///", "///evil.example/"],
    ["a leading /\\ (browsers read the backslash as a slash)", "/\\evil.example/"],
    ["a backslash anywhere", "/mcp\\evil"],
    ["a space", "/mcp evil"],
    ["a TAB", "/mcp\tevil"],
    ["a CR", "/mcp\revil"],
    ["a LF", "/mcp\nevil"],
    ["a NUL", "/mcp\x00evil"],
    ["a C0 control (US)", "/mcp\x1fevil"],
    ["DEL", "/mcp\x7fevil"],
    ["a C1 control", "/mcp\x85evil"],
    ["a leading control character", "\x01/mcp"],
    ["a missing leading slash", "mcp"],
  ];

  for (const { name, withPath } of pathFields) {
    for (const [label, bad] of rejected) {
      it(`${name} rejects ${label}`, () => {
        expect(ConfigSchema.safeParse({ ...minimal, ...withPath(bad) }).success).toBe(false);
      });
    }
  }

  it("still accepts ordinary paths, including a double slash that is not at the start", () => {
    for (const ok of ["/", "/mcp", "/mcp/", "/.well-known/agents.md", "/a//b", "/a/b/", "/foo~bar", "/foo%20bar"]) {
      expect(ConfigSchema.safeParse({ ...minimal, webmcp_landing: { path: ok } }).success, ok).toBe(true);
    }
  });

  it("accepts every default path", () => {
    const c = ConfigSchema.parse(minimal);
    const all = [
      c.manifest.path,
      ...c.manifest.aliases,
      c.webmcp_landing.path,
      c.llms_txt.path,
      c.robots_txt.path,
      c.agents_md.path,
      ...c.agents_md.aliases,
      c.api_catalog.path,
      c.ai_catalog.path,
      c.agent_skills.path,
      ...c.agent_skills.aliases,
      c.agent_skills_index.path,
      c.paths.namespace,
    ];
    expect(all.every((p) => p.startsWith("/") && !p.startsWith("//"))).toBe(true);
  });
});

describe("paths.namespace", () => {
  const withNamespace = (namespace: string) => ({ ...minimal, paths: { namespace } });

  it("defaults to /_webmcp", () => {
    expect(ConfigSchema.parse(minimal).paths.namespace).toBe("/_webmcp");
    expect(ConfigSchema.parse({ ...minimal, paths: {} }).paths.namespace).toBe("/_webmcp");
  });

  it.each(["/_webmcp", "/_agents", "/api/webmcp", "/a/b/c", "/.webmcp", "/x"])("accepts %s", (ns) => {
    expect(ConfigSchema.parse(withNamespace(ns)).paths.namespace).toBe(ns);
  });

  it("rejects the bare root, which would make every URL under it protocol-relative", () => {
    const result = ConfigSchema.safeParse(withNamespace("/"));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((i) => i.message).join("\n")).toMatch(/namespace/);
  });

  it.each(["/_webmcp/", "/api/webmcp/", "//", "/a//"])("rejects %s, which ends in a slash", (ns) => {
    expect(ConfigSchema.safeParse(withNamespace(ns)).success).toBe(false);
  });

  it("keeps the PathString rules: it must start with a single slash", () => {
    expect(ConfigSchema.safeParse(withNamespace("_webmcp")).success).toBe(false);
    expect(ConfigSchema.safeParse(withNamespace("//evil.example/x")).success).toBe(false);
  });

  it("does not turn the same rule on the other path fields, where a trailing slash is the directory form", () => {
    expect(ConfigSchema.safeParse({ ...minimal, webmcp_landing: { path: "/mcp/" } }).success).toBe(true);
    expect(ConfigSchema.safeParse({ ...minimal, webmcp_landing: { path: "/" } }).success).toBe(true);
  });
});

describe("[origin_trial] block", () => {
  it("defaults to no tokens when the block is absent", () => {
    expect(ConfigSchema.parse(minimal).origin_trial).toEqual({ tokens: [] });
  });

  it("defaults tokens to an empty list for an empty block", () => {
    expect(ConfigSchema.parse({ ...minimal, origin_trial: {} }).origin_trial.tokens).toEqual([]);
  });

  it("accepts standard base64 tokens, with and without padding", () => {
    const tokens = ["AAAA", "Ab0+/xyz", "Ab0+/xy=", "Ab0+/x==", "A".repeat(400)];
    expect(ConfigSchema.parse({ ...minimal, origin_trial: { tokens } }).origin_trial.tokens).toEqual(tokens);
  });

  it("rejects tokens outside the base64 alphabet or with bad padding", () => {
    const bad = ["", "abc def", "abc\r\nOrigin-Trial: x", "abc-def_", "ab=cd", "ab===", "=abc", "abc!", "tok\u00e9n"];
    for (const token of bad) {
      expect(
        ConfigSchema.safeParse({ ...minimal, origin_trial: { tokens: [token] } }).success,
        JSON.stringify(token),
      ).toBe(false);
    }
  });

  it("does not echo a rejected token in the validation message", () => {
    const secret = "not a token ZZZ-secret";
    const result = ConfigSchema.safeParse({ ...minimal, origin_trial: { tokens: [secret] } });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error.issues)).not.toContain("secret");
  });

  it("rejects tokens that are not an array of strings", () => {
    expect(ConfigSchema.safeParse({ ...minimal, origin_trial: { tokens: "AAAA" } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ ...minimal, origin_trial: { tokens: [42] } }).success).toBe(false);
  });
});
