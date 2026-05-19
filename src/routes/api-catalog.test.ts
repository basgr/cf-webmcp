import { describe, it, expect } from "vitest";
import { apiCatalogResponse, tryMerge } from "./api-catalog";
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
      api_catalog: true, agent_skills: true, agent_skills_index: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json" },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" }, agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] }, agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
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
      api_catalog_sie: 86400, agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400, agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
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

const OUR_ENTRY = {
  anchor: "https://example.com/",
  webmcp: [{ href: "https://example.com/.well-known/webmcp.json", type: "application/json" }],
};

describe("apiCatalogResponse", () => {
  it("synthesizes a one-entry linkset when origin returns 404", async () => {
    const proxy = async () => new Response("nope", { status: 404 });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/linkset+json");
    const body = JSON.parse(await res.text());
    expect(body).toEqual({ linkset: [OUR_ENTRY] });
  });

  it("synthesize mode ignores origin entirely", async () => {
    const proxy = async () =>
      new Response(JSON.stringify({ linkset: [{ anchor: "https://example.com/", "service-desc": [{ href: "https://example.com/openapi.json" }] }] }), {
        status: 200,
        headers: { "content-type": "application/linkset+json" },
      });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig({ api_catalog: { path: "/.well-known/api-catalog", mode: "synthesize" } }),
      proxy,
    );
    const body = JSON.parse(await res.text());
    expect(body.linkset).toHaveLength(1);
    expect(body.linkset[0]).toEqual(OUR_ENTRY);
  });

  it("replace mode also ignores origin", async () => {
    const proxy = async () =>
      new Response(JSON.stringify({ linkset: [{ anchor: "https://other.example.com/", "service-desc": [{ href: "x" }] }] }), {
        status: 200,
        headers: { "content-type": "application/linkset+json" },
      });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig({ api_catalog: { path: "/.well-known/api-catalog", mode: "replace" } }),
      proxy,
    );
    const body = JSON.parse(await res.text());
    expect(body.linkset).toHaveLength(1);
    expect(body.linkset[0]).toEqual(OUR_ENTRY);
  });

  it("merges into origin linkset that has unrelated entries", async () => {
    const origin = {
      linkset: [
        {
          anchor: "https://example.com/api/v1",
          "service-desc": [{ href: "https://example.com/api/v1/openapi.json", type: "application/openapi+json" }],
        },
      ],
    };
    const proxy = async () =>
      new Response(JSON.stringify(origin), {
        status: 200,
        headers: { "content-type": "application/linkset+json" },
      });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy,
    );
    const body = JSON.parse(await res.text());
    expect(body.linkset).toHaveLength(2);
    expect(body.linkset.find((e: { anchor: string }) => e.anchor === "https://example.com/")).toEqual(OUR_ENTRY);
    expect(body.linkset.find((e: { anchor: string }) => e.anchor === "https://example.com/api/v1")).toBeTruthy();
  });

  it("merges into the same anchor when origin already has an entry there", async () => {
    const origin = {
      linkset: [
        {
          anchor: "https://example.com/",
          "service-desc": [{ href: "https://example.com/openapi.json", type: "application/openapi+json" }],
        },
      ],
    };
    const proxy = async () =>
      new Response(JSON.stringify(origin), {
        status: 200,
        headers: { "content-type": "application/linkset+json" },
      });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy,
    );
    const body = JSON.parse(await res.text());
    expect(body.linkset).toHaveLength(1);
    const entry = body.linkset[0];
    expect(entry.anchor).toBe("https://example.com/");
    expect(entry["service-desc"]).toBeTruthy();
    expect(entry.webmcp).toEqual([{ href: "https://example.com/.well-known/webmcp.json", type: "application/json" }]);
  });

  it("merge is idempotent (re-running against own output produces same bytes)", async () => {
    const empty = { linkset: [] };
    const proxy1 = async () =>
      new Response(JSON.stringify(empty), { status: 200, headers: { "content-type": "application/linkset+json" } });
    const r1 = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy1,
    );
    const first = await r1.text();
    const proxy2 = async () =>
      new Response(first, { status: 200, headers: { "content-type": "application/linkset+json" } });
    const r2 = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy2,
    );
    const second = await r2.text();
    expect(second).toBe(first);
  });

  it("falls back to synthesize when origin returns malformed JSON", async () => {
    const proxy = async () =>
      new Response("not json {{{", { status: 200, headers: { "content-type": "application/json" } });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy,
    );
    const body = JSON.parse(await res.text());
    expect(body).toEqual({ linkset: [OUR_ENTRY] });
  });

  it("falls back to synthesize when origin JSON has no linkset array", async () => {
    const proxy = async () =>
      new Response(JSON.stringify({ foo: "bar" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy,
    );
    const body = JSON.parse(await res.text());
    expect(body).toEqual({ linkset: [OUR_ENTRY] });
  });

  it("passes origin through unchanged when content-type is not JSON or linkset+json", async () => {
    const proxy = async () =>
      new Response("<html>hello</html>", { status: 200, headers: { "content-type": "text/html" } });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy,
    );
    expect(await res.text()).toContain("<html>");
  });

  it("sets correct cache-control header", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const res = await apiCatalogResponse(
      new Request("https://example.com/.well-known/api-catalog"),
      makeConfig(),
      proxy,
    );
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=300");
    expect(cc).toContain("s-maxage=21600");
    expect(cc).toContain("stale-while-revalidate=86400");
  });
});

describe("tryMerge", () => {
  const our = OUR_ENTRY;

  it("returns null for malformed JSON", () => {
    expect(tryMerge("not json", our)).toBeNull();
  });

  it("returns null when linkset is missing or not an array", () => {
    expect(tryMerge(JSON.stringify({}), our)).toBeNull();
    expect(tryMerge(JSON.stringify({ linkset: "string" }), our)).toBeNull();
  });

  it("returns null when an entry lacks an anchor", () => {
    expect(tryMerge(JSON.stringify({ linkset: [{ foo: "bar" }] }), our)).toBeNull();
  });

  it("is idempotent against its own output", () => {
    const empty = JSON.stringify({ linkset: [] });
    const first = tryMerge(empty, our)!;
    const second = tryMerge(first, our)!;
    expect(second).toBe(first);
  });
});
