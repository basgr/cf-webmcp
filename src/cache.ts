/**
 * Thin wrapper around the Cloudflare Cache API. The default cache works on GET
 * URLs. For POST executor calls we build a synthetic GET cache key derived from
 * `version + config_hash + tool_name + sha256(body)` so semantically-identical calls
 * share cache, and a deploy that changes the config (a tool's executor, its URL
 * template, its projection) or the executor code (a cf-webmcp upgrade) never answers
 * from a result the previous deploy produced.
 */

export interface CacheKey {
  toolName: string;
  bodyText: string;
}

/** What makes one deploy's cached results unusable for another. */
export interface CacheScope {
  /** cf-webmcp's version (CF_WEBMCP_VERSION). */
  version: string;
  /** CONFIG_HASH. */
  configHash: string;
}

export async function makeCacheKey(domain: string, scope: CacheScope, key: CacheKey): Promise<Request> {
  const hash = await sha256Hex(key.bodyText);
  const segments = [scope.version, scope.configHash, key.toolName].map(encodeURIComponent).join("/");
  return new Request(`https://${domain}/__webmcp-cache/${segments}/${hash}`, { method: "GET" });
}

export function buildCacheControl(opts: {
  max_age?: number;
  s_maxage?: number;
  swr?: number;
  sie?: number;
}): string {
  const parts: string[] = ["public"];
  if (opts.max_age !== undefined) parts.push(`max-age=${opts.max_age}`);
  if (opts.s_maxage !== undefined) parts.push(`s-maxage=${opts.s_maxage}`);
  if (opts.swr !== undefined) parts.push(`stale-while-revalidate=${opts.swr}`);
  if (opts.sie !== undefined) parts.push(`stale-if-error=${opts.sie}`);
  return parts.join(", ");
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
