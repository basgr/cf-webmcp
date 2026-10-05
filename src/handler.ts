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
import { assetNotFoundResponse } from "./routes/asset-not-found";
import { namespaceNotFoundResponse } from "./routes/namespace-not-found";
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
import { appendOriginTrialHeaders } from "./origin-trial";
import { formsForPath, safeInject, shouldInject } from "./injection/html-rewriter";
import { fetchWithManualRedirects, isAbortError, logRedirectFailure, type RedirectFailure } from "./safe-fetch";

/**
 * One deadline for a whole proxyToOrigin redirect chain, up to the moment the final
 * response headers arrive. It is cleared then, so a body that is being relayed is
 * never cut off by it.
 */
export const PROXY_ORIGIN_TIMEOUT_MS = 10_000;

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
  /** Content-addressed bootstrap file name: bootstrap.<sha256(body) first 16 hex>.js. */
  BOOTSTRAP_ASSET: string;
  /**
   * Content-addressed widget R2 key: widget.<served_sha256 first 16 hex>.js, from
   * vendor/webmcp/current.json. null when the build ships no widget (no usable pin).
   */
  WIDGET_ASSET: string | null;
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
      const match = matchRoute(config, request, meta.BOOTSTRAP_ASSET, meta.WIDGET_ASSET);

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
          // matchRoute only returns "widget" for a non-null WIDGET_ASSET; the
          // guard keeps the type honest and fails closed if that ever changes.
          if (meta.WIDGET_ASSET === null) return handleHeadable(request, assetNotFoundResponse());
          return widgetResponse(request, config, env.CF_WEBMCP_ASSETS, meta.WIDGET_ASSET);
        case "asset_not_found":
          return handleHeadable(request, assetNotFoundResponse());
        case "namespace_not_found":
          return handleHeadable(request, namespaceNotFoundResponse());
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
            widgetAsset: meta.WIDGET_ASSET,
            bucket: env.CF_WEBMCP_ASSETS,
            envToken: env.CF_WEBMCP_HEALTH_TOKEN,
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

  /**
   * GET a path on origin for the merge routes (llms.txt, robots.txt, agents.md and
   * the catalogs). Redirects are followed here, not by the runtime, so every hop is
   * checked against allowed_origins before it is requested and the deploy token only
   * ever goes to a listed origin. An origin redirect that leaves the list is relayed
   * to the caller's client instead of followed. Any other failure is a 502 (a stalled
   * origin a 504), always with noindex, so a route never throws. The llms.txt and
   * robots.txt routes remove that noindex before they answer (see proxyFailure).
   */
  async function proxyToOrigin(url: URL, env: Env): Promise<Response> {
    const target = new URL(url.pathname + url.search, config.origin.base_url);
    const secretHeaders: Record<string, string> = {};
    if (env.CF_WEBMCP_DEPLOY_TOKEN) {
      secretHeaders["cf-webmcp-bypass"] = "1";
      secretHeaders["cf-webmcp-deploy-token"] = env.CF_WEBMCP_DEPLOY_TOKEN;
    }
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), PROXY_ORIGIN_TIMEOUT_MS);
    try {
      const result = await fetchWithManualRedirects(
        target,
        { method: "GET" },
        {
          allowedOrigins: config.origin.allowed_origins,
          headers: { "user-agent": "cf-webmcp/1.0" },
          secretHeaders,
          signal: deadline.signal,
        },
      );
      return result.ok ? result.response : proxyFailure(target, result.failure);
    } catch (e) {
      if (isAbortError(e)) return plainError(504, "origin did not answer in time");
      console.error(
        `cf-webmcp: proxy origin fetch failed: ${JSON.stringify({
          start: target.origin + target.pathname,
          error: (e as Error | null)?.message ?? String(e),
        })}`,
      );
      return plainError(502, "origin request failed");
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The answer for a redirect proxyToOrigin refused or could not follow.
   *
   * An origin that redirects to a host outside allowed_origins (typically apex to
   * www, or back) gets its redirect relayed as it was: same status, Location resolved
   * to an absolute URL, no body. Nothing is requested at the target and no token goes
   * with it. This keeps a crawler's robots.txt fetch from turning into a 5xx, which
   * Google reads as disallow-all. no-store because the relay is our decision about
   * an allow-list, not a statement by the origin.
   *
   * Everything else is a 502 with a fixed message. The refused value goes to the log,
   * never to the client: a host can be an internal name and a Location can carry a query.
   *
   * Every response here carries noindex, because most callers serve under
   * /.well-known/*. The two apex discovery files, llms.txt and robots.txt, must never
   * carry X-Robots-Tag: their route handlers drop the header from whatever they pass
   * on (see src/robots-tag.ts), so a relay or a 502 from them has none.
   */
  function proxyFailure(start: URL, failure: RedirectFailure): Response {
    if (failure.kind === "off_list" && failure.redirected) {
      return new Response(null, {
        status: failure.status,
        headers: { location: failure.target, "cache-control": "no-store", "x-robots-tag": "noindex" },
      });
    }
    logRedirectFailure("proxy", start, failure);
    switch (failure.kind) {
      case "off_list":
        return plainError(502, "configured origin is not in allowed_origins");
      case "unsupported_scheme":
        return plainError(
          502,
          failure.redirected ? "origin returned an unusable redirect location" : "configured origin is not an http or https URL",
        );
      case "too_many_redirects":
        return plainError(502, "origin redirected too many times");
      case "malformed_location":
        return plainError(502, "origin returned an unusable redirect location");
    }
  }

  function plainError(status: number, message: string): Response {
    return new Response(message, {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
    });
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

    // Origin-Trial tokens go on the top-level HTML document, so they follow the status and
    // content type of what origin sent, not whether this response is injected below:
    // inject_html off, an excluded path, a non-UTF-8 charset or a bare fragment all still
    // get them. A 304 answering an HTML navigation gets them too: Chrome merges a 304's
    // headers into the page it cached, so without them a cached copy that predates the first
    // deploy, or holds a rotated-out token, would keep its old state for as long as origin
    // keeps answering 304.
    const trial = isHtmlDocument(upstream) || (upstream.status === 304 && isHtmlNavigation(request));

    // The Link header is discovery data, independent of body injection: it goes
    // on every proxied response, including when inject_html is off.
    if (!config.features.inject_html || !shouldInject(request, upstream, config)) {
      return withProxyHeaders(upstream, trial);
    }

    const base = config.site.public_url ?? `https://${config.site.domain}`;
    const manifestUrl = `${base}${config.manifest.path}`;
    // Root-relative, unlike the discovery URLs around it: the script must load from whichever
    // host served the page (www, workers.dev, preview and staging hosts). An absolute URL to
    // the canonical host is cross-origin there, and crossorigin="anonymous" (SRI) needs a CORS
    // header the bootstrap route does not send. Discovery documents are read from outside the
    // page and stay absolute.
    const bootstrapUrl = `${config.paths.namespace}/${meta.BOOTSTRAP_ASSET}`;
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
    // safeInject fails open on synchronous rewriter errors. No
    // ctx.passThroughOnException() on top of it: that forwards to the zone's
    // origin, not [origin].base_url, and is a no-op on Custom Domains and
    // workers.dev.
    const injected = safeInject(upstream, {
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
    return withProxyHeaders(injected, trial);
  }

  /**
   * The headers cf-webmcp adds to a proxied response: the Link header (unless
   * [features].link_header is off) and, when `trial` is set, one Origin-Trial header
   * per [origin_trial].tokens entry.
   */
  function withProxyHeaders(response: Response, trial: boolean): Response {
    const addLink = config.features.link_header;
    const addTrial = trial && config.origin_trial.tokens.length > 0;
    if (!addLink && !addTrial) return response;
    // A WebSocket upgrade must be returned as the very object origin gave us:
    // its `webSocket` cannot be carried into a new Response, and rewrapping a 101
    // throws ("Responses may only be constructed with status codes in the range
    // 200 to 599"). Same for any status outside the constructible range.
    if (response.webSocket || response.status < 200 || response.status > 599) return response;
    const headers = new Headers(response.headers);
    if (addLink) headers.set("link", mergeLinkHeader(headers.get("link"), buildLinkHeader(config)));
    if (addTrial) appendOriginTrialHeaders(headers, config.origin_trial.tokens);
    return new Response(response.body, { status: response.status, headers });
  }
}

/**
 * A request a browser makes to load a page: GET or HEAD, and either Sec-Fetch-Dest says
 * document, iframe or frame, or Accept names text/html. Only used to tell the 304s that
 * revalidate an HTML page from those that revalidate an image, a stylesheet or a script.
 */
function isHtmlNavigation(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const dest = (request.headers.get("sec-fetch-dest") ?? "").trim().toLowerCase();
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  return /text\/html/i.test(request.headers.get("accept") ?? "");
}

/**
 * A 200 whose content type is text/html, parameters allowed. Stricter than the injection
 * check on purpose: no 3xx, 304, 4xx or 5xx, and not text/html-something.
 */
function isHtmlDocument(response: Response): boolean {
  return response.status === 200 && /^text\/html\s*(;|$)/i.test(response.headers.get("content-type") ?? "");
}
