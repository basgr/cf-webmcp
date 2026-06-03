import { describe, it, expect } from "vitest";
import { widgetResponse } from "./widget";
import type { Config } from "../config-types";

function makeConfig(): Config {
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
      robots_txt: true, agents_md: true, api_catalog: true, agent_skills: true, agent_skills_index: true, subresource_integrity: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
    webmcp_landing: { path: "/mcp/" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" }, agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] }, api_catalog: { path: "/.well-known/api-catalog", mode: "merge" }, agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] }, agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
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
      robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400, agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400, agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800, api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400, agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400, agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
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

function fakeBucket(content: string | null): R2Bucket {
  return {
    // Only get is exercised in tests; other R2Bucket methods are unused.
    async get(_key: string): Promise<R2ObjectBody | null> {
      if (content === null) return null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });
      return {
        body,
        httpEtag: '"deadbeef"',
        // Cast to satisfy R2ObjectBody for tests; we only consume body + httpEtag.
      } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

describe("widgetResponse", () => {
  it("returns 503 when object missing", async () => {
    const res = await widgetResponse(
      new Request("https://example.com/_webmcp/widget.abc.js"),
      makeConfig(),
      fakeBucket(null),
      "widget.abc.js",
    );
    expect(res.status).toBe(503);
  });

  it("serves content with MIT preamble", async () => {
    const widgetSource = "(function(){console.log('widget');})();";
    const res = await widgetResponse(
      new Request("https://example.com/_webmcp/widget.abc.js"),
      makeConfig(),
      fakeBucket(widgetSource),
      "widget.abc.js",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("cache-control")).toContain("immutable");
    const text = await res.text();
    expect(text).toContain("MIT License");
    expect(text).toContain("jasonjmcghee/WebMCP");
    expect(text).toContain("console.log('widget')");
  });

  it("HEAD returns headers, no body", async () => {
    const res = await widgetResponse(
      new Request("https://example.com/_webmcp/widget.abc.js", { method: "HEAD" }),
      makeConfig(),
      fakeBucket("x"),
      "widget.abc.js",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    const text = await res.text();
    expect(text).toBe("");
  });
});
