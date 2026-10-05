/**
 * The X-Robots-Tag rule for the two apex discovery files, /llms.txt and /robots.txt.
 *
 * Every route under /_webmcp/* (the configured namespace) or /.well-known/* emits
 * `X-Robots-Tag: noindex`. These two files are the explicit exception: at their usual
 * apex paths they never carry the header, whatever they answer.
 *
 * proxyToOrigin marks its own relays and failures (a relayed redirect, a 502, a 504)
 * noindex, because most routes that use it live under /.well-known/. The llms.txt and
 * robots.txt routes pass such an answer on when they cannot merge one, so they drop
 * the header from it. An X-Robots-Tag the origin sent itself goes with it.
 *
 * The exception belongs to the apex path, not to the route kind. A config can put either
 * file under a protected prefix; then the prefix rule wins and every answer carries noindex.
 */

import type { Config } from "./config-types";

/** Whether `path` lies under the namespace or /.well-known/, where every answer carries noindex. */
export function isProtectedPath(config: Config, path: string): boolean {
  return path.startsWith(`${config.paths.namespace}/`) || path.startsWith("/.well-known/");
}

function withoutRobotsTag(res: Response): Response {
  if (!res.headers.has("x-robots-tag")) return res;
  const headers = new Headers(res.headers);
  headers.delete("x-robots-tag");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function withNoindex(res: Response): Response {
  if (res.headers.get("x-robots-tag") === "noindex") return res;
  const headers = new Headers(res.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The final header policy for a response from the llms.txt or robots.txt route, served
 * at `path`: noindex when that path is under a protected prefix, no X-Robots-Tag otherwise.
 */
export function applyRobotsTagRule(res: Response, config: Config, path: string): Response {
  return isProtectedPath(config, path) ? withNoindex(res) : withoutRobotsTag(res);
}
