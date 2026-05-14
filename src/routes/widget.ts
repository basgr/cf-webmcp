/**
 * GET /<namespace>/widget.<hash>.js
 *
 * Serves the vendored jasonjmcghee/WebMCP widget from R2. The file is uploaded
 * to the bucket at deploy time by the build pipeline (scripts/upload-widget.ts,
 * not in v1; for now the operator runs `wrangler r2 object put` once per pin).
 *
 * Response is served with `immutable` caching because the URL contains the
 * content hash. MIT LICENSE notice is prepended as a leading comment so the
 * obligation travels with the file.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

const LICENSE_PREAMBLE = `/*!
 * jasonjmcghee/WebMCP - MIT License
 * https://github.com/jasonjmcghee/WebMCP/blob/main/LICENSE
 *
 * Pinned and served by cf-webmcp.
 */
`;

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

  // Prepend the MIT preamble as a stream so we do not buffer the whole asset.
  const encoder = new TextEncoder();
  const preamble = encoder.encode(LICENSE_PREAMBLE);
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(preamble);
      const reader = object.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) controller.enqueue(value);
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers });
}
