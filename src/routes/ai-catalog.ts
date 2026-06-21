/**
 * GET /.well-known/ai-catalog.json handler (ARD Publisher Catalog).
 *
 * Serves the Agentic Resource Discovery (ARD) catalog for AI agents.
 * Modes:
 *   - synthesize: emit catalog from TOML only (AI_CATALOG_JSON generated asset)
 *   - merge:      fetch origin's catalog and merge (added in T4)
 *   - passthrough: route not registered (handled at router/feature toggle)
 *
 * No replace mode: unlike api-catalog, ai-catalog has no equivalent concept
 * since the entire document is synthesized from config.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

export async function aiCatalogResponse(
  _request: Request,
  config: Config,
  synthesizedBody: string,
  _proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  // merge mode added in T4; synthesize serves synthesizedBody as-is.
  // modes: synthesize | merge | passthrough (no replace mode for ai_catalog)
  const body = synthesizedBody;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/ai-catalog+json",
      "access-control-allow-origin": "*",
      "cache-control": buildCacheControl({
        max_age: config.cache.ai_catalog_max_age,
        s_maxage: config.cache.ai_catalog_s_maxage,
        swr: config.cache.ai_catalog_swr,
        sie: config.cache.ai_catalog_sie,
      }),
      "x-content-type-options": "nosniff",
      // Agent-discovery surface served under /.well-known/, not search-engine
      // content. See docs/scope.md and the x-robots coverage test.
      "x-robots-tag": "noindex",
    },
  });
}
