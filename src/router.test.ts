import { describe, it, expect } from "vitest";
import { matchRoute } from "./router";
import type { Config } from "./config-types";

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
    robots_txt: true, agents_md: true,
    fallback_widget: true,
  },
  manifest: { path: "/.well-known/webmcp.json" },
  webmcp_landing: { path: "/mcp" },
  llms_txt: { path: "/llms.txt", mode: "merge" },
  robots_txt: { path: "/robots.txt", mode: "merge" }, agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
  paths: { namespace: "/_webmcp" },
  injection: { exclude_paths: [] },
  cache: {
    manifest_max_age: 300,
    manifest_s_maxage: 86400,
    manifest_swr: 604800, manifest_sie: 86400,
    landing_max_age: 300,
    landing_s_maxage: 86400, landing_swr: 86400, landing_sie: 86400,
    llms_txt_max_age: 300,
    llms_txt_s_maxage: 3600, llms_txt_swr: 86400, llms_txt_sie: 86400,
    robots_txt_max_age: 300,
    robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400, agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400, agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800,
    bootstrap_max_age: 31536000,
    widget_max_age: 31536000,
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
};

const BOOTSTRAP = "bootstrap.abc12345.js";
const WIDGET = "widget.abc12345.js";

function url(path: string): URL {
  return new URL(`https://example.com${path}`);
}

describe("matchRoute", () => {
  it("routes the manifest", () => {
    expect(matchRoute(baseConfig, url("/.well-known/webmcp.json"), BOOTSTRAP, WIDGET).kind).toBe("manifest");
  });

  it("routes the landing page at file-form path", () => {
    expect(matchRoute(baseConfig, url("/mcp"), BOOTSTRAP, WIDGET).kind).toBe("landing");
  });

  it("does not redirect /mcp/ when default is file-form", () => {
    // File-form (no trailing slash) is exact-match only; /mcp/ falls through to proxy.
    expect(matchRoute(baseConfig, url("/mcp/"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("with directory-form path, serves /mcp/ and 308-redirects /mcp", () => {
    const dirForm = { ...baseConfig, webmcp_landing: { path: "/mcp/" } };
    expect(matchRoute(dirForm, url("/mcp/"), BOOTSTRAP, WIDGET).kind).toBe("landing");
    expect(matchRoute(dirForm, url("/mcp"), BOOTSTRAP, WIDGET).kind).toBe("landing_redirect");
  });

  it("routes the bootstrap asset", () => {
    expect(matchRoute(baseConfig, url(`/_webmcp/${BOOTSTRAP}`), BOOTSTRAP, WIDGET).kind).toBe("bootstrap");
  });

  it("routes the widget asset when feature on", () => {
    expect(matchRoute(baseConfig, url(`/_webmcp/${WIDGET}`), BOOTSTRAP, WIDGET).kind).toBe("widget");
  });

  it("does not route widget when feature off", () => {
    const off = { ...baseConfig, features: { ...baseConfig.features, fallback_widget: false } };
    expect(matchRoute(off, url(`/_webmcp/${WIDGET}`), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("routes valid exec tool names", () => {
    const m = matchRoute(baseConfig, url("/_webmcp/exec/search_pages"), BOOTSTRAP, WIDGET);
    expect(m.kind).toBe("exec");
    expect(m.toolName).toBe("search_pages");
  });

  it("rejects invalid tool name characters", () => {
    expect(matchRoute(baseConfig, url("/_webmcp/exec/../etc/passwd"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    expect(matchRoute(baseConfig, url("/_webmcp/exec/UPPERCASE"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("routes health", () => {
    expect(matchRoute(baseConfig, url("/_webmcp/health"), BOOTSTRAP, WIDGET).kind).toBe("health");
  });

  it("routes llms.txt and robots.txt", () => {
    expect(matchRoute(baseConfig, url("/llms.txt"), BOOTSTRAP, WIDGET).kind).toBe("llms_txt");
    expect(matchRoute(baseConfig, url("/robots.txt"), BOOTSTRAP, WIDGET).kind).toBe("robots_txt");
  });

  it("routes the canonical agents.md path", () => {
    expect(matchRoute(baseConfig, url("/.well-known/agents.md"), BOOTSTRAP, WIDGET).kind).toBe("agents_md");
  });

  it("routes the agents.md alias paths to 301 redirect", () => {
    expect(matchRoute(baseConfig, url("/AGENTS.md"), BOOTSTRAP, WIDGET).kind).toBe("agents_md_redirect");
    expect(matchRoute(baseConfig, url("/agents.md"), BOOTSTRAP, WIDGET).kind).toBe("agents_md_redirect");
  });

  it("does not route agents.md when feature off", () => {
    const off = { ...baseConfig, features: { ...baseConfig.features, agents_md: false } };
    expect(matchRoute(off, url("/.well-known/agents.md"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    expect(matchRoute(off, url("/AGENTS.md"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("falls through to proxy for unrelated paths", () => {
    expect(matchRoute(baseConfig, url("/about"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    expect(matchRoute(baseConfig, url("/"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });
});
