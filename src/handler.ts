/**
 * cf-webmcp request handler.
 *
 * createHandler() takes the compiled config, the embedded assets and the build
 * metadata as explicit dependencies and returns the Worker fetch handler. The
 * Worker entry (src/worker.ts) wires the generated modules into it; tests build
 * their own deps so config can vary per case.
 *
 * Matches the request against the route table, and either handles directly or
 * proxies to origin.
 */

import type { Config } from "./config-types";
import { matchRoute } from "./router";
import { manifestResponse, manifestRedirect } from "./routes/manifest";
import { landingRedirect, landingResponse } from "./routes/landing";
import { bootstrapResponse } from "./routes/bootstrap";
import { execResponse } from "./routes/exec";
import { healthResponse } from "./routes/health";
import { widgetResponse } from "./routes/widget";
import { llmsTxtResponse, type LlmsTxtTokenHints } from "./routes/llms-txt";
import { robotsTxtResponse } from "./routes/robots-txt";
import { agentsMdResponse, agentsMdRedirect } from "./routes/agents-md";
import { apiCatalogResponse } from "./routes/api-catalog";
import { aiCatalogResponse } from "./routes/ai-catalog";
import { agentSkillsResponse, agentSkillsRedirect } from "./routes/agent-skills";
import { agentSkillsIndexResponse } from "./routes/agent-skills-index";
import { buildLinkHeader, mergeLinkHeader } from "./link-header";
import { formsForPath, injectIntoHtml, shouldInject } from "./injection/html-rewriter";

export interface Env {
  CF_WEBMCP_ASSETS: R2Bucket;
  CF_WEBMCP_DEPLOY_TOKEN?: string;
  CF_WEBMCP_HEALTH_TOKEN?: string;
}

/** Bodies embedded at build time (src/generated/assets.ts). */
export interface HandlerAssets {
  bootstrapJs: string;
  landingHtml: string;
  manifestJson: string;
  aiCatalogJson: string;
}

/** Last preflight result embedded at build time (src/generated/config.ts). */
export interface HandlerPreflight {
  ran_at: string | null;
  collisions: string[];
  warnings: string[];
  config_hash?: string;
}

/** Build-time constants exported by src/generated/config.ts, besides `config` itself. */
export interface HandlerMeta {
  CONFIG_HASH: string;
  BOOTSTRAP_ASSET: string;
  WIDGET_ASSET: string;
  /**
   * Build-time UTC timestamp. We cannot call `new Date().toISOString()` at
   * module-init because Cloudflare Workers freeze Date.now() to 0 during
   * cold-start (returns 1970-01-01). The generated module embeds the real
   * build timestamp instead.
   */
  BUILD_AT: string;
  PREFLIGHT: HandlerPreflight;
  AGENT_SKILLS_DIGEST: string | null;
  BOOTSTRAP_SRI: string | null;
  LLMS_TXT_TOKEN_HINTS: LlmsTxtTokenHints;
}

export interface HandlerDeps {
  config: Config;
  assets: HandlerAssets;
  meta: HandlerMeta;
}

export function createHandler(deps: HandlerDeps): Required<Pick<ExportedHandler<Env>, "fetch">> {
  const { config, assets, meta } = deps;

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const url = new URL(request.url);
      const match = matchRoute(config, url, meta.BOOTSTRAP_ASSET, meta.WIDGET_ASSET);

      switch (match.kind) {
        case "manifest":
          return handleHeadable(request, manifestResponse(assets.manifestJson, config, meta.CONFIG_HASH));
        case "manifest_redirect":
          return manifestRedirect(config);
        case "landing":
          return handleHeadable(request, landingResponse(assets.landingHtml, config, meta.CONFIG_HASH));
        case "landing_redirect":
          return landingRedirect(config.webmcp_landing.path);
        case "bootstrap":
          return handleHeadable(request, bootstrapResponse(assets.bootstrapJs, config));
        case "widget":
          return widgetResponse(request, config, env.CF_WEBMCP_ASSETS, meta.WIDGET_ASSET);
        case "exec":
          return execResponse(
            request,
            config,
            match.toolName!,
            { domain: config.site.domain, deployToken: env.CF_WEBMCP_DEPLOY_TOKEN ?? "" },
            (p) => ctx.waitUntil(p),
          );
        case "health":
          return healthResponse(request, config, {
            configHash: meta.CONFIG_HASH,
            schemaVersion: config.schema_version,
            deployedAt: meta.BUILD_AT,
            preflight: meta.PREFLIGHT,
          });
        case "llms_txt":
          return llmsTxtResponse(request, config, (u) => proxyToOrigin(u, env), meta.LLMS_TXT_TOKEN_HINTS);
        case "robots_txt":
          return robotsTxtResponse(request, config, (u) => proxyToOrigin(u, env));
        case "agents_md":
          return agentsMdResponse(request, config, (u) => proxyToOrigin(u, env));
        case "agents_md_redirect":
          return agentsMdRedirect(config);
        case "api_catalog":
          return apiCatalogResponse(request, config, (u) => proxyToOrigin(u, env));
        case "ards_catalog":
          return aiCatalogResponse(request, config, assets.aiCatalogJson, (u) => proxyToOrigin(u, env));
        case "agent_skills":
          return agentSkillsResponse(request, config, (u) => proxyToOrigin(u, env));
        case "agent_skills_redirect":
          return agentSkillsRedirect(config);
        case "agent_skills_index":
          return handleHeadable(request, agentSkillsIndexResponse(request, config, meta.AGENT_SKILLS_DIGEST));
        case "proxy":
          return proxyAndMaybeInject(request, env);
      }
    },
  };

  function handleHeadable(request: Request, response: Response): Response {
    if (request.method === "HEAD") {
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  }

  async function proxyToOrigin(url: URL, env: Env): Promise<Response> {
    const target = new URL(url.pathname + url.search, config.origin.base_url);
    const headers = new Headers();
    headers.set("user-agent", "cf-webmcp/1.0");
    if (env.CF_WEBMCP_DEPLOY_TOKEN) {
      headers.set("cf-webmcp-bypass", "1");
      headers.set("cf-webmcp-deploy-token", env.CF_WEBMCP_DEPLOY_TOKEN);
    }
    const res = await fetch(target.toString(), { method: "GET", headers, redirect: "follow" });
    // Defense in depth: refuse to relay content from any host outside the
    // configured allow-list, even if origin redirected us there.
    if (res.url) {
      try {
        const finalOrigin = new URL(res.url).origin;
        const allowed = config.origin.allowed_origins.map((u) => new URL(u).origin);
        if (!allowed.includes(finalOrigin)) {
          return new Response(
            `origin redirected to ${finalOrigin} which is not in allowed_origins`,
            {
              status: 502,
              headers: {
                "content-type": "text/plain; charset=utf-8",
                // proxyToOrigin is invoked from routes under /.well-known/*; tag
                // the SSRF-rejection body too so it never gets indexed.
                "x-robots-tag": "noindex",
              },
            },
          );
        }
      } catch {
        return new Response("origin returned malformed final URL", {
          status: 502,
          headers: { "x-robots-tag": "noindex" },
        });
      }
    }
    return res;
  }

  async function proxyAndMaybeInject(request: Request, env: Env): Promise<Response> {
    const reqUrl = new URL(request.url);
    const target = new URL(reqUrl.pathname + reqUrl.search, config.origin.base_url);

    // redirect:"manual" - pass any 3xx response back to the visitor's browser
    // unchanged instead of auto-following. Auto-following would mean the worker
    // injects the bootstrapper into the FINAL response, even if origin redirected
    // off-host. The visitor's browser handles redirect chains natively; we just
    // relay them.
    const upstream = await fetch(target.toString(), new Request(request, { redirect: "manual" }));

    if (!config.features.inject_html) return upstream;
    if (!shouldInject(request, upstream, config)) return withLinkHeader(upstream);

    const base = config.site.public_url ?? `https://${config.site.domain}`;
    const manifestUrl = `${base}${config.manifest.path}`;
    const bootstrapUrl = `${base}${config.paths.namespace}/${meta.BOOTSTRAP_ASSET}`;
    const apiCatalogUrl =
      config.features.api_catalog && config.api_catalog.mode !== "passthrough"
        ? `${base}${config.api_catalog.path}`
        : undefined;
    const aiCatalogUrl =
      config.features.ai_catalog && config.ai_catalog.mode !== "passthrough"
        ? `${base}${config.ai_catalog.path}`
        : undefined;
    const agentSkillsUrl =
      config.features.agent_skills && config.agent_skills.mode !== "passthrough"
        ? `${base}${config.agent_skills.path}`
        : undefined;
    const llmsTxtUrl =
      config.features.llms_txt && config.llms_txt.mode !== "passthrough"
        ? `${base}${config.llms_txt.path}`
        : undefined;
    const bootstrapIntegrity = meta.BOOTSTRAP_SRI ?? undefined;
    const forms = formsForPath(config.forms, reqUrl.pathname);
    const injected = injectIntoHtml(upstream, {
      manifestUrl,
      bootstrapUrl,
      emitLinkTag: config.features.link_tag,
      apiCatalogUrl,
      aiCatalogUrl,
      agentSkillsUrl,
      llmsTxtUrl,
      bootstrapIntegrity,
      forms,
    });
    return withLinkHeader(injected);
  }

  function withLinkHeader(response: Response): Response {
    if (!config.features.link_header) return response;
    const headers = new Headers(response.headers);
    headers.set("link", mergeLinkHeader(headers.get("link"), buildLinkHeader(config)));
    return new Response(response.body, { status: response.status, headers });
  }
}
