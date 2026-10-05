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

describe("[features].fallback_widget", () => {
  it("is off unless the config switches it on (the widget is opt-in)", () => {
    expect(ConfigSchema.parse(minimal).features.fallback_widget).toBe(false);
    expect(ConfigSchema.parse({ ...minimal, features: {} }).features.fallback_widget).toBe(false);
    expect(ConfigSchema.parse({ ...minimal, features: { fallback_widget: true } }).features.fallback_widget).toBe(true);
  });
});

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

describe("site.public_url validation", () => {
  const withPublicUrl = (public_url: string) => ({ ...minimal, site: { domain: "example.com", name: "x", public_url } });
  const issues = (public_url: string) => {
    const result = ConfigSchema.safeParse(withPublicUrl(public_url));
    return result.success ? [] : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it.each(["https://www.example.com", "http://localhost:8787", "https://example.com:8443", "HTTPS://Example.COM"])(
    "accepts the origin %j",
    (publicUrl) => {
      expect(ConfigSchema.parse(withPublicUrl(publicUrl)).site.public_url).toBe(publicUrl);
    },
  );

  it.each([
    ["no scheme", "localhost:8787"],
    ["a bare host", "example.com"],
    ["a scheme other than http(s)", "ftp://example.com"],
    ["a trailing slash (every URL is public_url + path)", "https://example.com/"],
    ["a path", "https://example.com/blog"],
    ["a query", "https://example.com?x=1"],
    ["a fragment", "https://example.com#top"],
    ["credentials", "https://user:pw@example.com"],
    ["CR/LF (Link header injection)", "https://example.com\r\nSet-Cookie: x=1"],
    ["a tab, which the URL parser would silently drop", "https://exa\tmple.com"],
    ["a space", "https://exa mple.com"],
    ["a double quote", 'https://example.com"'],
    ["a non-ASCII host", "https://exämple.com"],
    ["an IPv6 literal (the [site].domain charset has no brackets)", "http://[::1]:8787"],
    ["a port out of range", "https://example.com:99999"],
    ["port 0", "http://localhost:0"],
  ])("rejects %s: %j", (_label, publicUrl) => {
    const found = issues(publicUrl);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^site\.public_url: /);
  });

  it("says the host or port is invalid when the charset fits but the URL does not parse", () => {
    for (const value of ["https://example.com:99999", "http://localhost:0"]) {
      const found = issues(value);
      expect(found).toEqual([expect.stringMatching(/the host or port is invalid/)]);
      expect(found[0]).not.toMatch(/must be from 1 to 65535/);
    }
  });

  it("still accepts a config without public_url", () => {
    expect(ConfigSchema.parse(minimal).site.public_url).toBeUndefined();
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
  it("defaults: feature off, ARD v0.91 canonical path, predecessor path as a 301 alias, synthesize mode, empty optionals", () => {
    const c = ConfigSchema.parse(minimal);
    expect(c.features.ai_catalog).toBe(false);
    expect(c.ai_catalog.path).toBe("/.well-known/ard.json");
    expect(c.ai_catalog.aliases).toEqual(["/.well-known/ai-catalog.json"]);
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

  it("accepts an empty aliases list (no redirect)", () => {
    expect(ConfigSchema.parse({ ...minimal, ai_catalog: { aliases: [] } }).ai_catalog.aliases).toEqual([]);
  });

  it("skill_type defaults to application/ai-skill+md and accepts the two other skill types", () => {
    expect(ConfigSchema.parse(minimal).ai_catalog.skill_type).toBe("application/ai-skill+md");
    for (const t of ['text/markdown; profile="urn:air:agent-skills"', "application/agent-skills+md"]) {
      expect(ConfigSchema.parse({ ...minimal, ai_catalog: { skill_type: t } }).ai_catalog.skill_type).toBe(t);
    }
  });

  it("skill_type rejects anything else", () => {
    for (const t of ["application/ai-skill", "text/markdown", ""]) {
      expect(ConfigSchema.safeParse({ ...minimal, ai_catalog: { skill_type: t } }).success, t).toBe(false);
    }
  });
});

describe("agent_skills.name", () => {
  const withName = (name: string) => ({ ...minimal, agent_skills: { name } });

  it("may be empty (derived from [site].name)", () => {
    expect(ConfigSchema.parse(minimal).agent_skills.name).toBe("");
    expect(ConfigSchema.safeParse(withName("")).success).toBe(true);
  });

  it.each(["site", "example-site", "a1", "my-2nd-shop", "x", "a".repeat(64)])("accepts the skill name %s", (name) => {
    expect(ConfigSchema.parse(withName(name)).agent_skills.name).toBe(name);
  });

  it("rejects a name over 64 characters", () => {
    const r = ConfigSchema.safeParse(withName("a".repeat(65)));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toEqual(["agent_skills", "name"]);
  });

  it.each([
    ["uppercase", "Example"],
    ["a space", "example site"],
    ["a leading hyphen", "-site"],
    ["a trailing hyphen", "site-"],
    ["a double hyphen", "my--site"],
    ["an underscore", "my_site"],
    ["a non-ASCII letter", "café"],
    ["a dot", "site.v2"],
  ])("rejects a name with %s", (_label, name) => {
    const r = ConfigSchema.safeParse(withName(name));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.path).toEqual(["agent_skills", "name"]);
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
    { name: "ai_catalog.aliases", withPath: (p) => ({ ai_catalog: { aliases: [p] } }) },
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
      ...c.ai_catalog.aliases,
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

describe("input_schema enum", () => {
  const withProperty = (property: Record<string, unknown>) => ({
    ...minimal,
    tools: [{ ...minimal.tools[0]!, input_schema: { type: "object", required: [], properties: { p: property } } }],
  });
  const messages = (property: Record<string, unknown>): string[] => {
    const r = ConfigSchema.safeParse(withProperty(property));
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it.each([
    ["string", ["a", "b"]],
    ["integer", [1, 2, 50]],
    ["number", [0.5, 1, 1.5]],
    ["boolean", [true]],
    ["boolean", [true, false]],
  ])("accepts an enum of the declared type (%s %j)", (type, values) => {
    expect(messages({ type, enum: values })).toEqual([]);
  });

  it.each([
    ["integer", ["1"], '"1"'],
    ["integer", [1, 1.5], "1.5"],
    ["integer", [true], "true"],
    ["number", ["x"], '"x"'],
    ["number", [1, "2"], '"2"'],
    ["boolean", ["true"], '"true"'],
    ["boolean", [1], "1"],
    ["string", [1], "1"],
    ["string", ["a", true], "true"],
  ])("rejects an enum whose values do not match the declared type (%s %j)", (type, values, offender) => {
    const found = messages({ type, enum: values });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^tools\.0\.input_schema\.properties\.p\.enum\.\d+: /);
    expect(found[0]).toContain(`type "${type}"`);
    expect(found[0]).toContain(offender);
  });

  it("names every value that does not fit, not only the first", () => {
    const found = messages({ type: "integer", enum: ["a", 2, "c"] });
    expect(found).toHaveLength(2);
  });

  it("rejects an enum on an array property: its entries are what the enum belongs on (items)", () => {
    const found = messages({ type: "array", enum: ["a"], items: { type: "string" } });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^tools\.0\.input_schema\.properties\.p\.enum: /);
    expect(found[0]).toContain("array");
    expect(found[0]).toContain("items");
  });

  it("accepts the enum on the items of an array, and checks it against the type of the items", () => {
    expect(messages({ type: "array", items: { type: "integer", enum: [1, 2] } })).toEqual([]);
    const found = messages({ type: "array", items: { type: "integer", enum: ["1"] } });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/properties\.p\.items\.enum\.0: /);
  });

  it("leaves a property without an enum alone", () => {
    expect(messages({ type: "integer", minimum: 1 })).toEqual([]);
    expect(messages({ type: "array", items: { type: "string" } })).toEqual([]);
  });
});

describe("input_schema required", () => {
  const schema = (input_schema: Record<string, unknown>) => ({
    ...minimal,
    tools: [{ ...minimal.tools[0]!, input_schema }],
  });
  const messages = (input_schema: Record<string, unknown>): string[] => {
    const r = ConfigSchema.safeParse(schema(input_schema));
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };

  it("accepts names that are all declared, and an empty list", () => {
    expect(messages({ type: "object", required: ["a"], properties: { a: { type: "string" } } })).toEqual([]);
    expect(messages({ type: "object", required: [], properties: {} })).toEqual([]);
    expect(messages({ type: "object", properties: { a: { type: "string" } } })).toEqual([]);
  });

  it("rejects a required name that is not declared in properties, naming its place in the list", () => {
    const found = messages({ type: "object", required: ["a", "token"], properties: { a: { type: "string" } } });
    expect(found).toEqual([
      'tools.0.input_schema.required.1: required name "token" is not declared in properties (only declared properties reach an executor, so it would be dropped)',
    ]);
  });

  it("rejects every undeclared required name, and any when there are no properties at all", () => {
    expect(messages({ type: "object", required: ["x", "y"], properties: {} })).toHaveLength(2);
    expect(messages({ type: "object", required: ["x"] })).toHaveLength(1);
  });

  it("does not take an inherited name for a declared one", () => {
    expect(messages({ type: "object", required: ["constructor"], properties: {} })).toHaveLength(1);
    expect(messages({ type: "object", required: ["toString"], properties: { a: { type: "string" } } })).toHaveLength(1);
  });
});
