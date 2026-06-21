import { describe, it, expect } from "vitest";
import { buildLinkHeader, mergeLinkHeader } from "./link-header";
import type { Config } from "./config-types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "x", description: "", locale: "en", public_url: "https://example.com" },
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
      api_catalog: true, ai_catalog: true, agent_skills: true, agent_skills_index: true, subresource_integrity: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" }, ai_catalog: { path: "/.well-known/ai-catalog.json", mode: "synthesize", host_identifier: "", representative_queries: [], tags: [] }, agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] }, agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
    paths: { namespace: "/_webmcp" },
    injection: { exclude_paths: [] },
    cache: {
      manifest_max_age: 300, manifest_s_maxage: 86400, manifest_swr: 604800, manifest_sie: 86400,
      landing_max_age: 300, landing_s_maxage: 86400, landing_swr: 86400, landing_sie: 86400,
      llms_txt_max_age: 300, llms_txt_s_maxage: 3600, llms_txt_swr: 86400, llms_txt_sie: 86400,
      robots_txt_max_age: 300, robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400,
      agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400,
      agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800,
      api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400, ai_catalog_max_age: 300, ai_catalog_s_maxage: 21600, ai_catalog_swr: 86400, ai_catalog_sie: 86400, agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400, agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
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
        description: "x",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      },
    ],
    forms: [],
    ...overrides,
  };
}

describe("buildLinkHeader", () => {
  it("always includes the webmcp rel", () => {
    expect(buildLinkHeader(makeConfig())).toContain('rel="webmcp"');
  });

  it("includes the api-catalog rel when feature on and mode != passthrough", () => {
    const value = buildLinkHeader(makeConfig());
    expect(value).toContain('<https://example.com/.well-known/api-catalog>; rel="api-catalog"');
    expect(value).toContain('<https://example.com/.well-known/webmcp.json>; rel="webmcp"');
    // Comma-separated per RFC 8288; allow any params (e.g. title) on the
    // webmcp entry before the comma that delimits the next entry.
    expect(value).toMatch(/rel="webmcp"[^,]*,\s*<[^>]+>;\s*rel="api-catalog"/);
  });

  it("omits api-catalog when features.api_catalog is false", () => {
    const value = buildLinkHeader(
      makeConfig({ features: { ...makeConfig().features, api_catalog: false } }),
    );
    expect(value).toContain('rel="webmcp"');
    expect(value).not.toContain('rel="api-catalog"');
  });

  it("omits api-catalog when mode is passthrough", () => {
    const value = buildLinkHeader(
      makeConfig({ api_catalog: { path: "/.well-known/api-catalog", mode: "passthrough" } }),
    );
    expect(value).toContain('rel="webmcp"');
    expect(value).not.toContain('rel="api-catalog"');
  });

  it("includes the agent-skills rel when feature on and mode != passthrough", () => {
    const value = buildLinkHeader(makeConfig());
    expect(value).toContain('<https://example.com/.well-known/agent-skills/site/SKILL.md>; rel="agent-skills"');
  });

  it("omits agent-skills when features.agent_skills is false", () => {
    const value = buildLinkHeader(
      makeConfig({ features: { ...makeConfig().features, agent_skills: false } }),
    );
    expect(value).not.toContain('rel="agent-skills"');
  });

  it("omits agent-skills when mode is passthrough", () => {
    const value = buildLinkHeader(
      makeConfig({
        agent_skills: {
          ...makeConfig().agent_skills,
          mode: "passthrough",
        },
      }),
    );
    expect(value).not.toContain('rel="agent-skills"');
  });

  it("includes describedby rel pointing at llms.txt when llms_txt feature on", () => {
    const value = buildLinkHeader(makeConfig());
    // IANA-registered rel (RFC 8288); type hint per the same RFC.
    expect(value).toContain('<https://example.com/llms.txt>; rel="describedby"; type="text/markdown"');
  });

  it("omits describedby when features.llms_txt is false", () => {
    const value = buildLinkHeader(
      makeConfig({ features: { ...makeConfig().features, llms_txt: false } }),
    );
    expect(value).not.toContain('rel="describedby"');
  });

  it("omits describedby when llms_txt mode is passthrough", () => {
    const value = buildLinkHeader(
      makeConfig({ llms_txt: { path: "/llms.txt", mode: "passthrough" } }),
    );
    expect(value).not.toContain('rel="describedby"');
  });

  it("includes the ai-catalog rel when feature on and mode != passthrough", () => {
    const value = buildLinkHeader(makeConfig());
    expect(value).toContain('<https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"');
  });

  it("omits ai-catalog when features.ai_catalog is false", () => {
    const value = buildLinkHeader(
      makeConfig({ features: { ...makeConfig().features, ai_catalog: false } }),
    );
    expect(value).not.toContain('rel="ai-catalog"');
  });

  it("omits ai-catalog when mode is passthrough", () => {
    const value = buildLinkHeader(
      makeConfig({ ai_catalog: { path: "/.well-known/ai-catalog.json", mode: "passthrough", host_identifier: "", representative_queries: [], tags: [] } }),
    );
    expect(value).not.toContain('rel="ai-catalog"');
  });

  it("emits RFC 8288 title parameter on every advertised rel", () => {
    const value = buildLinkHeader(makeConfig());
    // webmcp: our private rel, our wording.
    expect(value).toContain('rel="webmcp"; title="WebMCP tool catalogue"');
    // api-catalog: RFC 9727 / 9264.
    expect(value).toContain('rel="api-catalog"; title="API catalogue (RFC 9727 Linkset)"');
    // agent-skills: Anthropic SKILL.md.
    expect(value).toContain('rel="agent-skills"; title="Agent Skill (SKILL.md)"');
    // describedby: title matches specification.website (Joost de Valk) for the
    // same target, so peer publishers see identical wording on the same rel.
    expect(value).toContain('rel="describedby"; type="text/markdown"; title="Site index for LLMs"');
  });
});

describe("mergeLinkHeader", () => {
  it("returns ours alone when no existing header", () => {
    expect(mergeLinkHeader(null, '<x>; rel="y"')).toBe('<x>; rel="y"');
  });

  it("appends ours to an existing origin Link header", () => {
    expect(mergeLinkHeader('<a>; rel="preload"', '<b>; rel="webmcp"')).toBe(
      '<a>; rel="preload", <b>; rel="webmcp"',
    );
  });
});
