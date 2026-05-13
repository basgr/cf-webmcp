import { describe, it, expect } from "vitest";
import { llmsTxtResponse, mergeBlock } from "./llms-txt";
import type { Config } from "../config-types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "Example", description: "desc", locale: "en" },
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
    webmcp_landing: { path: "/mcp/" },
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
        description: "Search.",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      },
    ],
    forms: [],
    ...overrides,
  };
}

describe("mergeBlock", () => {
  it("appends when marker absent", () => {
    const merged = mergeBlock("# llms\n", "BLOCK");
    expect(merged).toContain("BLOCK");
    expect(merged).toContain("<!-- cf-webmcp:begin -->");
    expect(merged).toContain("<!-- cf-webmcp:end -->");
  });

  it("is idempotent", () => {
    const first = mergeBlock("# llms\n", "BLOCK_V1");
    const second = mergeBlock(first, "BLOCK_V2");
    expect(second).toContain("BLOCK_V2");
    expect(second).not.toContain("BLOCK_V1");
    const beginCount = (second.match(/cf-webmcp:begin/g) ?? []).length;
    const endCount = (second.match(/cf-webmcp:end/g) ?? []).length;
    expect(beginCount).toBe(1);
    expect(endCount).toBe(1);
  });
});

describe("llmsTxtResponse", () => {
  it("synthesizes from TOML on origin 404", async () => {
    const proxy = async () => new Response("not found", { status: 404 });
    const config = makeConfig();
    const res = await llmsTxtResponse(new Request("https://example.com/llms.txt"), config, proxy);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("search_pages");
    expect(text).toContain("/mcp/");
    expect(text).toContain("/.well-known/webmcp.json");
  });

  it("merges into origin's text when present", async () => {
    const proxy = async () => new Response("# Original site llms.txt\n\nimportant content\n", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
    const config = makeConfig();
    const res = await llmsTxtResponse(new Request("https://example.com/llms.txt"), config, proxy);
    const text = await res.text();
    expect(text).toContain("important content");
    expect(text).toContain("cf-webmcp:begin");
    expect(text).toContain("search_pages");
  });

  it("synthesize mode ignores origin", async () => {
    const proxy = async () => new Response("origin content", { status: 200, headers: { "content-type": "text/plain" } });
    const config = makeConfig({ llms_txt: { path: "/llms.txt", mode: "synthesize" } });
    const res = await llmsTxtResponse(new Request("https://example.com/llms.txt"), config, proxy);
    const text = await res.text();
    expect(text).not.toContain("origin content");
    expect(text).toContain("search_pages");
  });

  it("passes origin through on unknown content-type", async () => {
    const proxy = async () => new Response("<html>fancy</html>", { status: 200, headers: { "content-type": "text/html" } });
    const config = makeConfig();
    const res = await llmsTxtResponse(new Request("https://example.com/llms.txt"), config, proxy);
    expect(await res.text()).toContain("<html>");
  });
});
