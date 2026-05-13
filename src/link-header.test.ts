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
      api_catalog: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json" },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" },
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
    // Comma-separated per RFC 8288
    expect(value).toMatch(/rel="webmcp", <.*>; rel="api-catalog"/);
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
