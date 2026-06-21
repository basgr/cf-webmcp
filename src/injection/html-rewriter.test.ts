import { describe, it, expect } from "vitest";
import { injectIntoHtml, matchGlob, shouldInject, escapeAttr, formsForPath } from "./html-rewriter";
import type { Config, FormInjectionConfig } from "../config-types";

const baseConfig: Config = {
  schema_version: 1,
  site: { domain: "example.com", name: "x", description: "", locale: "en" },
  origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"], forward_cookies: false },
  features: {
    inject_html: true,
    webmcp_landing: true,
    manifest: true,
    link_header: true,
    link_tag: true,
    llms_txt: true,
    robots_txt: true, agents_md: true, api_catalog: true, ai_catalog: true, agent_skills: true, agent_skills_index: true, subresource_integrity: true,
    fallback_widget: true,
  },
  manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
  webmcp_landing: { path: "/mcp/" },
  llms_txt: { path: "/llms.txt", mode: "merge" },
  robots_txt: { path: "/robots.txt", mode: "merge" }, agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] }, api_catalog: { path: "/.well-known/api-catalog", mode: "merge" }, ai_catalog: { path: "/.well-known/ai-catalog.json", mode: "synthesize", host_identifier: "", representative_queries: [], tags: [] }, agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] }, agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
  paths: { namespace: "/_webmcp" },
  injection: { exclude_paths: ["/wp-admin/*", "/checkout/*"] },
  cache: {
    manifest_max_age: 300,
    manifest_s_maxage: 86400,
    manifest_swr: 604800, manifest_sie: 86400,
    landing_max_age: 300,
    landing_s_maxage: 86400, landing_swr: 86400, landing_sie: 86400,
    llms_txt_max_age: 300,
    llms_txt_s_maxage: 3600, llms_txt_swr: 86400, llms_txt_sie: 86400,
    robots_txt_max_age: 300,
    robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400, agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400, agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800, api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400, ai_catalog_max_age: 300, ai_catalog_s_maxage: 21600, ai_catalog_swr: 86400, ai_catalog_sie: 86400, agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400, agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
    bootstrap_max_age: 31536000,
    widget_max_age: 31536000,
    executor_defaults: { max_age: 0, s_maxage: 300, swr: 1800, sie: 86400 },
  },
  cors: { allowed_origins: [] },
  health: { public: true, token: "" },
  dev: { origin: "http://localhost:8080" },
  rate_limit: { requests_per_minute_per_ip: 60 },
  tools: [],
  forms: [],
};

const opts = {
  manifestUrl: "https://example.com/.well-known/webmcp.json",
  bootstrapUrl: "https://example.com/_webmcp/bootstrap.abc.js",
  emitLinkTag: true,
  forms: [],
};

describe("matchGlob", () => {
  it("matches with wildcard", () => {
    expect(matchGlob("/wp-admin/*", "/wp-admin/x")).toBe(true);
    expect(matchGlob("/wp-admin/*", "/wp-admin/")).toBe(true);
    expect(matchGlob("/wp-admin/*", "/wp/")).toBe(false);
  });

  it("escapes regex specials", () => {
    expect(matchGlob("/a.b", "/a.b")).toBe(true);
    expect(matchGlob("/a.b", "/axb")).toBe(false);
  });
});

describe("escapeAttr", () => {
  it("escapes & and quotes", () => {
    expect(escapeAttr('https://x?a=1&b="hi"')).toBe("https://x?a=1&amp;b=&quot;hi&quot;");
  });
});

describe("shouldInject", () => {
  const req = new Request("https://example.com/about");

  it("injects on 200 text/html", () => {
    const r = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(shouldInject(req, r, baseConfig)).toBe(true);
  });

  it("injects on text/html with utf-8 charset", () => {
    const r = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    expect(shouldInject(req, r, baseConfig)).toBe(true);
  });

  it("skips non-200", () => {
    const r = new Response("<html></html>", { status: 404, headers: { "content-type": "text/html" } });
    expect(shouldInject(req, r, baseConfig)).toBe(false);
  });

  it("skips non-html", () => {
    const r = new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    expect(shouldInject(req, r, baseConfig)).toBe(false);
  });

  it("skips non-utf-8", () => {
    const r = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html; charset=windows-1252" } });
    expect(shouldInject(req, r, baseConfig)).toBe(false);
  });

  it("skips excluded paths", () => {
    const adminReq = new Request("https://example.com/wp-admin/edit.php");
    const r = new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
    expect(shouldInject(adminReq, r, baseConfig)).toBe(false);
  });
});

describe("injectIntoHtml", () => {
  async function inject(html: string): Promise<string> {
    const res = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const out = injectIntoHtml(res, opts);
    return out.text();
  }

  it("adds <link> into <head>", async () => {
    const out = await inject("<html><head></head><body>x</body></html>");
    expect(out).toContain('<link rel="webmcp" href="https://example.com/.well-known/webmcp.json">');
  });

  it("adds <script> before </body>", async () => {
    const out = await inject("<html><head></head><body>x</body></html>");
    expect(out).toMatch(/<script[^>]+bootstrap[^>]+><\/script>\s*<\/body>/);
  });

  it("only injects once even with multiple head/body tags", async () => {
    const out = await inject(
      "<html><head></head><head></head><body>x</body><body>y</body></html>",
    );
    const linkMatches = out.match(/<link rel="webmcp"/g) ?? [];
    const scriptMatches = out.match(/<script[^>]+bootstrap/g) ?? [];
    expect(linkMatches.length).toBe(1);
    expect(scriptMatches.length).toBe(1);
  });

  it("does not crash on fragment with no head/body", async () => {
    const out = await inject("<div>plain fragment</div>");
    expect(out).toBe("<div>plain fragment</div>");
  });

  it("escapes attributes safely", async () => {
    const evilOpts = {
      manifestUrl: 'https://example.com/x?a="bad"',
      bootstrapUrl: "https://example.com/y",
      emitLinkTag: true,
      forms: [],
    };
    const res = new Response("<html><head></head><body></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, evilOpts).text();
    expect(out).not.toContain('"bad"');
    expect(out).toContain("&quot;bad&quot;");
  });

  it("adds <link rel=api-catalog> alongside webmcp when apiCatalogUrl set", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, {
      ...opts,
      apiCatalogUrl: "https://example.com/.well-known/api-catalog",
    }).text();
    expect(out).toContain('<link rel="webmcp" href="https://example.com/.well-known/webmcp.json">');
    expect(out).toContain('<link rel="api-catalog" href="https://example.com/.well-known/api-catalog">');
  });

  it("omits the api-catalog link tag when apiCatalogUrl is undefined", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, opts).text();
    expect(out).toContain('<link rel="webmcp"');
    expect(out).not.toContain('rel="api-catalog"');
  });

  it("adds <link rel=agent-skills> when agentSkillsUrl set", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, {
      ...opts,
      agentSkillsUrl: "https://example.com/.well-known/agent-skills/site/SKILL.md",
    }).text();
    expect(out).toContain('<link rel="webmcp"');
    expect(out).toContain('<link rel="agent-skills" href="https://example.com/.well-known/agent-skills/site/SKILL.md">');
  });

  it("omits the agent-skills link tag when agentSkillsUrl is undefined", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, opts).text();
    expect(out).not.toContain('rel="agent-skills"');
  });

  it("adds <link rel=ai-catalog> when aiCatalogUrl set", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, {
      ...opts,
      aiCatalogUrl: "https://example.com/.well-known/ai-catalog.json",
    }).text();
    expect(out).toContain('<link rel="webmcp"');
    expect(out).toContain('<link rel="ai-catalog" href="https://example.com/.well-known/ai-catalog.json">');
  });

  it("omits the ai-catalog link tag when aiCatalogUrl is undefined", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, opts).text();
    expect(out).not.toContain('rel="ai-catalog"');
  });

  it("adds integrity + crossorigin attributes when bootstrapIntegrity is set", async () => {
    const sri = "sha384-X3vKvL7n9bN0kfZj0xJpYY2pVDxQ4dQsB6mHcqLwTLZ7l6gAqQB1qO2xkSjqJ7Tk";
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, { ...opts, bootstrapIntegrity: sri }).text();
    expect(out).toContain(`integrity="${sri}"`);
    expect(out).toContain('crossorigin="anonymous"');
    // Must remain on the same <script> tag (no order regression that would
    // drop crossorigin onto a different element).
    expect(out).toMatch(/<script[^>]+defer[^>]+integrity[^>]+crossorigin[^>]*>/);
  });

  it("omits integrity + crossorigin when bootstrapIntegrity is undefined", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, opts).text();
    expect(out).not.toContain("integrity=");
    expect(out).not.toContain('crossorigin="anonymous"');
  });

  it("adds <link rel=describedby type=text/markdown> when llmsTxtUrl set", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, {
      ...opts,
      llmsTxtUrl: "https://example.com/llms.txt",
    }).text();
    expect(out).toContain('<link rel="describedby" type="text/markdown" href="https://example.com/llms.txt">');
  });

  it("omits describedby link tag when llmsTxtUrl is undefined", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, opts).text();
    expect(out).not.toContain('rel="describedby"');
  });

  it("adds <link rel=alternate type=text/markdown> alongside describedby when llmsTxtUrl set", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, {
      ...opts,
      llmsTxtUrl: "https://example.com/llms.txt",
    }).text();
    expect(out).toContain('<link rel="alternate" type="text/markdown" href="https://example.com/llms.txt">');
    // Both rels coexist, pointing at the same target.
    expect(out).toContain('<link rel="describedby" type="text/markdown" href="https://example.com/llms.txt">');
  });

  it("omits alternate markdown link tag when llmsTxtUrl is undefined", async () => {
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, opts).text();
    expect(out).not.toContain('rel="alternate"');
  });

  it("escapes bootstrapIntegrity value to prevent attribute breakout", async () => {
    // A pathological integrity string with quotes / brackets must not break
    // out of the attribute. Real SRI hashes never contain these chars, but
    // the escape applies regardless.
    const evil = 'sha384-x"><script>alert(1)</script>';
    const res = new Response("<html><head></head><body>x</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const out = await injectIntoHtml(res, { ...opts, bootstrapIntegrity: evil }).text();
    expect(out).not.toContain('"><script>alert(1)');
    expect(out).toContain("&quot;");
  });
});

describe("formsForPath", () => {
  const make = (name: string, paths: string[]): FormInjectionConfig => ({
    name,
    description: "d",
    selector: `form#${name}`,
    paths,
    autosubmit: false,
    params: [],
  });

  it("returns forms with empty paths on every page", () => {
    const forms = [make("anywhere", [])];
    expect(formsForPath(forms, "/anything").length).toBe(1);
    expect(formsForPath(forms, "/foo/bar").length).toBe(1);
  });

  it("filters by exact path match", () => {
    const forms = [make("only_contact", ["/contact"])];
    expect(formsForPath(forms, "/contact").length).toBe(1);
    expect(formsForPath(forms, "/about").length).toBe(0);
  });

  it("supports glob in paths", () => {
    const forms = [make("blog_only", ["/blog/*"])];
    expect(formsForPath(forms, "/blog/hello").length).toBe(1);
    expect(formsForPath(forms, "/blog/").length).toBe(1);
    expect(formsForPath(forms, "/about").length).toBe(0);
  });

  it("any matching glob includes the form", () => {
    const forms = [make("two_paths", ["/contact", "/forms"])];
    expect(formsForPath(forms, "/contact").length).toBe(1);
    expect(formsForPath(forms, "/forms").length).toBe(1);
    expect(formsForPath(forms, "/about").length).toBe(0);
  });
});

describe("injectIntoHtml form attribute injection", () => {
  const contact: FormInjectionConfig = {
    name: "contact",
    description: "Submit a contact form.",
    selector: "form#contact",
    paths: [],
    autosubmit: true,
    params: [
      { selector: "input[name=email]", description: "Sender email." },
      { selector: "input[name=name]", description: "Sender name." },
    ],
  };

  async function inject(html: string, forms: FormInjectionConfig[]): Promise<string> {
    const res = new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    return injectIntoHtml(res, { ...opts, forms }).text();
  }

  it("stamps toolname, tooldescription, toolautosubmit on the matched form", async () => {
    const out = await inject(
      `<html><head></head><body><form id="contact"><input name="email"><input name="name"></form></body></html>`,
      [contact],
    );
    expect(out).toMatch(/<form[^>]+toolname="contact"/);
    expect(out).toMatch(/<form[^>]+tooldescription="Submit a contact form\."/);
    expect(out).toMatch(/<form[^>]+toolautosubmit/);
  });

  it("stamps toolparamdescription on each matched input", async () => {
    const out = await inject(
      `<html><head></head><body><form id="contact"><input name="email"><input name="name"></form></body></html>`,
      [contact],
    );
    expect(out).toMatch(/<input[^>]+name="email"[^>]+toolparamdescription="Sender email\."/);
    expect(out).toMatch(/<input[^>]+name="name"[^>]+toolparamdescription="Sender name\."/);
  });

  it("does not overwrite pre-existing toolname (publisher hand-stamp wins)", async () => {
    const out = await inject(
      `<html><head></head><body><form id="contact" toolname="custom_contact"><input name="email"></form></body></html>`,
      [contact],
    );
    expect(out).toMatch(/toolname="custom_contact"/);
    expect(out).not.toMatch(/toolname="contact"/);
  });

  it("omits toolautosubmit when autosubmit is false", async () => {
    const noAuto: FormInjectionConfig = { ...contact, autosubmit: false };
    const out = await inject(
      `<html><head></head><body><form id="contact"></form></body></html>`,
      [noAuto],
    );
    expect(out).not.toMatch(/toolautosubmit/);
  });

  it("scopes param selectors to inside the form", async () => {
    // An <input name="email"> outside the form should NOT be touched.
    const out = await inject(
      `<html><head></head><body><input name="email"><form id="contact"><input name="email"></form></body></html>`,
      [contact],
    );
    // Count param injections - should be exactly 1 (only the one inside form#contact).
    const matches = out.match(/name="email"[^>]+toolparamdescription/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("leaves forms alone when forms array is empty", async () => {
    const out = await inject(
      `<html><head></head><body><form id="contact"><input name="email"></form></body></html>`,
      [],
    );
    expect(out).not.toMatch(/toolname=/);
    expect(out).not.toMatch(/toolparamdescription=/);
  });
});
