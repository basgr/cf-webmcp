import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

export function bootstrapResponse(bootstrapJs: string, config: Config): Response {
  return new Response(bootstrapJs, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": `${buildCacheControl({ max_age: config.cache.bootstrap_max_age })}, immutable`,
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
