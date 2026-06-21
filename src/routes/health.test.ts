import { describe, it, expect } from "vitest";
import { healthResponse } from "./health";
import type { Config } from "../config-types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
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
      robots_txt: true,
      agents_md: true,
      api_catalog: true, ai_catalog: false, agent_skills: true, agent_skills_index: true, subresource_integrity: true,
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

describe("healthResponse", () => {
  it("returns the build-time deployed_at, not an epoch timestamp", async () => {
    const buildTime = "2026-05-13T20:00:00.000Z";
    const res = healthResponse(new Request("https://example.com/_webmcp/health"), makeConfig(), {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: buildTime,
    });
    const body = await res.json() as { deployed_at: string };
    expect(body.deployed_at).toBe(buildTime);
    expect(body.deployed_at).not.toContain("1970");
  });

  it("surfaces a preflight result when provided", async () => {
    const ranAt = "2026-05-13T19:55:00.000Z";
    const res = healthResponse(new Request("https://example.com/_webmcp/health"), makeConfig(), {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: "2026-05-13T20:00:00.000Z",
      preflight: { ran_at: ranAt, collisions: [], warnings: ["one warning"], config_hash: "abc12345" },
    });
    const body = await res.json() as { preflight: { ran_at: string; warnings: string[]; config_hash: string } };
    expect(body.preflight.ran_at).toBe(ranAt);
    expect(body.preflight.warnings).toEqual(["one warning"]);
    expect(body.preflight.config_hash).toBe("abc12345");
  });

  it("defaults preflight.ran_at to null when no preflight result is provided", async () => {
    const res = healthResponse(new Request("https://example.com/_webmcp/health"), makeConfig(), {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: "2026-05-13T20:00:00.000Z",
    });
    const body = await res.json() as { preflight: { ran_at: string | null } };
    expect(body.preflight.ran_at).toBeNull();
  });

  it("requires bearer token when health.token is set", async () => {
    const config = makeConfig({ health: { public: true, token: "s3cret" } });
    const unauth = healthResponse(new Request("https://example.com/_webmcp/health"), config, {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: "2026-05-13T20:00:00.000Z",
    });
    expect(unauth.status).toBe(401);
    const authed = healthResponse(
      new Request("https://example.com/_webmcp/health", { headers: { authorization: "Bearer s3cret" } }),
      config,
      { configHash: "abc12345", schemaVersion: 1, deployedAt: "2026-05-13T20:00:00.000Z" },
    );
    expect(authed.status).toBe(200);
  });
});
