/**
 * GET /<namespace>/widget.<hash>.js
 *
 * Serves the vendored jasonjmcghee/WebMCP widget from R2 exactly as stored. The
 * stored object is the MIT license preamble (src/widget-preamble.ts) followed by
 * the pinned webmcp.js bytes, composed, verified and uploaded by
 * `npm run upload-widget` under the key widget.<first 16 hex of served_sha256>.js
 * (both values come from vendor/webmcp/current.json). The Worker does not
 * transform the body, so the `integrity` hash on the landing page's <script>
 * tag (`served_sri`) covers exactly the bytes a browser receives.
 *
 * Always upload with `npm run upload-widget`. A raw `wrangler r2 object put` of
 * the plain webmcp.js is missing the preamble, so its hash differs from
 * `served_sri` and browsers block the script with an SRI mismatch.
 *
 * Immutable caching is safe because the URL is content-addressed: any change to
 * the widget bytes or the preamble changes the key.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

/**
 * 503 for a widget the Worker cannot read: no-store, so neither a browser nor the edge keeps the
 * failure under a URL that is otherwise cached for a year, and noindex like every namespace route.
 */
function unavailable(message: string): Response {
  return new Response(message, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" },
  });
}

/**
 * `bucket` is the CF_WEBMCP_ASSETS binding, undefined when wrangler.toml does not bind it. A
 * missing binding, a failed R2 read and a missing object all answer 503 (never an uncaught
 * error, which the platform answers with its own 500 page and no noindex). The first two are
 * logged; the body names neither.
 */
export async function widgetResponse(
  request: Request,
  config: Config,
  bucket: R2Bucket | undefined,
  widgetAsset: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD", "x-robots-tag": "noindex" },
    });
  }

  if (!bucket) {
    console.error("cf-webmcp: widget: the CF_WEBMCP_ASSETS R2 binding is missing; bind the bucket in wrangler.toml");
    return unavailable("widget storage unavailable");
  }
  let object: R2ObjectBody | null;
  try {
    object = await bucket.get(widgetAsset);
  } catch (e) {
    console.error(`cf-webmcp: widget: R2 read failed: ${JSON.stringify({ key: widgetAsset, error: (e as Error | null)?.message ?? String(e) })}`);
    return unavailable("widget storage unavailable");
  }
  if (!object) return unavailable("widget asset not found on origin bucket");

  const cc = `${buildCacheControl({ max_age: config.cache.widget_max_age })}, immutable`;
  const headers = new Headers();
  headers.set("content-type", "application/javascript; charset=utf-8");
  headers.set("cache-control", cc);
  headers.set("x-robots-tag", "noindex");
  headers.set("x-content-type-options", "nosniff");
  if (object.httpEtag) headers.set("etag", object.httpEtag);

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}
