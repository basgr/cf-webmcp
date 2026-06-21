import { describe, it, expect } from "vitest";
import { robotsTxtResponse, mergeBlock } from "./robots-txt";
import type { Config } from "../config-types";

function makeConfig(): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "Example", description: "", locale: "en" },
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
    tools: [],
    forms: [],
  };
}

describe("robotsTxtResponse", () => {
  it("disallows the webmcp namespace, synthesizing on 404", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const res = await robotsTxtResponse(new Request("https://example.com/robots.txt"), makeConfig(), proxy);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Disallow: /_webmcp/");
    expect(text).not.toContain("Disallow: /mcp/");
    expect(text).not.toContain("# WebMCP-managed block");
  });

  it("preserves origin's robots rules and appends webmcp block", async () => {
    const origin = "User-agent: *\nDisallow: /private/\n";
    const proxy = async () => new Response(origin, { status: 200, headers: { "content-type": "text/plain" } });
    const res = await robotsTxtResponse(new Request("https://example.com/robots.txt"), makeConfig(), proxy);
    const text = await res.text();
    expect(text).toContain("Disallow: /private/");
    expect(text).toContain("# cf-webmcp:begin");
    expect(text).toContain("Disallow: /_webmcp/");
  });

  it("mergeBlock is idempotent", () => {
    const out1 = mergeBlock("User-agent: *\n", "RULES_V1");
    const out2 = mergeBlock(out1, "RULES_V2");
    expect(out2).toContain("RULES_V2");
    expect(out2).not.toContain("RULES_V1");
    const beginCount = (out2.match(/cf-webmcp:begin/g) ?? []).length;
    expect(beginCount).toBe(1);
  });

  it("includes Agentmap directive when ai_catalog and robots_txt features are on", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const res = await robotsTxtResponse(new Request("https://example.com/robots.txt"), makeConfig(), proxy);
    const text = await res.text();
    expect(text).toContain("Agentmap: https://example.com/.well-known/ai-catalog.json");
  });

  it("omits Agentmap directive when ai_catalog feature is off", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig();
    config.features.ai_catalog = false;
    const res = await robotsTxtResponse(new Request("https://example.com/robots.txt"), config, proxy);
    const text = await res.text();
    expect(text).not.toContain("Agentmap:");
  });

  it("Agentmap directive is idempotent on re-merge", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const config = makeConfig();
    const res1 = await robotsTxtResponse(new Request("https://example.com/robots.txt"), config, proxy);
    const first = await res1.text();
    // Simulate a second pass merging the already-merged output
    const proxy2 = async () => new Response(first, { status: 200, headers: { "content-type": "text/plain" } });
    const res2 = await robotsTxtResponse(new Request("https://example.com/robots.txt"), config, proxy2);
    const second = await res2.text();
    const agentmapCount = (second.match(/^Agentmap:/gm) ?? []).length;
    expect(agentmapCount).toBe(1);
    const beginCount = (second.match(/cf-webmcp:begin/g) ?? []).length;
    expect(beginCount).toBe(1);
  });
});
