/**
 * Build the value of the HTTP `Link` header advertising cf-webmcp's
 * discovery surfaces. RFC 8288 format, comma-separated entries.
 *
 * Advertises the WebMCP manifest as rel="webmcp" (our private rel, matches the
 * `<link rel="webmcp">` injected into HTML) while [features].manifest is on. With
 * the manifest off there is no document to point at, so there is no entry.
 *
 * When the API catalog is served (feature on, not passthrough, manifest on: see
 * src/served.ts), additionally advertises rel="api-catalog" (IANA-registered, RFC 9727)
 * so generic crawlers that scan for standard rels can find the catalog.
 *
 * Each entry carries an optional `title="..."` parameter (RFC 8288 sec 3.4.1),
 * human-readable metadata for the link target. No protocol impact: parsers
 * that don't care simply ignore it. The describedby title matches the
 * wording used by specification.website (Joost de Valk) for the same target,
 * for free interop with peer publishers.
 */

import type { Config } from "./config-types";
import { ARD_REL } from "./ard";
import { apiCatalogServed } from "./served";

/**
 * The header value, or "" when no document is advertised at all (the manifest off and
 * every other entry off or left to origin): the caller then sets no Link header.
 */
export function buildLinkHeader(config: Config): string {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const entries: string[] = [];
  if (config.features.manifest) {
    entries.push(`<${base}${config.manifest.path}>; rel="webmcp"; title="WebMCP tool catalogue"`);
  }
  if (apiCatalogServed(config)) {
    entries.push(
      `<${base}${config.api_catalog.path}>; rel="api-catalog"; title="API catalogue (RFC 9727 Linkset)"`,
    );
  }
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    // ARD v0.91 section 5.1: consumers MUST honour rel="ard". The predecessor
    // rel="ai-catalog" is not emitted; publishers are told to move off it.
    entries.push(
      `<${base}${config.ai_catalog.path}>; rel="${ARD_REL}"; title="AI agent catalog (ARD)"`,
    );
  }
  if (config.features.agent_skills && config.agent_skills.mode !== "passthrough") {
    // Not (yet) IANA-registered; matches the convention used in Anthropic's
    // Agent Skills format. Same pattern as our existing private rel="webmcp".
    entries.push(
      `<${base}${config.agent_skills.path}>; rel="agent-skills"; title="Agent Skill (SKILL.md)"`,
    );
  }
  if (config.features.llms_txt && config.llms_txt.mode !== "passthrough") {
    // IANA-registered general "describedby" relation (RFC 8288). Points at
    // /llms.txt - a publisher description in markdown. Generic agent-aware
    // scanners that anchor on registered rel-types only (not our private
    // rel="webmcp") find a description of the site through this entry.
    entries.push(
      `<${base}${config.llms_txt.path}>; rel="describedby"; type="text/markdown"; title="Site index for LLMs"`,
    );
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
