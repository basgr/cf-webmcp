/**
 * /llms.txt and /robots.txt are the apex discovery files. Every route under
 * /_webmcp/* or /.well-known/* emits `X-Robots-Tag: noindex`; these two are the
 * explicit exceptions and never carry the header, whatever they answer.
 *
 * proxyToOrigin marks its own relays and failures (a relayed redirect, a 502, a
 * 504) noindex, because most routes that use it live under /.well-known/. The
 * llms.txt and robots.txt routes pass such an answer on when they cannot merge
 * one, so they drop the header from it here. An X-Robots-Tag the origin sent
 * itself goes with it: these two routes never carry one.
 */
export function withoutRobotsTag(res: Response): Response {
  if (!res.headers.has("x-robots-tag")) return res;
  const headers = new Headers(res.headers);
  headers.delete("x-robots-tag");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
