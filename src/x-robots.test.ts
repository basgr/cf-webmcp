/**
 * Coverage rule: every route cf-webmcp serves under `/_webmcp/*` or
 * `/.well-known/*` MUST emit `X-Robots-Tag: noindex`. `/llms.txt` and
 * `/robots.txt` at apex are explicit exceptions: they MUST NOT carry the
 * header on any answer (a merge, a relayed redirect, a 502 or 504, an origin
 * answer relayed as it came).
 *
 * The exception belongs to the apex path, not to the route kind: a config that
 * puts llms.txt or robots.txt under the namespace or `/.well-known/` gets
 * noindex on every answer there (see the last describe block).
 *
 * A path in `passthrough` mode is not served by cf-webmcp at all: the router
 * hands it to the ordinary proxy, and the response is origin's own. The rule
 * does not apply to it, and the Worker adds no header there.
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
import { matchRoute, type RouteMatch } from "./router";
import { manifestResponse, manifestRedirect } from "./routes/manifest";
import { landingResponse, landingRedirect } from "./routes/landing";
import { bootstrapResponse } from "./routes/bootstrap";
import { execResponse } from "./routes/exec";
import { healthResponse } from "./routes/health";
import { widgetResponse } from "./routes/widget";
import { assetNotFoundResponse } from "./routes/asset-not-found";
import { namespaceNotFoundResponse } from "./routes/namespace-not-found";
import { llmsTxtResponse } from "./routes/llms-txt";
import { robotsTxtResponse } from "./routes/robots-txt";
import { agentsMdResponse, agentsMdRedirect } from "./routes/agents-md";
import { apiCatalogResponse } from "./routes/api-catalog";
import { agentSkillsResponse, agentSkillsRedirect } from "./routes/agent-skills";
import { agentSkillsIndexResponse } from "./routes/agent-skills-index";
import { aiCatalogResponse, ardRedirect } from "./routes/ai-catalog";

const PROTECTED_PREFIXES = ["/_webmcp/", "/.well-known/"] as const;

function isProtected(path: string): boolean {
  return PROTECTED_PREFIXES.some((p) => path.startsWith(p));
}

// Classification of every RouteMatch kind. TypeScript fails to compile this
// file if a new kind is added to router.ts without a classification entry.
//   noindex_required:  the answer MUST carry X-Robots-Tag: noindex
//   noindex_forbidden: the answer MUST NOT carry X-Robots-Tag at all (apex discovery files)
//   exempt:            no rule; cf-webmcp does not own the response, or the path is not under a protected prefix
type Classification = "noindex_required" | "noindex_forbidden" | "exempt";
const CLASSIFICATION: Record<RouteMatch["kind"], Classification> = {
  manifest: "noindex_required",                // /.well-known/webmcp
  manifest_redirect: "noindex_required",        // alias /.well-known/webmcp.json under a protected prefix
  landing: "exempt",                            // /mcp at apex (noindex is set anyway, but not required by rule)
  landing_redirect: "exempt",                   // /mcp at apex
  bootstrap: "noindex_required",                // /_webmcp/bootstrap.<hash>.js
  widget: "noindex_required",                   // /_webmcp/widget.<hash>.js
  asset_not_found: "noindex_required",          // /_webmcp/bootstrap.<stale>.js, /_webmcp/widget.<stale>.js (404)
  namespace_not_found: "noindex_required",      // /_webmcp/<anything else> incl. invalid exec tool names (404)
  exec: "noindex_required",                     // /_webmcp/exec/<tool>
  health: "noindex_required",                   // /_webmcp/health
  llms_txt: "noindex_forbidden",                // /llms.txt at apex (house rule: never noindex)
  robots_txt: "noindex_forbidden",              // /robots.txt at apex (house rule: never noindex)
  agents_md: "noindex_required",                // /.well-known/agents.md
  agents_md_redirect: "exempt",                 // /AGENTS.md, /agents.md at apex
  api_catalog: "noindex_required",              // /.well-known/api-catalog
  agent_skills: "noindex_required",             // /.well-known/agent-skills/<slug>/SKILL.md
  agent_skills_redirect: "noindex_required",    // aliases under /.well-known/agent-skills/
  agent_skills_index: "noindex_required",       // /.well-known/agent-skills/index.json
  ards_catalog: "noindex_required",             // /.well-known/ard.json
  ards_catalog_redirect: "noindex_required",    // alias /.well-known/ai-catalog.json (301) under a protected prefix
  proxy: "exempt",                              // origin content; cf-webmcp does not own the response
};

// Sample path each kind canonically resolves to in the example-site config.
// Used to cross-check the classification against the prefix rule.
function samplePath(kind: RouteMatch["kind"], config: Config): string {
  switch (kind) {
    case "manifest": return config.manifest.path;
    case "manifest_redirect": return config.manifest.aliases[0] ?? "/.well-known/webmcp.json";
    case "landing":
    case "landing_redirect": return config.webmcp_landing.path;
    case "bootstrap": return `${config.paths.namespace}/bootstrap.abc12345.js`;
    case "widget": return `${config.paths.namespace}/widget.abc12345.js`;
    case "asset_not_found": return `${config.paths.namespace}/bootstrap.stale0000000000.js`;
    case "namespace_not_found": return `${config.paths.namespace}/does-not-exist`;
    case "exec": return `${config.paths.namespace}/exec/${config.tools[0]!.name}`;
    case "health": return `${config.paths.namespace}/health`;
    case "llms_txt": return config.llms_txt.path;
    case "robots_txt": return config.robots_txt.path;
    case "agents_md": return config.agents_md.path;
    case "agents_md_redirect": return config.agents_md.aliases[0] ?? "/AGENTS.md";
    case "api_catalog": return config.api_catalog.path;
    case "agent_skills": return config.agent_skills.path;
    case "agent_skills_redirect": return config.agent_skills.aliases[0] ?? "/.well-known/agent-skills/site/SKILLS.md";
    case "agent_skills_index": return config.agent_skills_index.path;
    case "ards_catalog": return config.ai_catalog.path;
    case "ards_catalog_redirect": return config.ai_catalog.aliases[0] ?? "/.well-known/ai-catalog.json";
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
      llms_txt: true, robots_txt: true, agents_md: true, api_catalog: true, ai_catalog: true, agent_skills: true, agent_skills_index: true, subresource_integrity: true, fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
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
    agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
    ai_catalog: { path: "/.well-known/ard.json", aliases: ["/.well-known/ai-catalog.json"], mode: "synthesize", skill_type: "application/ai-skill+md", host_identifier: "", representative_queries: [], tags: [] },
    origin_trial: { tokens: [] },
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
      ai_catalog_max_age: 300, ai_catalog_s_maxage: 21600, ai_catalog_swr: 86400, ai_catalog_sie: 86400,
      agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400,
      agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
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
    case "manifest_redirect":
      return manifestRedirect(config);
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
    case "asset_not_found":
      return assetNotFoundResponse();
    case "namespace_not_found":
      return namespaceNotFoundResponse();
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
    case "agent_skills_index":
      // Use a fake but well-formed digest; the handler emits a 200 either way.
      return agentSkillsIndexResponse(
        new Request("https://example.com" + config.agent_skills_index.path),
        config,
        `sha256:${"a".repeat(64)}`,
      );
    case "ards_catalog":
      return aiCatalogResponse(
        new Request("https://example.com" + config.ai_catalog.path),
        config,
        JSON.stringify({ host: { displayName: "x", identifier: "did:web:example.com" }, entries: [] }, null, 2) + "\n",
        async (_url: URL) => new Response(null, { status: 404 }),
      );
    case "ards_catalog_redirect":
      return ardRedirect(config);
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

  it("no 'exempt' or 'noindex_forbidden' kind has its canonical path under a protected prefix", () => {
    const misclassified: string[] = [];
    for (const kind of kinds) {
      if (CLASSIFICATION[kind] === "noindex_required") continue;
      const path = samplePath(kind, config);
      if (isProtected(path)) {
        misclassified.push(`${kind} -> ${path} (classified ${CLASSIFICATION[kind]} but path is under a protected prefix)`);
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

// What proxyToOrigin can hand a route: its own relays and failures carry noindex (most of its callers
// live under /.well-known/), and an origin answer can carry any header, X-Robots-Tag included.
const upstreamAnswers: Record<string, () => Response> = {
  "origin has no file (404)": () => new Response("", { status: 404 }),
  "origin text file (200)": () => new Response("# origin\n", { status: 200, headers: { "content-type": "text/plain" } }),
  "origin text file (200) that sends its own noindex": () =>
    new Response("# origin\n", { status: 200, headers: { "content-type": "text/plain", "x-robots-tag": "noindex" } }),
  "relayed redirect that left allowed_origins": () =>
    new Response(null, {
      status: 301,
      headers: { location: "https://www.example.com/x", "cache-control": "no-store", "x-robots-tag": "noindex" },
    }),
  "502 from proxyToOrigin": () =>
    new Response("origin request failed", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    }),
  "504 from proxyToOrigin": () =>
    new Response("origin did not answer in time", {
      status: 504,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    }),
  "origin 5xx relayed as it came": () => new Response("boom", { status: 503, headers: { "content-type": "text/plain" } }),
  "origin 5xx that sends its own noindex": () =>
    new Response("boom", { status: 503, headers: { "content-type": "text/plain", "x-robots-tag": "noindex" } }),
  "origin HTML (not mergeable)": () =>
    new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
};

function forbiddenRoute(kind: RouteMatch["kind"], config: Config, answer: () => Response): Promise<Response> {
  const proxy = async () => answer();
  switch (kind) {
    case "llms_txt":
      return llmsTxtResponse(new Request("https://example.com/llms.txt"), config, proxy);
    case "robots_txt":
      return robotsTxtResponse(new Request("https://example.com/robots.txt"), config, proxy);
    default:
      throw new Error(`no 'noindex_forbidden' route builder for kind ${kind}; add one`);
  }
}

describe("X-Robots-Tag is absent on the apex discovery files, whatever the answer", () => {
  const config = makeConfig();
  const forbidden = (Object.keys(CLASSIFICATION) as RouteMatch["kind"][]).filter(
    (k) => CLASSIFICATION[k] === "noindex_forbidden",
  );

  it("classifies llms.txt and robots.txt as noindex_forbidden", () => {
    expect([...forbidden].sort()).toEqual(["llms_txt", "robots_txt"]);
  });

  for (const kind of forbidden) {
    for (const [label, answer] of Object.entries(upstreamAnswers)) {
      it(`${kind}: ${label}`, async () => {
        const res = await forbiddenRoute(kind, config, answer);
        expect(
          [...res.headers.keys()],
          `${kind} (sample path ${samplePath(kind, config)}) must carry no X-Robots-Tag, got ${JSON.stringify(res.headers.get("x-robots-tag"))}`,
        ).not.toContain("x-robots-tag");
      });
    }
  }

  it("keeps the status, body and other headers of what it relays", async () => {
    const res = await forbiddenRoute("robots_txt", config, upstreamAnswers["502 from proxyToOrigin"]!);
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("origin request failed");

    const redirect = await forbiddenRoute("llms_txt", config, upstreamAnswers["relayed redirect that left allowed_origins"]!);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe("https://www.example.com/x");
    expect(redirect.headers.get("cache-control")).toBe("no-store");
  });
});

describe("a path in passthrough mode is origin's, not a route cf-webmcp serves", () => {
  // The router hands these to the ordinary proxy ("proxy" is classified exempt), so the noindex rule
  // does not apply and the Worker adds no X-Robots-Tag to the origin answer.
  const base = makeConfig();
  const request = (path: string) => new Request(`https://example.com${path}`);
  const surfaces: Array<{ name: string; config: Config; paths: string[] }> = [
    { name: "llms_txt", config: { ...base, llms_txt: { ...base.llms_txt, mode: "passthrough" } }, paths: [base.llms_txt.path] },
    { name: "robots_txt", config: { ...base, robots_txt: { ...base.robots_txt, mode: "passthrough" } }, paths: [base.robots_txt.path] },
    {
      name: "agents_md",
      config: { ...base, agents_md: { ...base.agents_md, mode: "passthrough" } },
      paths: [base.agents_md.path, ...base.agents_md.aliases],
    },
    { name: "api_catalog", config: { ...base, api_catalog: { ...base.api_catalog, mode: "passthrough" } }, paths: [base.api_catalog.path] },
    {
      name: "ai_catalog",
      config: { ...base, ai_catalog: { ...base.ai_catalog, mode: "passthrough" } },
      paths: [base.ai_catalog.path, ...base.ai_catalog.aliases],
    },
    {
      name: "agent_skills",
      config: { ...base, agent_skills: { ...base.agent_skills, mode: "passthrough" } },
      paths: [base.agent_skills.path, ...base.agent_skills.aliases],
    },
    {
      name: "agent_skills_index",
      config: { ...base, agent_skills_index: { ...base.agent_skills_index, mode: "passthrough" } },
      paths: [base.agent_skills_index.path],
    },
  ];

  for (const { name, config, paths } of surfaces) {
    it(`${name}: every path routes to the exempt proxy, so no noindex is expected`, () => {
      for (const path of paths) {
        const kind = matchRoute(config, request(path), "bootstrap.abc12345.js", "widget.abc12345.js").kind;
        expect(kind, `${name} path ${path} in passthrough mode`).toBe("proxy");
        expect(CLASSIFICATION[kind]).toBe("exempt");
      }
    });
  }
});

describe("llms.txt and robots.txt decide by their configured path", () => {
  // The apex exception belongs to the files at the apex. A config can put either file under a
  // protected prefix (the namespace or /.well-known/); then the prefix rule wins and every answer,
  // the merged one and the relays and failures alike, carries noindex.
  const base = makeConfig();
  const withPaths = (llms: string, robots: string, namespace = "/_webmcp"): Config => ({
    ...base,
    llms_txt: { ...base.llms_txt, path: llms },
    robots_txt: { ...base.robots_txt, path: robots },
    paths: { ...base.paths, namespace },
  });

  const underPrefix: Array<[string, Config]> = [
    ["the namespace", withPaths("/_webmcp/llms.txt", "/_webmcp/robots.txt")],
    ["/.well-known/", withPaths("/.well-known/llms.txt", "/.well-known/robots.txt")],
    ["a custom namespace", withPaths("/_x/llms.txt", "/_x/robots.txt", "/_x")],
  ];

  for (const [where, config] of underPrefix) {
    for (const kind of ["llms_txt", "robots_txt"] as const) {
      for (const [label, answer] of Object.entries(upstreamAnswers)) {
        it(`${kind} under ${where}: ${label} carries noindex`, async () => {
          const res = await forbiddenRoute(kind, config, answer);
          expect(res.headers.get("x-robots-tag"), `${kind} at ${samplePath(kind, config)}`).toBe("noindex");
        });
      }
    }
  }

  it("keeps the status, body and other headers when it adds noindex", async () => {
    const res = await forbiddenRoute("llms_txt", withPaths("/_webmcp/llms.txt", "/robots.txt"), upstreamAnswers["502 from proxyToOrigin"]!);
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("origin request failed");
  });

  it("still strips the header from a file outside the protected prefixes, even next to a custom namespace", async () => {
    const config = withPaths("/other/llms.txt", "/other/robots.txt", "/_x");
    for (const kind of ["llms_txt", "robots_txt"] as const) {
      for (const [label, answer] of Object.entries(upstreamAnswers)) {
        const res = await forbiddenRoute(kind, config, answer);
        expect([...res.headers.keys()], `${kind}: ${label}`).not.toContain("x-robots-tag");
      }
    }
  });
});
