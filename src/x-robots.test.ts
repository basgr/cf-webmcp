/**
 * Coverage rule: every route cf-webmcp serves under `/_webmcp/*` or
 * `/.well-known/*` MUST emit `X-Robots-Tag: noindex`. `/llms.txt` and
 * `/robots.txt` at apex are explicit exceptions.
 *
 * This file enumerates every `RouteMatch["kind"]` value via an exhaustive
 * `Record` type. Adding a new kind to `router.ts` will fail to compile here
 * until it is classified ("must noindex" or "exempt"). For every "must
 * noindex" entry the test then constructs a response from the relevant
 * handler and asserts the header is present.
 *
 * The path each kind resolves to is also cross-checked against the policy:
 * any "exempt" entry whose path falls under a protected prefix fails the
 * test (catches accidental misclassification).
 */

import { describe, it, expect } from "vitest";
import type { Config, FormInjectionConfig } from "./config-types";
import type { RouteMatch } from "./router";
import { manifestResponse } from "./routes/manifest";
import { landingResponse, landingRedirect } from "./routes/landing";
import { bootstrapResponse } from "./routes/bootstrap";
import { execResponse } from "./routes/exec";
import { healthResponse } from "./routes/health";
import { widgetResponse } from "./routes/widget";
import { llmsTxtResponse } from "./routes/llms-txt";
import { robotsTxtResponse } from "./routes/robots-txt";
import { agentsMdResponse, agentsMdRedirect } from "./routes/agents-md";
import { apiCatalogResponse } from "./routes/api-catalog";
import { agentSkillsResponse, agentSkillsRedirect } from "./routes/agent-skills";

const PROTECTED_PREFIXES = ["/_webmcp/", "/.well-known/"] as const;

function isProtected(path: string): boolean {
  return PROTECTED_PREFIXES.some((p) => path.startsWith(p));
}

// Classification of every RouteMatch kind. TypeScript fails to compile this
// file if a new kind is added to router.ts without a classification entry.
type Classification = "noindex_required" | "exempt";
const CLASSIFICATION: Record<RouteMatch["kind"], Classification> = {
  manifest: "noindex_required",                // /.well-known/webmcp.json
  landing: "exempt",                            // /mcp at apex (noindex is set anyway, but not required by rule)
  landing_redirect: "exempt",                   // /mcp at apex
  bootstrap: "noindex_required",                // /_webmcp/bootstrap.<hash>.js
  widget: "noindex_required",                   // /_webmcp/widget.<hash>.js
  exec: "noindex_required",                     // /_webmcp/exec/<tool>
  health: "noindex_required",                   // /_webmcp/health
  llms_txt: "exempt",                           // /llms.txt at apex (memory rule)
  robots_txt: "exempt",                         // /robots.txt at apex (memory rule)
  agents_md: "noindex_required",                // /.well-known/agents.md
  agents_md_redirect: "exempt",                 // /AGENTS.md, /agents.md at apex
  api_catalog: "noindex_required",              // /.well-known/api-catalog
  agent_skills: "noindex_required",             // /.well-known/agent-skills/<slug>/SKILL.md
  agent_skills_redirect: "noindex_required",    // aliases under /.well-known/agent-skills/
  proxy: "exempt",                              // origin content; cf-webmcp does not own the response
};

// Sample path each kind canonically resolves to in the example-site config.
// Used to cross-check the classification against the prefix rule.
function samplePath(kind: RouteMatch["kind"], config: Config): string {
  switch (kind) {
    case "manifest": return config.manifest.path;
    case "landing":
    case "landing_redirect": return config.webmcp_landing.path;
    case "bootstrap": return `${config.paths.namespace}/bootstrap.abc12345.js`;
    case "widget": return `${config.paths.namespace}/widget.abc12345.js`;
    case "exec": return `${config.paths.namespace}/exec/${config.tools[0]!.name}`;
    case "health": return `${config.paths.namespace}/health`;
    case "llms_txt": return config.llms_txt.path;
    case "robots_txt": return config.robots_txt.path;
    case "agents_md": return config.agents_md.path;
    case "agents_md_redirect": return config.agents_md.aliases[0] ?? "/AGENTS.md";
    case "api_catalog": return config.api_catalog.path;
    case "agent_skills": return config.agent_skills.path;
    case "agent_skills_redirect": return config.agent_skills.aliases[0] ?? "/.well-known/agent-skills/site/SKILLS.md";
    case "proxy": return "/";
  }
}

function makeConfig(): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "Example", description: "x", locale: "en", public_url: "https://example.com" },
    origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"], forward_cookies: false },
    features: {
      inject_html: true, webmcp_landing: true, manifest: true, link_header: true, link_tag: true,
      llms_txt: true, robots_txt: true, agents_md: true, api_catalog: true, agent_skills: true, fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json" },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" },
    agent_skills: {
      path: "/.well-known/agent-skills/site/SKILL.md",
      mode: "synthesize",
      name: "",
      description: "",
      aliases: [
        "/.well-known/agent-skills/site/SKILLS.md",
        "/.well-known/agent-skills/site/skill.md",
        "/.well-known/agent-skills/site/skills.md",
      ],
      hints: [],
    },
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
      agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400,
      agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800,
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
    forms: [] as FormInjectionConfig[],
  };
}

function fakeBucket(content: string | null): R2Bucket {
  return {
    async get(_key: string): Promise<R2ObjectBody | null> {
      if (content === null) return null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(content));
          controller.close();
        },
      });
      return { body, httpEtag: '"x"' } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

// 404 proxy used for routes that fetch origin in merge mode; falls back to synthesize.
const proxy404 = async () => new Response("", { status: 404 });

async function responseFor(kind: RouteMatch["kind"], config: Config): Promise<Response> {
  switch (kind) {
    case "manifest":
      return manifestResponse("{}", config, "abc12345");
    case "landing":
      return landingResponse("<html><head></head><body></body></html>", config, "abc12345");
    case "landing_redirect":
      return landingRedirect(config.webmcp_landing.path);
    case "bootstrap":
      return bootstrapResponse("// js", config);
    case "widget":
      return widgetResponse(
        new Request("https://example.com/_webmcp/widget.abc12345.js"),
        config,
        fakeBucket("widget content"),
        "widget.abc12345.js",
      );
    case "exec":
      return execResponse(
        new Request("https://example.com/_webmcp/exec/search_pages", { method: "GET" }),
        config,
        "search_pages",
        { domain: "example.com", deployToken: "" },
        () => {},
      );
    case "health":
      return healthResponse(
        new Request("https://example.com/_webmcp/health"),
        config,
        { configHash: "abc12345", schemaVersion: 1, deployedAt: "2026-05-14T00:00:00.000Z" },
      );
    case "llms_txt":
      return llmsTxtResponse(new Request("https://example.com/llms.txt"), config, proxy404);
    case "robots_txt":
      return robotsTxtResponse(new Request("https://example.com/robots.txt"), config, proxy404);
    case "agents_md":
      return agentsMdResponse(new Request("https://example.com/.well-known/agents.md"), config, proxy404);
    case "agents_md_redirect":
      return agentsMdRedirect(config);
    case "api_catalog":
      return apiCatalogResponse(new Request("https://example.com/.well-known/api-catalog"), config, proxy404);
    case "agent_skills":
      return agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy404);
    case "agent_skills_redirect":
      return agentSkillsRedirect(config);
    case "proxy":
      // cf-webmcp does not own the response on the proxy path; the test verifies
      // only that the kind is classified "exempt", so a stub response suffices.
      return new Response("origin body");
  }
}

describe("X-Robots-Tag noindex coverage on protected-prefix routes", () => {
  const config = makeConfig();
  const kinds = Object.keys(CLASSIFICATION) as RouteMatch["kind"][];

  it("every kind is classified (TypeScript-enforced)", () => {
    expect(kinds.length).toBeGreaterThan(0);
  });

  it("no 'exempt' kind has its canonical path under a protected prefix", () => {
    const misclassified: string[] = [];
    for (const kind of kinds) {
      if (CLASSIFICATION[kind] !== "exempt") continue;
      const path = samplePath(kind, config);
      if (isProtected(path)) {
        misclassified.push(`${kind} -> ${path} (classified exempt but path is under a protected prefix)`);
      }
    }
    expect(misclassified, "exempt routes must not serve a protected-prefix path").toEqual([]);
  });

  for (const kind of kinds) {
    const cls = CLASSIFICATION[kind];
    if (cls !== "noindex_required") continue;
    it(`${kind} emits X-Robots-Tag: noindex`, async () => {
      const res = await responseFor(kind, config);
      const header = res.headers.get("x-robots-tag") ?? "";
      expect(
        header,
        `${kind} (sample path ${samplePath(kind, config)}) must emit X-Robots-Tag: noindex but got: ${JSON.stringify(header)}`,
      ).toContain("noindex");
    });
  }
});
