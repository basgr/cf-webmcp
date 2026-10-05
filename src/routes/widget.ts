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

export async function widgetResponse(
  request: Request,
  config: Config,
  bucket: R2Bucket,
  widgetAsset: string,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "GET, HEAD", "x-robots-tag": "noindex" },
    });
  }

  const object = await bucket.get(widgetAsset);
  if (!object) {
    return new Response("widget asset not found on origin bucket", {
      status: 503,
      headers: { "x-robots-tag": "noindex" },
    });
  }

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
