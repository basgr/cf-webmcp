/**
 * Redirect-safe fetch for Worker-to-origin requests that carry secret headers.
 *
 * The runtime's own redirect following (`redirect: "follow"`) resolves the whole
 * chain before the code sees a response, so a header such as the deploy token
 * would already have gone to whatever host the chain ended on. This helper turns
 * redirect following off and does it in a loop instead:
 *
 *   - Before every request, including each redirect hop, the target's origin is
 *     checked against the allow-list. An off-list target is refused without any
 *     request to it, so nothing, secret or not, is ever sent there.
 *   - The secret headers are attached per hop, only after that check passed.
 *   - At most `maxHops` redirects are followed (5 by default).
 *   - 301, 302 and 303 continue as a bodyless GET; 307 and 308 replay the method
 *     and the already buffered body.
 *   - One AbortSignal covers every hop, so a caller's deadline spans the chain.
 *
 * A redirect status without a Location header is not a redirect we can follow:
 * it is returned as the final response and the caller decides what it means.
 *
 * A fetch that rejects (abort, network error) rejects here too; mapping it is
 * the caller's job.
 */

export const MAX_REDIRECT_HOPS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Request-body headers that must not outlive the body when a redirect turns the request into a GET. */
const BODY_HEADERS = new Set(["content-type", "content-length", "content-encoding"]);

/** How much of an unparseable Location is reported back. */
const MAX_REPORTED_LOCATION = 200;

export type RedirectFailure =
  /**
   * `origin` is scheme://host[:port] only (the scheme for an opaque origin such as
   * data:), so a Location cannot put path or query text into a message.
   * `redirected` is false when the very first URL was already off the list.
   */
  | { kind: "off_list"; origin: string; redirected: boolean }
  | { kind: "too_many_redirects"; maxHops: number }
  /** `location` is the raw header value cut to 200 characters; quote it, never interpolate it bare. */
  | { kind: "malformed_location"; location: string };

export type ManualRedirectResult =
  | { ok: true; response: Response }
  | { ok: false; failure: RedirectFailure };

export interface ManualRedirectInit {
  /** Defaults to GET. A body is only sent with a method that may carry one. */
  method?: string;
  /** Already buffered, so a 307/308 can replay it. */
  body?: string;
}

export interface ManualRedirectOptions {
  /** Origins (or URLs, normalised here with `new URL(x).origin`) the chain may visit. */
  allowedOrigins: readonly string[];
  /** Sent on every hop. */
  headers: Readonly<Record<string, string>>;
  /** Sent on every hop, but only because the hop's origin passed the allow-list check first. */
  secretHeaders?: Readonly<Record<string, string>>;
  /** One signal for the whole chain. */
  signal?: AbortSignal;
  /** Redirects to follow before giving up. Defaults to MAX_REDIRECT_HOPS. */
  maxHops?: number;
}

function normaliseOrigins(entries: readonly string[]): Set<string> {
  const origins = new Set<string>();
  for (const entry of entries) {
    try {
      const origin = new URL(entry).origin;
      // "null" is the opaque origin of data: and similar URLs; it must never match anything.
      if (origin !== "null") origins.add(origin);
    } catch {
      // Not a URL, so it cannot allow any origin.
    }
  }
  return origins;
}

function describeOrigin(url: URL): string {
  return url.origin === "null" ? url.protocol : url.origin;
}

/** Release the connection behind a response we are not going to read. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

export async function fetchWithManualRedirects(
  url: URL,
  init: ManualRedirectInit,
  opts: ManualRedirectOptions,
): Promise<ManualRedirectResult> {
  const allowed = normaliseOrigins(opts.allowedOrigins);
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;

  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;
  let headers: Record<string, string> = { ...opts.headers };
  let redirects = 0;

  while (true) {
    if (!allowed.has(current.origin)) {
      return { ok: false, failure: { kind: "off_list", origin: describeOrigin(current), redirected: redirects > 0 } };
    }

    const res = await fetch(current.toString(), {
      method,
      headers: { ...headers, ...opts.secretHeaders },
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: opts.signal,
    });

    const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get("location") : null;
    if (location === null) return { ok: true, response: res };

    if (redirects >= maxHops) {
      discard(res);
      return { ok: false, failure: { kind: "too_many_redirects", maxHops } };
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      discard(res);
      return { ok: false, failure: { kind: "malformed_location", location: location.slice(0, MAX_REPORTED_LOCATION) } };
    }
    discard(res);
    redirects++;

    // The executors only issue GET and POST, so "301/302/303 become GET" is exact for them.
    if (res.status !== 307 && res.status !== 308) {
      method = "GET";
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())));
    }
    current = next;
  }
}
