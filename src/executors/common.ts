/**
 * Shared fetch layer for every executor.
 *
 * Responsibilities:
 *   - Resolve a url_template against input via the compiled mini-language.
 *   - Reject any resolved URL outside [origin].allowed_origins.
 *   - Strip visitor cookies, set a stable User-Agent, attach the deploy-token
 *     bypass header so the publisher's Bot Management can allow our traffic.
 *   - Time-bound the fetch, and (via the run-wide signal) the body reads after it.
 *   - Bound body reads by size (readWithLimit).
 *   - Map response codes / network errors to the envelope error codes.
 */

import { compileTemplate } from "../mini-language";
import { err, type ErrorPayload } from "../envelope";

const VERSION = "1.0";

export interface ExecutorContext {
  allowedOrigins: string[];
  deployToken: string;
  /** Deadline for the whole run (fetch plus body reads), used in timeout messages. */
  timeoutMs: number;
  /**
   * Run-wide abort signal, owned by the caller (the exec route aborts it at the
   * deadline). When set, originFetch passes it to fetch and starts no timer of
   * its own, so the deadline stays armed until the executor has consumed the
   * body. Without it (direct callers, tests) originFetch falls back to a
   * fetch-only timer.
   */
  signal?: AbortSignal;
}

export function timeoutError(timeoutMs: number): ErrorPayload {
  return { code: "timeout", message: `origin request timed out after ${timeoutMs}ms`, retriable: true };
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === "AbortError";
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
 *   - Timeout via ctx.signal when the caller supplies one (it then also covers the
 *     body reads that follow), otherwise via a local AbortController that only
 *     covers the fetch itself.
 */
export async function originFetch(
  ctx: ExecutorContext,
  url: URL,
  opts: OriginFetchOptions = {},
): Promise<Response | { ok: false; error: ErrorPayload }> {
  const local = ctx.signal ? null : new AbortController();
  const timer = local ? setTimeout(() => local.abort(), ctx.timeoutMs) : undefined;
  const signal = ctx.signal ?? local!.signal;

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
      signal,
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
    return isAbortError(e)
      ? { ok: false, error: timeoutError(ctx.timeoutMs) }
      : { ok: false, error: { code: "internal", message: (e as Error).message, retriable: true } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A body that can be read as a stream: a Response, or the Request of the exec route. */
export interface BodySource {
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "aborted" };

/**
 * Read a body as UTF-8 text, giving up as soon as it exceeds `limit` bytes
 * (counted in bytes, not characters) or `signal` aborts.
 *
 *   - too_large: the stream is cancelled and nothing is buffered beyond the cap.
 *   - aborted:   the stream is cancelled and the partial body is discarded, so a
 *                half-read body can never be mistaken for a complete one.
 *
 * A stream error that is not an abort (a reset connection) propagates to the caller.
 */
export async function readWithLimit(
  source: BodySource,
  limit: number,
  signal?: AbortSignal,
): Promise<BoundedRead> {
  if (signal?.aborted) {
    await source.body?.cancel().catch(() => {});
    return { ok: false, reason: "aborted" };
  }
  const reader = source.body?.getReader();
  if (!reader) return { ok: true, text: await source.text() };

  // Cancelling the reader resolves a pending read() with done, which is how a
  // stalled body (a stream that never produces or closes) is released.
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (e) {
        if (signal?.aborted) return { ok: false, reason: "aborted" };
        throw e;
      }
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
    if (signal?.aborted) return { ok: false, reason: "aborted" };
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return { ok: true, text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(merged) };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Envelope error for a failed bounded read. `what` names the body in the message ("sitemap", "response"). */
export function readFailure(
  failure: { reason: "too_large" | "aborted" },
  ctx: ExecutorContext,
  limit: number,
  what: string,
): ErrorPayload {
  return failure.reason === "aborted"
    ? timeoutError(ctx.timeoutMs)
    : { code: "response_too_large", message: `${what} exceeded ${limit} bytes`, retriable: false };
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
