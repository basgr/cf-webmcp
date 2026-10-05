/**
 * 404 for any path under the namespace (`/_webmcp/...`) that is not one of
 * cf-webmcp's own routes: a typo, an exec path with an invalid tool name, a
 * removed asset. The namespace belongs to cf-webmcp, so these are never proxied
 * to origin (origin would answer with its own 404 page, or worse, with content).
 *
 * Same headers as assetNotFoundResponse: never cached (a path that 404s today
 * can become a real route on a later deploy), never indexed.
 */
export function namespaceNotFoundResponse(): Response {
  return new Response("not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
