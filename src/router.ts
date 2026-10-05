/**
 * Tiny router. Matches request path against a configured route table.
 * No params (we extract the tool_name segment manually in exec.ts).
 */

import type { Config } from "./config-types";
import { widgetEnabled } from "./widget-state";

export interface RouteMatch {
  kind:
    | "manifest"
    | "manifest_redirect"
    | "landing"
    | "landing_redirect"
    | "bootstrap"
    | "widget"
    | "asset_not_found"
    | "namespace_not_found"
    | "exec"
    | "health"
    | "llms_txt"
    | "robots_txt"
    | "agents_md"
    | "agents_md_redirect"
    | "api_catalog"
    | "ards_catalog"
    | "ards_catalog_redirect"
    | "agent_skills"
    | "agent_skills_redirect"
    | "agent_skills_index"
    | "proxy";
  /** Only set for exec routes. */
  toolName?: string;
}

/**
 * Content-addressed asset names under the namespace: `bootstrap.<x>.js` and
 * `widget.<x>.js`. <x> is a single path segment, so nested paths and the bare
 * `bootstrap.js` never match.
 */
const BOOTSTRAP_ASSET_NAME = /^bootstrap\.[^/]+\.js$/;
const WIDGET_ASSET_NAME = /^widget\.[^/]+\.js$/;

/**
 * Whether a request is for the landing page rather than for something that merely
 * shares its URL. The rule, in one sentence:
 *
 *   GET and HEAD requests get the landing page unless their Accept header asks for text/event-stream; every other method goes to origin.
 *
 * Why: Cloudflare WebMCP Labs injects a bridge with `data-mcp-url="/mcp"` and POSTs
 * JSON-RPC there, and an origin MCP server may sit at the same path. The MCP
 * streamable HTTP transport requires `text/event-stream` in the Accept header of its
 * GET, so that is the one GET left to origin. `application/json` alone is not: axios
 * sends `application/json, text/plain` plus a wildcard by default, and an agent that
 * follows the landing link advertised in llms.txt and the manifest must get the page,
 * not origin's 404.
 *
 * The match is a case-insensitive substring test, and any occurrence counts, a `q=0`
 * refusal included: a client that names the stream type is not asking for a page.
 */
function isLandingRequest(request: Request): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const accept = (request.headers.get("accept") ?? "").toLowerCase();
  return !accept.includes("text/event-stream");
}

/**
 * `widgetAsset` is null when this build ships no widget (feature pin missing).
 * A request for any other `bootstrap.<x>.js` / `widget.<x>.js` under the
 * namespace is a stale or unknown asset URL: it gets `asset_not_found` and is
 * never proxied to origin. Any other unknown path under `${namespace}/` gets
 * `namespace_not_found`, also never proxied.
 */
export function matchRoute(
  config: Config,
  request: Request,
  bootstrapAsset: string,
  widgetAsset: string | null,
): RouteMatch {
  const pathname = new URL(request.url).pathname;
  const ns = config.paths.namespace;

  // Manifest (canonical) plus 301-aliases (e.g. legacy /.well-known/webmcp.json).
  if (config.features.manifest) {
    if (pathname === config.manifest.path) {
      return { kind: "manifest" };
    }
    if (pathname !== config.manifest.path && config.manifest.aliases.includes(pathname)) {
      return { kind: "manifest_redirect" };
    }
  }

  // Landing with directory semantics: redirect "/foo" → "/foo/". The page and the
  // redirect follow one rule: GET and HEAD requests get the landing page unless their
  // Accept header asks for text/event-stream; every other method goes to origin
  // (see isLandingRequest).
  const landingPath = config.webmcp_landing.path;
  if (config.features.webmcp_landing && isLandingRequest(request)) {
    if (pathname === landingPath) return { kind: "landing" };
    if (landingPath.endsWith("/") && pathname === landingPath.slice(0, -1)) {
      return { kind: "landing_redirect" };
    }
  }

  // Content-addressed assets: the current bootstrap and widget serve; any other
  // name of the same shape is a stale URL (an old page still pointing at a
  // previous build, a cached HTML shell) and answers 404 rather than reaching origin.
  const assetPrefix = `${ns}/`;
  if (pathname.startsWith(assetPrefix)) {
    const name = pathname.slice(assetPrefix.length);
    if (name === bootstrapAsset) return { kind: "bootstrap" };
    if (widgetEnabled(config, widgetAsset) && name === widgetAsset) {
      return { kind: "widget" };
    }
    if (BOOTSTRAP_ASSET_NAME.test(name) || WIDGET_ASSET_NAME.test(name)) {
      return { kind: "asset_not_found" };
    }
  }

  // Exec
  const execPrefix = `${ns}/exec/`;
  if (pathname.startsWith(execPrefix)) {
    const toolName = pathname.slice(execPrefix.length);
    if (/^[a-z][a-z0-9_]*$/.test(toolName)) {
      return { kind: "exec", toolName };
    }
  }

  // Health
  if (pathname === `${ns}/health`) return { kind: "health" };

  // Passthrough means cf-webmcp does not serve the path: origin owns the file and
  // the request goes through the ordinary proxy, which relays origin's response and
  // adds only the Link header. That includes /.well-known/agents.md: the Worker adds
  // no X-Robots-Tag there, because the response is origin's, not ours (same as the
  // api_catalog, ai_catalog and agent_skills surfaces below).

  // llms.txt
  if (
    config.features.llms_txt &&
    config.llms_txt.mode !== "passthrough" &&
    pathname === config.llms_txt.path
  ) {
    return { kind: "llms_txt" };
  }

  // robots.txt
  if (
    config.features.robots_txt &&
    config.robots_txt.mode !== "passthrough" &&
    pathname === config.robots_txt.path
  ) {
    return { kind: "robots_txt" };
  }

  // agents.md (canonical) plus 301-aliases
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    if (pathname === config.agents_md.path) {
      return { kind: "agents_md" };
    }
    if (config.agents_md.aliases.includes(pathname)) {
      return { kind: "agents_md_redirect" };
    }
  }

  // RFC 9727 API Catalog
  if (
    config.features.api_catalog &&
    config.api_catalog.mode !== "passthrough" &&
    pathname === config.api_catalog.path
  ) {
    return { kind: "api_catalog" };
  }

  // ARD v0.91 manifest (ard.json) plus 301-aliases (the predecessor
  // ai-catalog.json by default). An alias equal to the path never gets here.
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    if (pathname === config.ai_catalog.path) return { kind: "ards_catalog" };
    if (config.ai_catalog.aliases.includes(pathname)) return { kind: "ards_catalog_redirect" };
  }

  // Anthropic-format Agent Skill (canonical SKILL.md plus 301 aliases)
  if (config.features.agent_skills && config.agent_skills.mode !== "passthrough") {
    if (pathname === config.agent_skills.path) {
      return { kind: "agent_skills" };
    }
    if (config.agent_skills.aliases.includes(pathname)) {
      return { kind: "agent_skills_redirect" };
    }
  }

  // Cloudflare Agent Skills Discovery RFC index file
  if (
    config.features.agent_skills_index &&
    config.agent_skills_index.mode !== "passthrough" &&
    pathname === config.agent_skills_index.path
  ) {
    return { kind: "agent_skills_index" };
  }

  // Everything else under the namespace (a typo, an exec path with an invalid
  // tool name) belongs to cf-webmcp and is never proxied to origin. Checked last
  // so a configured route that happens to live under the namespace still wins.
  if (pathname.startsWith(assetPrefix)) return { kind: "namespace_not_found" };

  return { kind: "proxy" };
}
