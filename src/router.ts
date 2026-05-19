/**
 * Tiny router. Matches request path against a configured route table.
 * No params (we extract the tool_name segment manually in exec.ts).
 */

import type { Config } from "./config-types";

export interface RouteMatch {
  kind:
    | "manifest"
    | "landing"
    | "landing_redirect"
    | "bootstrap"
    | "widget"
    | "exec"
    | "health"
    | "llms_txt"
    | "robots_txt"
    | "agents_md"
    | "agents_md_redirect"
    | "api_catalog"
    | "agent_skills"
    | "agent_skills_redirect"
    | "agent_skills_index"
    | "proxy";
  /** Only set for exec routes. */
  toolName?: string;
}

export function matchRoute(config: Config, url: URL, bootstrapAsset: string, widgetAsset: string): RouteMatch {
  const pathname = url.pathname;
  const ns = config.paths.namespace;

  // Manifest
  if (config.features.manifest && pathname === config.manifest.path) {
    return { kind: "manifest" };
  }

  // Landing with directory semantics: redirect "/foo" → "/foo/"
  const landingPath = config.webmcp_landing.path;
  if (config.features.webmcp_landing) {
    if (pathname === landingPath) return { kind: "landing" };
    if (landingPath.endsWith("/") && pathname === landingPath.slice(0, -1)) {
      return { kind: "landing_redirect" };
    }
  }

  // Bootstrap
  if (pathname === `${ns}/${bootstrapAsset}`) {
    return { kind: "bootstrap" };
  }

  // Widget
  if (config.features.fallback_widget && pathname === `${ns}/${widgetAsset}`) {
    return { kind: "widget" };
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
