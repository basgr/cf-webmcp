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
import { agentsMdResponse, agentsMdRedirect, healthAnswersWithoutToken } from "./routes/agents-md";
import { apiCatalogResponse } from "./routes/api-catalog";
import { aiCatalogResponse, ardRedirect } from "./routes/ai-catalog";
import { agentSkillsResponse, agentSkillsRedirect } from "./routes/agent-skills";
import { agentSkillsIndexResponse } from "./routes/agent-skills-index";
import { buildLinkHeader, mergeLinkHeader } from "./link-header";
import { appendOriginTrialHeaders } from "./origin-trial";
import { configLinkOptions, formsForPath, isExcludedPath, safeInject, shouldInject } from "./injection/html-rewriter";
import { fetchWithManualRedirects, isAbortError, logRedirectFailure, type RedirectFailure } from "./safe-fetch";
import { widgetEnabled } from "./widget-state";
import { userAgent } from "./user-agent";

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
  /** Hash of the config alone: /_webmcp/health, the preflight staleness check and the exec cache key. Not an ETag. */
  CONFIG_HASH: string;
  /** cf-webmcp's version from package.json, for the exec cache key. */
  CF_WEBMCP_VERSION: string;
  /** Strong ETags of the bodies served from this build: "<sha256(body) first 16 hex>", quotes included. */
  MANIFEST_ETAG: string;
  LANDING_ETAG: string;
  /** Of the synthesized ARD manifest (AI_CATALOG_JSON). A merged one is hashed per request. */
  ARD_ETAG: string;
  /**
   * 16 hex over everything that shapes the injected HTML (scripts/build-config.ts
   * injectionHashOf). Appended to origin's ETag on every rewritten page, so a deploy
   * that changes the injection makes every cached rewritten page fail revalidation.
   */
  INJECTION_HASH: string;
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
  // The one answer to "is the widget on", for every sentence that tells a reader to pair on the
  // landing page. The same expression decides the widget route (router.ts) and, at build time,
  // the landing's pairing block and the skills index digest (scripts/build-config.ts).
  const widget = widgetEnabled(config, meta.WIDGET_ASSET);

  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const match = matchRoute(config, request, meta.BOOTSTRAP_ASSET, meta.WIDGET_ASSET);

      switch (match.kind) {
        case "manifest":
          return handleHeadable(request, manifestResponse(assets.manifestJson, config, meta.MANIFEST_ETAG));
        case "manifest_redirect":
          return manifestRedirect(config);
        case "landing":
          return handleHeadable(request, landingResponse(assets.landingHtml, config, meta.LANDING_ETAG));
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
            {
              domain: config.site.domain,
              deployToken: env.CF_WEBMCP_DEPLOY_TOKEN ?? "",
              configHash: meta.CONFIG_HASH,
              version: meta.CF_WEBMCP_VERSION,
            },
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
          return llmsTxtResponse(request, config, (u) => proxyToOrigin(u, env), meta.LLMS_TXT_TOKEN_HINTS, widget);
        case "robots_txt":
          return robotsTxtResponse(request, config, (u) => proxyToOrigin(u, env));
        case "agents_md":
          return agentsMdResponse(
            request,
            config,
            (u) => proxyToOrigin(u, env),
            widget,
            healthAnswersWithoutToken(config, env.CF_WEBMCP_HEALTH_TOKEN),
          );
        case "agents_md_redirect":
          return agentsMdRedirect(config);
        case "api_catalog":
          return apiCatalogResponse(request, config, (u) => proxyToOrigin(u, env));
        case "ards_catalog":
          return aiCatalogResponse(request, config, assets.aiCatalogJson, (u) => proxyToOrigin(u, env), meta.ARD_ETAG);
        case "ards_catalog_redirect":
          return ardRedirect(config);
        case "agent_skills":
          return agentSkillsResponse(request, config, (u) => proxyToOrigin(u, env), widget);
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
          headers: { "user-agent": userAgent(meta.CF_WEBMCP_VERSION) },
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
    const suffix = `-${meta.INJECTION_HASH}`;

    // A rewritten page carries origin's ETag with `suffix` inside the quotes (see
    // rewrittenValidators). Origin knows only its own tag, so the suffix comes off before
    // the request goes there (rule a, any request). A request that asks for HTML on a path
    // the rewriter runs on must not be answered 304 for a copy rewritten by another build:
    // origin's page may be unchanged while the injection changed, and the old copy points
    // at a bootstrap URL that now answers 404. So such a request keeps If-None-Match only
    // when every entry carries the current suffix, and never sends If-Modified-Since
    // (rule b). Everything else (images, CSS, scripts, JSON) keeps its validators.
    //
    // Rule b is decided before the response exists, so it also applies to an HTML request
    // whose answer will not be rewritten after all (a non-UTF-8 page, a non-200, a
    // non-HTML answer). That is safe: those requests lose only their 304, and origin sends
    // the full page instead. The cost is bandwidth on such pages, never a stale page.
    const rewritable = config.features.inject_html && !isExcludedPath(config, reqUrl.pathname);
    const validators = forwardedValidators(request, suffix, rewritable && acceptsHtml(request));

    // redirect:"manual" - pass any 3xx response back to the visitor's browser
    // unchanged instead of auto-following. Auto-following would mean the worker
    // injects the bootstrapper into the FINAL response, even if origin redirected
    // off-host. The visitor's browser handles redirect chains natively; we just
    // relay them.
    const forwarded = validators.headers
      ? new Request(request, { redirect: "manual", headers: validators.headers })
      : new Request(request, { redirect: "manual" });
    const upstream = await fetch(target.toString(), forwarded);

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
      // A 304 for a request that carried tags rule a stripped loses Last-Modified, and
      // when it revalidates one of those copies its ETag gets the suffix back, so the
      // browser keeps the suffixed validator (resuffixNotModified). Any other response
      // keeps origin's validators untouched.
      const resuffix =
        upstream.status === 304 && validators.stripped.size > 0
          ? (headers: Headers) => resuffixNotModified(headers, validators.stripped, suffix)
          : undefined;
      return withProxyHeaders(upstream, trial, resuffix);
    }

    // On the origin of this request, unlike the discovery URLs around it, which name the
    // configured site URL. The script must load from whichever host the visitor used (www,
    // workers.dev, preview and staging hosts): an absolute URL to the canonical host is
    // cross-origin there, and crossorigin="anonymous" (SRI) needs a CORS header the bootstrap
    // route does not send. A root-relative URL would follow a <base href> in the page to
    // another host; naming the host does not. Discovery documents are read from outside the
    // page and stay absolute.
    //
    // Every config and build value read here, and in shouldInject above, is an input of
    // INJECTION_HASH (injectionHashOf in scripts/build-config.ts): one that is not would
    // change the page without moving its ETag.
    const bootstrapUrl = `${reqUrl.origin}${config.paths.namespace}/${meta.BOOTSTRAP_ASSET}`;
    const bootstrapIntegrity = meta.BOOTSTRAP_SRI ?? undefined;
    const forms = formsForPath(config.forms, reqUrl.pathname);
    // safeInject fails open on synchronous rewriter errors. No
    // ctx.passThroughOnException() on top of it: that forwards to the zone's
    // origin, not [origin].base_url, and is a no-op on Custom Domains and
    // workers.dev.
    const injected = safeInject(upstream, {
      ...configLinkOptions(config),
      bootstrapUrl,
      bootstrapIntegrity,
      forms,
    });
    // When safeInject failed open it handed back origin's response itself: those bytes
    // are origin's, so they keep origin's validators. A HEAD (no body) is rewritten like
    // its GET and gets the same validators.
    const rewritten = injected.failedOpen ? undefined : (headers: Headers) => rewrittenValidators(headers, suffix);
    return withProxyHeaders(injected.response, trial, rewritten);
  }

  /**
   * The headers cf-webmcp adds to a proxied response: the Link header (unless
   * [features].link_header is off), when `trial` is set one Origin-Trial header per
   * [origin_trial].tokens entry, and whatever `editValidators` does to ETag and
   * Last-Modified. The three touch different headers, so their order does not matter.
   */
  function withProxyHeaders(response: Response, trial: boolean, editValidators?: (headers: Headers) => void): Response {
    // "" when [features].link_header is off or no document is left to advertise (the manifest
    // and every other entry off): then no Link header is added and origin's own stays as it is.
    const link = config.features.link_header ? buildLinkHeader(config) : "";
    const addLink = link !== "";
    const addTrial = trial && config.origin_trial.tokens.length > 0;
    if (!addLink && !addTrial && !editValidators) return response;
    // A WebSocket upgrade must be returned as the very object origin gave us:
    // its `webSocket` cannot be carried into a new Response, and rewrapping a 101
    // throws ("Responses may only be constructed with status codes in the range
    // 200 to 599"). Same for any status outside the constructible range.
    if (response.webSocket || response.status < 200 || response.status > 599) return response;
    const headers = new Headers(response.headers);
    if (addLink) headers.set("link", mergeLinkHeader(headers.get("link"), link));
    if (addTrial) appendOriginTrialHeaders(headers, config.origin_trial.tokens);
    editValidators?.(headers);
    return new Response(response.body, { status: response.status, headers });
  }
}

/** An entity tag (RFC 9110 section 8.8.3): weak or strong, and the opaque tag without its quotes. */
interface EntityTag {
  weak: boolean;
  opaque: string;
}

/** One entity tag as sent: W/ when weak, the opaque tag in double quotes. */
function formatEntityTag(tag: EntityTag): string {
  return `${tag.weak ? "W/" : ""}"${tag.opaque}"`;
}

/** etagc: any visible character but the double quote, and obs-text. Sticky, for the list parser. */
const ENTITY_TAG_RE = /(W\/)?"([\x21\x23-\x7E\x80-\xFF]*)"/y;
const SINGLE_ENTITY_TAG_RE = /^(W\/)?"([\x21\x23-\x7E\x80-\xFF]*)"$/;

/** A single entity tag (an ETag header value), or null when it is not one. */
function parseEntityTag(value: string): EntityTag | null {
  const m = SINGLE_ENTITY_TAG_RE.exec(value.trim());
  return m ? { weak: m[1] !== undefined, opaque: m[2]! } : null;
}

/** A comma-separated list of entity tags (an If-None-Match value other than *), or null when it does not parse. */
function parseEntityTagList(value: string): EntityTag[] | null {
  const tags: EntityTag[] = [];
  let i = 0;
  for (;;) {
    // Whitespace and empty list elements.
    while (i < value.length && (value[i] === " " || value[i] === "\t" || value[i] === ",")) i++;
    if (i >= value.length) break;
    ENTITY_TAG_RE.lastIndex = i;
    const m = ENTITY_TAG_RE.exec(value);
    if (!m) return null;
    tags.push({ weak: m[1] !== undefined, opaque: m[2]! });
    i = ENTITY_TAG_RE.lastIndex;
    while (i < value.length && (value[i] === " " || value[i] === "\t")) i++;
    if (i < value.length && value[i] !== ",") return null;
  }
  return tags.length > 0 ? tags : null;
}

interface ForwardedValidators {
  /** The request headers to send to origin instead of the visitor's, or null to send them unchanged. */
  headers: Headers | null;
  /**
   * Origin's opaque tags of the If-None-Match entries that carried the current suffix
   * and went to origin without it. A 304 for one of them revalidates a copy this build
   * rewrote.
   */
  stripped: Set<string>;
}

/** An entity-tag list with the current suffix taken off every entry that carries it. */
function stripSuffix(tags: EntityTag[], suffix: string): { sent: EntityTag[]; stripped: string[]; unsuffixed: number } {
  const stripped: string[] = [];
  let unsuffixed = 0;
  const sent = tags.map((tag) => {
    if (!tag.opaque.endsWith(suffix)) {
      unsuffixed++;
      return tag;
    }
    const own = { weak: tag.weak, opaque: tag.opaque.slice(0, -suffix.length) };
    stripped.push(own.opaque);
    return own;
  });
  return { sent, stripped, unsuffixed };
}

/** An If-None-Match or If-Match value as entity tags; null for "*" and for a value that does not parse. */
function conditionTags(value: string): EntityTag[] | null {
  return value.trim() === "*" ? null : parseEntityTagList(value);
}

/**
 * The conditional headers to send to origin (rules a and b in proxyAndMaybeInject).
 * `htmlRequest` turns on rule b: the request asks for HTML on a path the rewriter runs on.
 *
 * If-Match gets rule a too: a conditional PUT or DELETE that carries a tag taken from a
 * rewritten GET reaches origin with origin's own tag. Only the current suffix comes off;
 * a tag from an older build goes as sent and fails the precondition at origin, and rule b
 * never touches If-Match. If-Range is left alone: a suffixed tag there never matches
 * origin's, so origin answers in full, which is right for a copy whose bytes origin never
 * sent.
 */
function forwardedValidators(request: Request, suffix: string, htmlRequest: boolean): ForwardedValidators {
  const ifNoneMatch = request.headers.get("if-none-match");
  const ifMatch = request.headers.get("if-match");
  const dropDate = htmlRequest && request.headers.has("if-modified-since");
  if (ifNoneMatch === null && ifMatch === null && !dropDate) return { headers: null, stripped: new Set() };

  const headers = new Headers(request.headers);
  let changed = false;
  // Rule b: the copy may predate the current injection, so origin must not judge it by date.
  if (dropDate) {
    headers.delete("if-modified-since");
    changed = true;
  }

  const matchTags = ifMatch === null ? null : conditionTags(ifMatch);
  if (matchTags !== null) {
    const { sent, stripped } = stripSuffix(matchTags, suffix);
    if (stripped.length > 0) {
      headers.set("if-match", sent.map(formatEntityTag).join(", "));
      changed = true;
    }
  }

  let stripped = new Set<string>();
  if (ifNoneMatch !== null) {
    // "*" matches any copy, also one from an older build. Unparseable: nothing can be stripped.
    const tags = conditionTags(ifNoneMatch);
    const result = tags === null ? null : stripSuffix(tags, suffix);
    if (htmlRequest && (result === null || result.unsuffixed > 0)) {
      // Rule b: an entry without the current suffix is a copy this build did not rewrite.
      // Nothing goes to origin, so no 304 can answer for a stripped entry either.
      headers.delete("if-none-match");
      changed = true;
    } else if (result !== null && result.stripped.length > 0) {
      headers.set("if-none-match", result.sent.map(formatEntityTag).join(", "));
      stripped = new Set(result.stripped);
      changed = true;
    }
  }
  return { headers: changed ? headers : null, stripped };
}

/**
 * The validators of a rewritten 200: origin's ETag with `suffix` added inside the quotes,
 * weak or strong as origin sent it, and no Last-Modified (a date cannot say which build
 * rewrote the copy). No ETag from origin means none here. An ETag that is not a valid
 * entity tag is dropped rather than suffixed: there is no way to know what origin meant.
 */
function rewrittenValidators(headers: Headers, suffix: string): void {
  headers.delete("last-modified");
  const etag = headers.get("etag");
  if (etag === null) return;
  const tag = parseEntityTag(etag);
  if (tag === null) headers.delete("etag");
  else headers.set("etag", formatEntityTag({ weak: tag.weak, opaque: tag.opaque + suffix }));
}

/**
 * A 304 for a request whose If-None-Match had entries rule a stripped. It loses
 * Last-Modified whatever it answers: the visitor holds at least one copy this build
 * rewrote, and a date must not become its validator (a 304 without the header leaves
 * the cached copy's own validators as they were). When its ETag is one of the stripped
 * tags, it revalidated such a copy, and the ETag gets the suffix back, weak or strong as
 * origin sent it. Any other ETag stays as origin sent it.
 */
function resuffixNotModified(headers: Headers, stripped: Set<string>, suffix: string): void {
  headers.delete("last-modified");
  const etag = headers.get("etag");
  const tag = etag === null ? null : parseEntityTag(etag);
  if (tag === null || !stripped.has(tag.opaque)) return;
  headers.set("etag", formatEntityTag({ weak: tag.weak, opaque: tag.opaque + suffix }));
}

/** A GET or HEAD whose Accept names text/html: a page load, as opposed to a subresource or an API fetch. */
function acceptsHtml(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return /text\/html/i.test(request.headers.get("accept") ?? "");
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
