/**
 * Shared fetch layer for every executor.
 *
 * Responsibilities:
 *   - Resolve a url_template against input via the compiled mini-language.
 *   - Reject any resolved URL outside [origin].allowed_origins.
 *   - Strip visitor cookies, set a stable User-Agent, attach the deploy-token
 *     bypass header so the publisher's Bot Management can allow our traffic.
 *   - Time-bound the fetch.
 *   - Map response codes / network errors to the envelope error codes.
 */

import { compileTemplate } from "../mini-language";
import { err, type ErrorPayload } from "../envelope";

const VERSION = "1.0";

export interface ExecutorContext {
  allowedOrigins: string[];
  deployToken: string;
  timeoutMs: number;
}

export interface ResolveOptions {
  urlTemplate: string;
  input: Record<string, unknown>;
}

/**
 * Resolve a template into a URL, asserting the result lies in allowedOrigins.
 * Throws an Envelope error payload on failure.
 */
export function resolveUrl(
  ctx: ExecutorContext,
  opts: ResolveOptions,
): { ok: true; url: URL } | { ok: false; error: ErrorPayload } {
  let resolved: string;
  try {
    const compiled = compileTemplate(opts.urlTemplate);
    resolved = compiled.resolver(opts.input);
  } catch (e) {
    return { ok: false, error: { code: "invalid_input", message: (e as Error).message, retriable: false } };
  }
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    return { ok: false, error: { code: "invalid_input", message: `resolved URL is malformed: ${resolved}`, retriable: false } };
  }
  if (!ctx.allowedOrigins.includes(url.origin)) {
    return {
      ok: false,
      error: {
        code: "invalid_input",
        message: `resolved origin ${url.origin} is not in allowed_origins`,
        retriable: false,
      },
    };
  }
  return { ok: true, url };
}

export interface OriginFetchOptions {
  method?: string;
  acceptHeader?: string;
  /** Bypass header value (typically `1`); the deploy_token goes in a separate header. */
  bypassEnabled?: boolean;
}

/**
 * Fetch a URL on the publisher's origin with safe defaults.
 *   - No visitor cookies. credentials: omit. headers stripped to minimum.
 *   - Stable UA.
 *   - bypass header set if enabled.
 *   - Timeout via AbortController.
 */
export async function originFetch(
  ctx: ExecutorContext,
  url: URL,
  opts: OriginFetchOptions = {},
): Promise<Response | { ok: false; error: ErrorPayload }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);

  const headers: Record<string, string> = {
    "user-agent": `cf-webmcp/${VERSION}`,
  };
  if (opts.acceptHeader) headers["accept"] = opts.acceptHeader;
  if (opts.bypassEnabled !== false && ctx.deployToken) {
    headers["cf-webmcp-bypass"] = "1";
    headers["cf-webmcp-deploy-token"] = ctx.deployToken;
  }

  try {
    const res = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    // Defense in depth: even though the initial URL passed the allow-list
    // check, an origin can 301/302 us to a different host. Verify the final
    // post-redirect URL is still in the allow-list. Refuse to return the
    // response if it points off-list.
    if (res.url) {
      let finalOrigin: string;
      try {
        finalOrigin = new URL(res.url).origin;
      } catch {
        return { ok: false, error: { code: "internal", message: `origin returned malformed final URL ${res.url}`, retriable: false } };
      }
      if (!ctx.allowedOrigins.includes(finalOrigin)) {
        return {
          ok: false,
          error: {
            code: "invalid_input",
            message: `origin redirected to ${finalOrigin} which is not in allowed_origins; refused to follow`,
            retriable: false,
          },
        };
      }
    }
    return res;
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    return aborted
      ? { ok: false, error: { code: "timeout", message: `origin fetch timed out after ${ctx.timeoutMs}ms`, retriable: true } }
      : { ok: false, error: { code: "internal", message: (e as Error).message, retriable: true } };
  } finally {
    clearTimeout(timer);
  }
}

/** Map an HTTP response code from origin into our envelope error codes. */
export function mapOriginStatus(status: number): ErrorPayload | null {
  if (status >= 200 && status < 300) return null;
  if (status >= 500) return { code: "origin_5xx", message: `origin returned ${status}`, retriable: true };
  if (status === 404) return { code: "not_found", message: "origin returned 404", retriable: false };
  if (status === 429) return { code: "rate_limited", message: "origin rate-limited", retriable: true };
  if (status >= 400) return { code: "origin_4xx", message: `origin returned ${status}`, retriable: false };
  return { code: "internal", message: `unexpected status ${status}`, retriable: false };
}

export function fromErr(e: ErrorPayload) {
  return err(e.code, e.message, e.retriable);
}
