import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

export function landingResponse(
  landingHtml: string,
  config: Config,
  configHash: string,
): Response {
  return new Response(landingHtml, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.landing_max_age,
        s_maxage: config.cache.landing_s_maxage,
        swr: config.cache.landing_swr,
        sie: config.cache.landing_sie,
      }),
      etag: `"${configHash}"`,
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
      // Pairing UI takes a sensitive token; deny framing to prevent clickjacking.
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
}

export function landingRedirect(toPath: string): Response {
  return new Response(null, {
    status: 308,
    headers: { location: toPath },
  });
}
