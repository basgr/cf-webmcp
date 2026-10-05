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
    robots_txt: true, agents_md: true, api_catalog: true, ai_catalog: false, agent_skills: true, agent_skills_index: true, subresource_integrity: true,
    fallback_widget: true,
  },
  manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
  webmcp_landing: { path: "/mcp" },
  llms_txt: { path: "/llms.txt", mode: "merge" },
  robots_txt: { path: "/robots.txt", mode: "merge" }, agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] }, api_catalog: { path: "/.well-known/api-catalog", mode: "merge" }, ai_catalog: { path: "/.well-known/ai-catalog.json", mode: "synthesize", host_identifier: "", representative_queries: [], tags: [] }, agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] }, agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
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
    robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400, agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400, agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800, api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400, ai_catalog_max_age: 300, ai_catalog_s_maxage: 21600, ai_catalog_swr: 86400, ai_catalog_sie: 86400, agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400, agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
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
  forms: [],
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

  it("301-redirects a manifest alias to the canonical path", () => {
    // baseConfig: path /.well-known/webmcp.json, alias /.well-known/webmcp.
    expect(matchRoute(baseConfig, url("/.well-known/webmcp"), BOOTSTRAP, WIDGET).kind).toBe("manifest_redirect");
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

  it("does not serve the widget when feature off, and never proxies the widget path to origin", () => {
    const off = { ...baseConfig, features: { ...baseConfig.features, fallback_widget: false } };
    expect(matchRoute(off, url(`/_webmcp/${WIDGET}`), BOOTSTRAP, WIDGET).kind).toBe("asset_not_found");
  });

  it("answers a stale bootstrap hash with asset_not_found instead of proxying it", () => {
    expect(matchRoute(baseConfig, url("/_webmcp/bootstrap.0000000000000000.js"), BOOTSTRAP, WIDGET).kind).toBe(
      "asset_not_found",
    );
  });

  it("answers a stale widget hash with asset_not_found instead of proxying it", () => {
    expect(matchRoute(baseConfig, url("/_webmcp/widget.0000000000000000.js"), BOOTSTRAP, WIDGET).kind).toBe(
      "asset_not_found",
    );
  });

  it("answers any widget path with asset_not_found when no widget asset is built", () => {
    expect(matchRoute(baseConfig, url("/_webmcp/widget.anything.js"), BOOTSTRAP, null).kind).toBe("asset_not_found");
    expect(matchRoute(baseConfig, url(`/_webmcp/${WIDGET}`), BOOTSTRAP, null).kind).toBe("asset_not_found");
    // The bootstrap is unaffected by a missing widget.
    expect(matchRoute(baseConfig, url(`/_webmcp/${BOOTSTRAP}`), BOOTSTRAP, null).kind).toBe("bootstrap");
  });

  it("only treats single-segment bootstrap.<x>.js and widget.<x>.js under the namespace as assets", () => {
    // No hash segment, a nested path and a trailing segment are not asset names; they are
    // still inside the namespace, so they 404 (namespace_not_found) instead of reaching origin.
    expect(matchRoute(baseConfig, url("/_webmcp/bootstrap.js"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
    expect(matchRoute(baseConfig, url("/_webmcp/widget.js"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
    expect(matchRoute(baseConfig, url("/_webmcp/sub/bootstrap.abc.js"), BOOTSTRAP, WIDGET).kind).toBe(
      "namespace_not_found",
    );
    expect(matchRoute(baseConfig, url("/_webmcp/bootstrap.abc.js/extra"), BOOTSTRAP, WIDGET).kind).toBe(
      "namespace_not_found",
    );
    expect(matchRoute(baseConfig, url("/_webmcp/exec/bootstrap.abc.js"), BOOTSTRAP, WIDGET).kind).toBe(
      "namespace_not_found",
    );
    // A path outside the namespace is origin content.
    expect(matchRoute(baseConfig, url("/other/bootstrap.abc.js"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("applies the stale-asset rule under a custom namespace only", () => {
    const custom = { ...baseConfig, paths: { namespace: "/_x" } };
    expect(matchRoute(custom, url("/_x/bootstrap.old.js"), BOOTSTRAP, WIDGET).kind).toBe("asset_not_found");
    expect(matchRoute(custom, url(`/_x/${BOOTSTRAP}`), BOOTSTRAP, WIDGET).kind).toBe("bootstrap");
    expect(matchRoute(custom, url("/_webmcp/bootstrap.old.js"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("answers any unknown path under the namespace with namespace_not_found", () => {
    expect(matchRoute(baseConfig, url("/_webmcp/does-not-exist"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
    expect(matchRoute(baseConfig, url("/_webmcp/"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
    expect(matchRoute(baseConfig, url("/_webmcp/exec/"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
    const custom = { ...baseConfig, paths: { namespace: "/_x" } };
    expect(matchRoute(custom, url("/_x/nope"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
    expect(matchRoute(custom, url("/_webmcp/nope"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("does not treat a path that only shares the namespace spelling as a prefix as namespaced", () => {
    expect(matchRoute(baseConfig, url("/_webmcp-docs"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    expect(matchRoute(baseConfig, url("/_webmcp"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("keeps a configured route that lives under the namespace ahead of the namespace 404", () => {
    const inside = { ...baseConfig, llms_txt: { path: "/_webmcp/llms.txt", mode: "merge" as const } };
    expect(matchRoute(inside, url("/_webmcp/llms.txt"), BOOTSTRAP, WIDGET).kind).toBe("llms_txt");
  });

  it("routes valid exec tool names", () => {
    const m = matchRoute(baseConfig, url("/_webmcp/exec/search_pages"), BOOTSTRAP, WIDGET);
    expect(m.kind).toBe("exec");
    expect(m.toolName).toBe("search_pages");
  });

  it("answers an invalid tool name with namespace_not_found, never proxy", () => {
    // `..` is normalised away by URL parsing, so this lands on /_webmcp/etc/passwd: still in the namespace.
    expect(matchRoute(baseConfig, url("/_webmcp/exec/../etc/passwd"), BOOTSTRAP, WIDGET).kind).toBe(
      "namespace_not_found",
    );
    expect(matchRoute(baseConfig, url("/_webmcp/exec/UPPERCASE"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
    expect(matchRoute(baseConfig, url("/_webmcp/exec/a/b"), BOOTSTRAP, WIDGET).kind).toBe("namespace_not_found");
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

  it("routes the api-catalog path when feature on", () => {
    expect(matchRoute(baseConfig, url("/.well-known/api-catalog"), BOOTSTRAP, WIDGET).kind).toBe("api_catalog");
  });

  it("does not route api-catalog when feature off or mode passthrough", () => {
    const off = { ...baseConfig, features: { ...baseConfig.features, api_catalog: false } };
    expect(matchRoute(off, url("/.well-known/api-catalog"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    const passthrough = { ...baseConfig, api_catalog: { ...baseConfig.api_catalog, mode: "passthrough" as const } };
    expect(matchRoute(passthrough, url("/.well-known/api-catalog"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("routes the canonical agent-skills SKILL.md path", () => {
    expect(matchRoute(baseConfig, url("/.well-known/agent-skills/site/SKILL.md"), BOOTSTRAP, WIDGET).kind).toBe("agent_skills");
  });

  it("routes agent-skills aliases (SKILLS.md and lowercase variants) to 301", () => {
    expect(matchRoute(baseConfig, url("/.well-known/agent-skills/site/SKILLS.md"), BOOTSTRAP, WIDGET).kind).toBe("agent_skills_redirect");
    expect(matchRoute(baseConfig, url("/.well-known/agent-skills/site/skill.md"), BOOTSTRAP, WIDGET).kind).toBe("agent_skills_redirect");
    expect(matchRoute(baseConfig, url("/.well-known/agent-skills/site/skills.md"), BOOTSTRAP, WIDGET).kind).toBe("agent_skills_redirect");
  });

  it("does not route agent-skills when feature off or mode passthrough", () => {
    const off = { ...baseConfig, features: { ...baseConfig.features, agent_skills: false } };
    expect(matchRoute(off, url("/.well-known/agent-skills/site/SKILL.md"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    const passthrough = { ...baseConfig, agent_skills: { ...baseConfig.agent_skills, mode: "passthrough" as const } };
    expect(matchRoute(passthrough, url("/.well-known/agent-skills/site/SKILL.md"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("routes the agent-skills index path when feature on", () => {
    expect(matchRoute(baseConfig, url("/.well-known/agent-skills/index.json"), BOOTSTRAP, WIDGET).kind).toBe("agent_skills_index");
  });

  it("does not route agent-skills index when feature off or mode passthrough", () => {
    const off = { ...baseConfig, features: { ...baseConfig.features, agent_skills_index: false } };
    expect(matchRoute(off, url("/.well-known/agent-skills/index.json"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    const passthrough = { ...baseConfig, agent_skills_index: { ...baseConfig.agent_skills_index, mode: "passthrough" as const } };
    expect(matchRoute(passthrough, url("/.well-known/agent-skills/index.json"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("falls through to proxy for unrelated paths", () => {
    expect(matchRoute(baseConfig, url("/about"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    expect(matchRoute(baseConfig, url("/"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });

  it("routes the ai-catalog when feature on", () => {
    const on = { ...baseConfig, features: { ...baseConfig.features, ai_catalog: true } };
    expect(matchRoute(on, url("/.well-known/ai-catalog.json"), BOOTSTRAP, WIDGET).kind).toBe("ards_catalog");
  });

  it("does not route ai-catalog when feature off or passthrough", () => {
    expect(matchRoute(baseConfig, url("/.well-known/ai-catalog.json"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
    const pt = { ...baseConfig, features: { ...baseConfig.features, ai_catalog: true }, ai_catalog: { ...baseConfig.ai_catalog, mode: "passthrough" as const } };
    expect(matchRoute(pt, url("/.well-known/ai-catalog.json"), BOOTSTRAP, WIDGET).kind).toBe("proxy");
  });
});
