import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { appendOriginTrialHeaders } from "../origin-trial";

/**
 * The landing page generated at build time, with its strong ETag: the build-time hash of
 * these exact bytes (LANDING_ETAG). The page names the content-addressed bootstrap and
 * widget and their SRI hashes, so a change to any of them moves the tag.
 */
export function landingResponse(
  landingHtml: string,
  config: Config,
  etag: string,
): Response {
  const response = new Response(landingHtml, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.landing_max_age,
        s_maxage: config.cache.landing_s_maxage,
        swr: config.cache.landing_swr,
        sie: config.cache.landing_sie,
      }),
      etag,
      // The router answers this path from Accept (text/event-stream goes to origin), so a
      // cache must key on it: a browser that cached this page must not answer a later
      // fetch with Accept: text/event-stream from it.
      vary: "accept",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
      // Pairing UI takes a sensitive token; deny framing to prevent clickjacking.
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
    },
  });
  // The landing is a top-level HTML document too, so it carries the origin-trial tokens
  // (its 308 redirect below does not).
  appendOriginTrialHeaders(response.headers, config.origin_trial.tokens);
  return response;
}

/**
 * The 308 from "/mcp" to "/mcp/". Like the page, it exists only for requests the router
 * gave to the landing, so it varies on Accept. no-store because a browser would
 * otherwise cache a 308 for good and send every later GET on this path, text/event-stream
 * ones included, to the page; the cost of never caching it is one cheap Worker answer.
 */
export function landingRedirect(toPath: string): Response {
  return new Response(null, {
    status: 308,
    headers: { location: toPath, "cache-control": "no-store", vary: "accept" },
  });
}
