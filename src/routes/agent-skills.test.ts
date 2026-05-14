import { describe, it, expect } from "vitest";
import { agentSkillsResponse, agentSkillsRedirect, mergeBlock, slugify } from "./agent-skills";
import type { Config } from "../config-types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "Example Site", description: "An example.", locale: "en", public_url: "https://example.com" },
    origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"], forward_cookies: false },
    features: {
      inject_html: true,
      webmcp_landing: true,
      manifest: true,
      link_header: true,
      link_tag: true,
      llms_txt: true,
      robots_txt: true,
      agents_md: true,
      api_catalog: true,
      agent_skills: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json" },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" },
    agent_skills: {
      path: "/.well-known/agent-skills/site/SKILL.md",
      mode: "synthesize",
      name: "",
      description: "",
      aliases: [
        "/.well-known/agent-skills/site/SKILLS.md",
        "/.well-known/agent-skills/site/skill.md",
        "/.well-known/agent-skills/site/skills.md",
      ],
      hints: [],
    },
    paths: { namespace: "/_webmcp" },
    injection: { exclude_paths: [] },
    cache: {
      manifest_max_age: 300, manifest_s_maxage: 86400, manifest_swr: 604800, manifest_sie: 86400,
      landing_max_age: 300, landing_s_maxage: 86400, landing_swr: 86400, landing_sie: 86400,
      llms_txt_max_age: 300, llms_txt_s_maxage: 3600, llms_txt_swr: 86400, llms_txt_sie: 86400,
      robots_txt_max_age: 300, robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400,
      agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400,
      agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800,
      api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400,
      agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400,
      agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800,
      bootstrap_max_age: 31536000, widget_max_age: 31536000,
      executor_defaults: { max_age: 0, s_maxage: 300, swr: 1800, sie: 86400 },
    },
    cors: { allowed_origins: [] },
    health: { public: true, token: "" },
    dev: { origin: "http://localhost:8080" },
    rate_limit: { requests_per_minute_per_ip: 60 },
    tools: [
      {
        name: "search_pages",
        description: "Search the site.",
        input_schema: { type: "object", required: ["query"], properties: { query: { type: "string" } } },
        executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      },
      {
        name: "list_posts",
        description: "List recent posts.",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "rss_feed", feed_url: "https://example.com/feed.xml", max_items: 10 },
      },
    ],
    forms: [],
    ...overrides,
  };
}

describe("agentSkillsResponse", () => {
  it("synthesizes a SKILL.md with frontmatter + tool list", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const res = await agentSkillsResponse(
      new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"),
      makeConfig(),
      proxy,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const body = await res.text();
    expect(body).toMatch(/^---\nname: "example-site"\ndescription: "An example\."\n---/);
    expect(body).toContain("`search_pages(query: string)`");
    expect(body).toContain("`list_posts()`");
    expect(body).toContain("Search the site.");
    expect(body).toContain("https://example.com/.well-known/webmcp.json");
  });

  it("uses explicit name and description overrides when set", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig({
      agent_skills: {
        path: "/.well-known/agent-skills/site/SKILL.md",
        mode: "synthesize",
        name: "custom-name",
        description: "custom description",
        aliases: [],
        hints: [],
      },
    });
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    expect(body).toContain('name: "custom-name"');
    expect(body).toContain('description: "custom description"');
  });

  it("renders publisher hints in order after the tool list", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig({
      agent_skills: {
        path: "/.well-known/agent-skills/site/SKILL.md",
        mode: "synthesize",
        name: "",
        description: "",
        aliases: [],
        hints: [
          { heading: "When to use which", body: "Use search_pages for keywords." },
          { heading: "Pitfalls", body: "Search is path-based, not full-text." },
        ],
      },
    });
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    const wIdx = body.indexOf("## When to use which");
    const pIdx = body.indexOf("## Pitfalls");
    expect(wIdx).toBeGreaterThan(-1);
    expect(pIdx).toBeGreaterThan(wIdx);
    expect(body).toContain("Use search_pages for keywords.");
    expect(body).toContain("Search is path-based, not full-text.");
  });

  it("surfaces form-injected tools in the tool list", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig({
      forms: [
        { name: "contact", description: "Send a contact message.", selector: "form#c", paths: [], autosubmit: false, params: [] },
      ],
    });
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    expect(body).toContain("`contact` (form) - Send a contact message.");
  });

  it("falls back to a 'no tools currently exposed' line on empty tool/form lists", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig({
      tools: [
        {
          name: "kept_for_zod",
          description: "x",
          input_schema: { type: "object", required: [], properties: {} },
          executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
        },
      ],
    });
    // Zero out tools after building (Zod requires at least one). Cast for the test.
    (config as { tools: unknown[] }).tools = [];
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    expect(body).toContain("_No tools currently exposed._");
  });

  it("merge mode splices our block into a marker region in origin's SKILL.md", async () => {
    const origin = `---
name: publisher-skill
description: Hand-written by publisher.
---

# Publisher content

<!-- cf-webmcp:begin -->
<!-- cf-webmcp:end -->

## Pitfalls

publisher's pitfalls section
`;
    const proxy = async () =>
      new Response(origin, { status: 200, headers: { "content-type": "text/markdown" } });
    const config = makeConfig({
      agent_skills: {
        path: "/.well-known/agent-skills/site/SKILL.md",
        mode: "merge",
        name: "",
        description: "",
        aliases: [],
        hints: [],
      },
    });
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    expect(body).toContain("name: publisher-skill");
    expect(body).toContain("publisher's pitfalls section");
    expect(body).toContain("`search_pages(query: string)`");
    expect(body).toMatch(/cf-webmcp:begin[\s\S]+search_pages[\s\S]+cf-webmcp:end/);
  });

  it("merge mode appends our block when marker absent in origin", async () => {
    const origin = "# Publisher\n\nhand-written body, no marker.\n";
    const proxy = async () =>
      new Response(origin, { status: 200, headers: { "content-type": "text/markdown" } });
    const config = makeConfig({
      agent_skills: {
        path: "/.well-known/agent-skills/site/SKILL.md",
        mode: "merge",
        name: "",
        description: "",
        aliases: [],
        hints: [],
      },
    });
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    expect(body).toContain("hand-written body, no marker.");
    expect(body).toContain("cf-webmcp:begin");
    expect(body).toContain("`search_pages(query: string)`");
  });

  it("merge mode is idempotent (re-running against own output produces same bytes)", () => {
    const block = "GENERATED-BLOCK";
    const seed = "# pre\nbody\n";
    const first = mergeBlock(seed, block);
    const second = mergeBlock(first, block);
    expect(second).toBe(first);
  });

  it("passes origin through unchanged when content-type is not markdown-ish", async () => {
    const proxy = async () =>
      new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } });
    const config = makeConfig({
      agent_skills: {
        path: "/.well-known/agent-skills/site/SKILL.md",
        mode: "merge",
        name: "",
        description: "",
        aliases: [],
        hints: [],
      },
    });
    const res = await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy);
    expect(await res.text()).toContain("<html>");
  });

  it("escapes YAML-special chars in frontmatter", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig({
      agent_skills: {
        path: "/.well-known/agent-skills/site/SKILL.md",
        mode: "synthesize",
        name: 'has "quotes" and \\backslash',
        description: "",
        aliases: [],
        hints: [],
      },
    });
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    expect(body).toContain('name: "has \\"quotes\\" and \\\\backslash"');
  });

  it("escapes control chars and newlines in YAML frontmatter", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig({
      agent_skills: {
        path: "/.well-known/agent-skills/site/SKILL.md",
        mode: "synthesize",
        name: "line1\nline2\twith\x07bell",
        description: "carriage\rreturn",
        aliases: [],
        hints: [],
      },
    });
    const body = await (await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy)).text();
    // No literal LF/CR/TAB/BEL inside the YAML scalar value.
    expect(body).toContain('name: "line1\\nline2\\twith\\u0007bell"');
    expect(body).toContain('description: "carriage\\rreturn"');
    // Frontmatter is still a single value line per key (no breakouts).
    const frontmatter = body.split("---")[1] ?? "";
    expect(frontmatter.split("\n").filter((l) => l.startsWith("name:"))).toHaveLength(1);
    expect(frontmatter.split("\n").filter((l) => l.startsWith("description:"))).toHaveLength(1);
  });

  it("sets correct cache-control header", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const res = await agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), makeConfig(), proxy);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=300");
    expect(cc).toContain("s-maxage=21600");
    expect(cc).toContain("stale-while-revalidate=86400");
  });
});

describe("agentSkillsRedirect", () => {
  it("returns a 301 to the canonical path with long cache", () => {
    const res = agentSkillsRedirect(makeConfig());
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/.well-known/agent-skills/site/SKILL.md");
    expect(res.headers.get("cache-control") ?? "").toContain("max-age=86400");
  });
});

describe("slugify", () => {
  it("lowercases, replaces non-alphanumeric with hyphens, trims", () => {
    expect(slugify("Example Site")).toBe("example-site");
    expect(slugify("  cf-webmcp ")).toBe("cf-webmcp");
    expect(slugify("Tübingen & Co.")).toBe("tubingen-co");
  });

  it("falls back to 'site' for degenerate input", () => {
    expect(slugify("")).toBe("site");
    expect(slugify("///")).toBe("site");
  });
});
