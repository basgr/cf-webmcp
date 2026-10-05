/**
 * Redirect-safe fetch for Worker-to-origin requests that carry secret headers.
 *
 * The runtime's own redirect following (`redirect: "follow"`) resolves the whole
 * chain before the code sees a response, so a header such as the deploy token
 * would already have gone to whatever host the chain ended on. This helper turns
 * redirect following off and does it in a loop instead:
 *
 *   - Before every request, including each redirect hop, the target must be an
 *     http: or https: URL whose origin is on the allow-list. Anything else is
 *     refused without a request to it, so nothing, secret or not, is ever sent
 *     there. The scheme check comes first because a blob: URL reports the origin
 *     of the URL inside it (new URL("blob:https://a.example/x").origin is
 *     "https://a.example"), which an origin check alone would let through.
 *   - The secret headers are attached per hop, only after those checks passed.
 *   - At most `maxHops` redirects are followed (5 by default).
 *   - The method follows the Fetch spec: 301/302 turn a POST into a GET, 303 turns
 *     everything but GET and HEAD into a GET, 307/308 change nothing. A request that
 *     becomes a GET loses its body and its body headers; otherwise the already
 *     buffered body is replayed.
 *   - One AbortSignal covers every hop, so a caller's deadline spans the chain.
 *
 * A redirect status without a Location header is not a redirect we can follow:
 * it is returned as the final response and the caller decides what it means.
 *
 * A fetch that rejects (abort, network error) rejects here too; mapping it is
 * the caller's job.
 */

export const MAX_REDIRECT_HOPS = 5;

/** Did this fetch (or body read) end because its AbortSignal fired? */
export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Headers that must not outlive the body when a redirect turns the request into a GET:
 * the Fetch spec's request-body-header names (Content-Encoding, Content-Language,
 * Content-Location, Content-Type) plus Content-Length.
 */
const BODY_HEADERS = ["content-encoding", "content-language", "content-length", "content-location", "content-type"];

/** The only methods fetch() upper-cases; any other method keeps the case it was given. */
const NORMALISED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"]);

/** How much of an unparseable Location is reported (in the log, never to a client). */
const MAX_REPORTED_LOCATION = 200;

export type RedirectFailure =
  /** The very first URL was already off the list. `origin` is scheme://host[:port] only. */
  | { kind: "off_list"; origin: string; redirected: false }
  /**
   * A redirect pointed off the list. `status` is the status of the redirect response that
   * pointed there and `target` the Location resolved to an absolute http(s) URL (userinfo
   * removed, query and fragment kept), so a caller can relay the redirect itself. Nothing was
   * requested at `target`.
   */
  | { kind: "off_list"; origin: string; redirected: true; status: number; target: string }
  /** The target is not an http(s) URL (blob:, data:, javascript:, ftp:, ...). `protocol` includes the colon. */
  | { kind: "unsupported_scheme"; protocol: string; redirected: boolean }
  | { kind: "too_many_redirects"; maxHops: number }
  /** `location` is the raw header value cut to 200 characters. It may hold anything: log it, never show it. */
  | { kind: "malformed_location"; location: string };

export type ManualRedirectResult =
  | { ok: true; response: Response }
  | { ok: false; failure: RedirectFailure };

export interface ManualRedirectInit {
  /** Defaults to GET. A body is only sent with a method that may carry one. */
  method?: string;
  /** Already buffered, so a 307/308 (or a 301/302 on a non-POST) can replay it. */
  body?: string;
}

export interface ManualRedirectOptions {
  /** Origins (or URLs, normalised here with `new URL(x).origin`) the chain may visit. */
  allowedOrigins: readonly string[];
  /** Sent on every hop. Names are case-insensitive. */
  headers: Readonly<Record<string, string>>;
  /**
   * Sent on every hop, but only because the hop passed the scheme and allow-list checks
   * first. Set on top of `headers`, replacing a same-named header whatever its case.
   */
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

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

/** The URL as an absolute string without userinfo, which is the origin's to send but not ours to repeat. */
function withoutCredentials(url: URL): string {
  const copy = new URL(url.href);
  copy.username = "";
  copy.password = "";
  return copy.href;
}

/** Release the connection behind a response we are not going to read. */
function discard(res: Response): void {
  res.body?.cancel().catch(() => {});
}

/** Upper-case a method the way fetch() does: DELETE, GET, HEAD, OPTIONS, POST and PUT only, matched case-insensitively. */
function normaliseMethod(method: string): string {
  const upper = method.toUpperCase();
  return NORMALISED_METHODS.has(upper) ? upper : method;
}

/** Does a redirect with this status turn a request with this method into a bodyless GET? (Fetch spec, HTTP-redirect fetch.) */
function becomesGet(status: number, method: string): boolean {
  if (status === 303) return method !== "GET" && method !== "HEAD";
  if (status === 301 || status === 302) return method === "POST";
  return false;
}

export async function fetchWithManualRedirects(
  url: URL,
  init: ManualRedirectInit,
  opts: ManualRedirectOptions,
): Promise<ManualRedirectResult> {
  const allowed = normaliseOrigins(opts.allowedOrigins);
  const maxHops = opts.maxHops ?? MAX_REDIRECT_HOPS;

  let current = url;
  let method = normaliseMethod(init.method ?? "GET");
  let body = init.body;
  const plainHeaders = new Headers(opts.headers);
  let redirects = 0;
  let viaStatus = 0;

  while (true) {
    if (!isHttp(current)) {
      return { ok: false, failure: { kind: "unsupported_scheme", protocol: current.protocol, redirected: redirects > 0 } };
    }
    if (!allowed.has(current.origin)) {
      return {
        ok: false,
        failure:
          redirects > 0
            ? { kind: "off_list", origin: current.origin, redirected: true, status: viaStatus, target: withoutCredentials(current) }
            : { kind: "off_list", origin: current.origin, redirected: false },
      };
    }

    const hopHeaders = new Headers(plainHeaders);
    for (const [name, value] of Object.entries(opts.secretHeaders ?? {})) hopHeaders.set(name, value);

    const res = await fetch(current.toString(), {
      method,
      headers: Object.fromEntries(hopHeaders.entries()),
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
    viaStatus = res.status;

    if (becomesGet(res.status, method)) {
      method = "GET";
      body = undefined;
      for (const name of BODY_HEADERS) plainHeaders.delete(name);
    }
    current = next;
  }
}

/**
 * Write the detail of a refused redirect to the Worker log as ONE line: a fixed
 * prefix and a JSON object (so control characters in a hostile Location are
 * escaped), no stack. The caller's client-facing message stays generic; this line
 * is where an operator finds the host or value that was refused.
 *
 * No query string or fragment reaches the log: the start URL and an off-list target
 * are cut to origin and path, and an unparseable Location is cut at its first `?` or
 * `#` (and at 200 characters). A secret in a path would still show, so treat the log
 * as operator-only.
 */
export function logRedirectFailure(via: "executor" | "proxy", start: URL, failure: RedirectFailure): void {
  const where = isHttp(start) ? start.origin + start.pathname : start.protocol;
  console.error(`cf-webmcp: ${via} refused an origin redirect: ${JSON.stringify({ start: where, ...loggable(failure) })}`);
}

function loggable(failure: RedirectFailure): RedirectFailure {
  if (failure.kind === "off_list" && failure.redirected) {
    // target is a URL we built ourselves, so it parses.
    const target = new URL(failure.target);
    return { ...failure, target: target.origin + target.pathname };
  }
  if (failure.kind === "malformed_location") {
    const cut = failure.location.search(/[?#]/);
    const kept = cut === -1 ? failure.location : failure.location.slice(0, cut);
    return { ...failure, location: kept.slice(0, MAX_REPORTED_LOCATION) };
  }
  return failure;
}
