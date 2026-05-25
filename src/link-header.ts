/**
 * Build the value of the HTTP `Link` header advertising cf-webmcp's
 * discovery surfaces. RFC 8288 format, comma-separated entries.
 *
 * Always advertises the WebMCP manifest as rel="webmcp" (our private rel,
 * matches the `<link rel="webmcp">` injected into HTML).
 *
 * When the api_catalog feature is enabled and not in passthrough mode,
 * additionally advertises rel="api-catalog" (IANA-registered, RFC 9727)
 * so generic crawlers that scan for standard rels can find the catalog.
 */

import type { Config } from "./config-types";

export function buildLinkHeader(config: Config): string {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const entries: string[] = [`<${base}${config.manifest.path}>; rel="webmcp"`];
  if (config.features.api_catalog && config.api_catalog.mode !== "passthrough") {
    entries.push(`<${base}${config.api_catalog.path}>; rel="api-catalog"`);
  }
  if (config.features.agent_skills && config.agent_skills.mode !== "passthrough") {
    // Not (yet) IANA-registered; matches the convention used in Anthropic's
    // Agent Skills format. Same pattern as our existing private rel="webmcp".
    entries.push(`<${base}${config.agent_skills.path}>; rel="agent-skills"`);
  }
  if (config.features.llms_txt && config.llms_txt.mode !== "passthrough") {
    // IANA-registered general "describedby" relation (RFC 8288). Points at
    // /llms.txt - a publisher description in markdown. Generic agent-aware
    // scanners that anchor on registered rel-types only (not our private
    // rel="webmcp") find a description of the site through this entry.
    entries.push(`<${base}${config.llms_txt.path}>; rel="describedby"; type="text/markdown"`);
  }
  return entries.join(", ");
}

/**
 * Merge our Link header value with any existing one on the origin response.
 * Preserves origin's entries by concatenation (RFC 8288 allows multiple).
 */
export function mergeLinkHeader(existing: string | null, ours: string): string {
  return existing ? `${existing}, ${ours}` : ours;
}
