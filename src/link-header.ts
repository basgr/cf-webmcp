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
  return entries.join(", ");
}

/**
 * Merge our Link header value with any existing one on the origin response.
 * Preserves origin's entries by concatenation (RFC 8288 allows multiple).
 */
export function mergeLinkHeader(existing: string | null, ours: string): string {
  return existing ? `${existing}, ${ours}` : ours;
}
