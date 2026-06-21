import { describe, it, expect } from "vitest";
import { aiCatalogResponse } from "./ai-catalog";
import type { Config } from "../config-types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: {
      domain: "example.com",
      name: "Example",
      description: "desc",
      locale: "en",
      public_url: "https://example.com",
    },
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
      ai_catalog: true,
      agent_skills: true,
      agent_skills_index: true,
      subresource_integrity: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" },
    ai_catalog: { path: "/.well-known/ai-catalog.json", mode: "synthesize", host_identifier: "", representative_queries: [], tags: [] },
    agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] },
    agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
    paths: { namespace: "/_webmcp" },
    injection: { exclude_paths: [] },
    cache: {
      manifest_max_age: 300,
      manifest_s_maxage: 86400,
      manifest_swr: 604800,
      manifest_sie: 86400,
      landing_max_age: 300,
      landing_s_maxage: 86400,
      landing_swr: 86400,
      landing_sie: 86400,
      llms_txt_max_age: 300,
      llms_txt_s_maxage: 3600,
      llms_txt_swr: 86400,
      llms_txt_sie: 86400,
      robots_txt_max_age: 300,
      robots_txt_s_maxage: 3600,
      robots_txt_swr: 86400,
      robots_txt_sie: 86400,
      agents_md_max_age: 300,
      agents_md_s_maxage: 21600,
      agents_md_swr: 86400,
      agents_md_sie: 86400,
      agents_md_redirect_max_age: 86400,
      agents_md_redirect_s_maxage: 604800,
      api_catalog_max_age: 300,
      api_catalog_s_maxage: 21600,
      api_catalog_swr: 86400,
      api_catalog_sie: 86400,
      ai_catalog_max_age: 300,
      ai_catalog_s_maxage: 21600,
      ai_catalog_swr: 86400,
      ai_catalog_sie: 86400,
      agent_skills_max_age: 300,
      agent_skills_s_maxage: 21600,
      agent_skills_swr: 86400,
      agent_skills_sie: 86400,
      agent_skills_redirect_max_age: 86400,
      agent_skills_redirect_s_maxage: 604800,
      agent_skills_index_max_age: 300,
      agent_skills_index_s_maxage: 21600,
      agent_skills_index_swr: 86400,
      agent_skills_index_sie: 86400,
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

const cfg = makeConfig();

const SYNTH_BODY =
  JSON.stringify({ specVersion: "1.0", host: { displayName: "Example", identifier: "did:web:example.com" }, entries: [] }, null, 2) + "\n";

const noProxy = async () => new Response(null, { status: 404 });

describe("aiCatalogResponse (synthesize)", () => {
  it("serves the catalog with ARD headers", async () => {
    const res = await aiCatalogResponse(
      new Request("https://example.com/.well-known/ai-catalog.json"),
      cfg,
      SYNTH_BODY,
      noProxy,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/ai-catalog+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(SYNTH_BODY);
  });

  it("sets correct cache-control header", async () => {
    const res = await aiCatalogResponse(
      new Request("https://example.com/.well-known/ai-catalog.json"),
      cfg,
      SYNTH_BODY,
      noProxy,
    );
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=300");
    expect(cc).toContain("s-maxage=21600");
    expect(cc).toContain("stale-while-revalidate=86400");
  });

  it("returns exactly the synthesized body as-is", async () => {
    const body = '{"specVersion":"1.0","host":{"displayName":"Test"},"entries":[]}\n';
    const res = await aiCatalogResponse(
      new Request("https://example.com/.well-known/ai-catalog.json"),
      cfg,
      body,
      noProxy,
    );
    expect(await res.text()).toBe(body);
  });
});

const SYNTH_ONE = JSON.stringify(
  { specVersion: "1.0", host: { displayName: "Example", identifier: "did:web:example.com" },
    entries: [{ identifier: "urn:air:example.com:skill:example", displayName: "Example", type: "application/ai-skill+md", url: "https://example.com/.well-known/agent-skills/site/SKILL.md" }] },
  null, 2) + "\n";

const originDoc = (entries: unknown[]) =>
  new Response(JSON.stringify({ specVersion: "1.0", host: { displayName: "O", identifier: "did:web:example.com" }, entries }), { status: 200, headers: { "content-type": "application/json" } });

const req = new Request("https://example.com/.well-known/ai-catalog.json");

describe("aiCatalogResponse (merge)", () => {
  const cfgMerge = { ...cfg, ai_catalog: { ...cfg.ai_catalog, mode: "merge" as const } };

  it("splices our entry into an origin catalog and is idempotent", async () => {
    const res1 = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
      originDoc([{ identifier: "urn:air:example.com:agent:other", displayName: "Other", type: "application/a2a-agent-card+json", url: "https://example.com/a.json" }]));
    const body1 = await res1.text();
    const ids = JSON.parse(body1).entries.map((e: any) => e.identifier);
    expect(ids).toContain("urn:air:example.com:skill:example");
    expect(JSON.parse(body1).entries).toHaveLength(2);
    // Idempotent: feed our own output back as the origin -> byte identical.
    const res2 = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
      new Response(body1, { status: 200, headers: { "content-type": "application/json" } }));
    expect(await res2.text()).toBe(body1);
  });

  it("falls back to synthesized on 404, unparseable, or invalid entry member", async () => {
    const cases = [
      async () => new Response(null, { status: 404 }),
      async () => new Response("not json", { status: 200, headers: { "content-type": "application/json" } }),
      async () => new Response(JSON.stringify({ entries: [{ noId: true }] }), { status: 200, headers: { "content-type": "application/json" } }),
    ];
    for (const proxy of cases) {
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, proxy);
      expect(JSON.parse(await res.text()).entries).toHaveLength(1);
    }
  });

  it("relays a non-JSON origin response with noindex added", async () => {
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
      new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("does NOT merge when origin content-type is text/json or text/plain - relays unchanged (Fix B)", async () => {
    // text/json and text/plain look JSON-ish but are not application/* types.
    // The anchored regex should reject them and fall through to the relay path,
    // NOT splice our entry in.
    const jsonBody = JSON.stringify({
      specVersion: "1.0",
      host: { displayName: "O", identifier: "did:web:example.com" },
      entries: [{ identifier: "urn:air:example.com:agent:other", displayName: "Other", type: "application/a2a-agent-card+json", url: "https://example.com/a.json" }],
    });
    for (const ct of ["text/json", "text/plain"]) {
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(jsonBody, { status: 200, headers: { "content-type": ct } }));
      // Relayed: x-robots-tag must be noindex (withNoindex path) and the body
      // must be the raw origin body, NOT the merged ai-catalog+json document.
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("content-type")).not.toBe("application/ai-catalog+json");
    }
  });
});
