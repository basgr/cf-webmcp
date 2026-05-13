/**
 * Thin wrapper around the Cloudflare Cache API. The default cache works on GET
 * URLs. For POST executor calls we build a synthetic GET cache key derived from
 * `tool_name + sha256(body)` so semantically-identical calls share cache.
 */

export interface CacheKey {
  toolName: string;
  bodyText: string;
}

export async function makeCacheKey(domain: string, key: CacheKey): Promise<Request> {
  const hash = await sha256Hex(key.bodyText);
  const url = `https://${domain}/__webmcp-cache/${encodeURIComponent(key.toolName)}/${hash}`;
  return new Request(url, { method: "GET" });
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
