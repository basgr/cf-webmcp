import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

/**
 * Return the static manifest body generated at build time. The body is passed
 * in by the Worker (read from src/generated/manifest.json).
 */
export function manifestResponse(
  manifestJson: string,
  config: Config,
  configHash: string,
): Response {
  return new Response(manifestJson, {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.manifest_max_age,
        s_maxage: config.cache.manifest_s_maxage,
        swr: config.cache.manifest_swr,
        sie: config.cache.manifest_sie,
      }),
      etag: `"${configHash}"`,
      // Discovery for agents, not indexing for humans.
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * 301 from a manifest alias (e.g. the legacy `/.well-known/webmcp.json`) to the
 * canonical `config.manifest.path`. Emits X-Robots-Tag: noindex because the
 * alias lives under `/.well-known/*`.
 */
export function manifestRedirect(config: Config): Response {
  return new Response(null, {
    status: 301,
    headers: {
      location: config.manifest.path,
      "cache-control": buildCacheControl({
        max_age: config.cache.manifest_max_age,
        s_maxage: config.cache.manifest_s_maxage,
        swr: config.cache.manifest_swr,
        sie: config.cache.manifest_sie,
      }),
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
