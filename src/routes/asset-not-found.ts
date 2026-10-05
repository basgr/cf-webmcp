/**
 * 404 for a stale or unknown content-addressed asset URL under the namespace
 * (`/_webmcp/bootstrap.<x>.js`, `/_webmcp/widget.<x>.js`).
 *
 * Never cached (`no-store`): a stale URL must not be pinned by an intermediary
 * as a 404, and a URL that 404s today can become a current asset on a later
 * deploy. Never proxied to origin: the namespace belongs to cf-webmcp.
 */
export function assetNotFoundResponse(): Response {
  return new Response("asset not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
