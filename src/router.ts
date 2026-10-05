/**
 * Tiny router. Matches request path against a configured route table.
 * No params (we extract the tool_name segment manually in exec.ts).
 */

import type { Config } from "./config-types";

export interface RouteMatch {
  kind:
    | "manifest"
    | "manifest_redirect"
    | "landing"
    | "landing_redirect"
    | "bootstrap"
    | "widget"
    | "asset_not_found"
    | "exec"
    | "health"
    | "llms_txt"
    | "robots_txt"
    | "agents_md"
    | "agents_md_redirect"
    | "api_catalog"
    | "ards_catalog"
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
 * `widgetAsset` is null when this build ships no widget (feature pin missing).
 * A request for any other `bootstrap.<x>.js` / `widget.<x>.js` under the
 * namespace is a stale or unknown asset URL: it gets `asset_not_found` and is
 * never proxied to origin.
 */
export function matchRoute(
  config: Config,
  url: URL,
  bootstrapAsset: string,
  widgetAsset: string | null,
): RouteMatch {
  const pathname = url.pathname;
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

  // Landing with directory semantics: redirect "/foo" → "/foo/"
  const landingPath = config.webmcp_landing.path;
  if (config.features.webmcp_landing) {
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
    if (config.features.fallback_widget && widgetAsset !== null && name === widgetAsset) {
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

  // llms.txt
  if (config.features.llms_txt && pathname === config.llms_txt.path) {
    return { kind: "llms_txt" };
  }

  // robots.txt
  if (config.features.robots_txt && pathname === config.robots_txt.path) {
    return { kind: "robots_txt" };
  }

  // agents.md (canonical) plus 301-aliases
  if (config.features.agents_md) {
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

  // ARD Publisher Catalog (ai-catalog.json)
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    if (pathname === config.ai_catalog.path) return { kind: "ards_catalog" };
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

  return { kind: "proxy" };
}
