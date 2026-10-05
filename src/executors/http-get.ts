/**
 * http_get executor. Fetches a URL and returns the response body as-is,
 * within hard size and content-type limits.
 *
 * Safety constraints:
 *   - max_bytes: refuse responses larger than this (read up to limit+1 then bail).
 *   - allowed_content_types: glob-y match list. Refuses anything not in the list.
 *
 * The agent gets back { status, content_type, body } as a string.
 */

import type { ExecutorContext } from "./common";
import { fromErr, mapOriginStatus, originFetch, readFailure, readWithLimit, resolveUrl } from "./common";
import { err, ok, type Envelope } from "../envelope";

export interface HttpGetConfig {
  url_template: string;
  method: "GET";
  max_bytes: number;
  allowed_content_types: string[];
}

export interface HttpGetResult {
  status: number;
  content_type: string;
  body: string;
}

export async function runHttpGet(
  ctx: ExecutorContext,
  config: HttpGetConfig,
  input: Record<string, unknown>,
): Promise<Envelope<HttpGetResult>> {
  const resolved = resolveUrl(ctx, { urlTemplate: config.url_template, input });
  if (!resolved.ok) return err(resolved.error.code, resolved.error.message, resolved.error.retriable);

  const res = await originFetch(ctx, resolved.url, { method: "GET" });
  if ("error" in res) return fromErr(res.error);
  const mapped = mapOriginStatus(res.status);
  if (mapped) return fromErr(mapped);

  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (!matchesAny(ct, config.allowed_content_types)) {
    return err("content_type_blocked", `content-type "${ct}" not in allowed_content_types`, false);
  }

  // Enforce max_bytes by streaming. We read up to max_bytes + 1; if we
  // overshoot, we reject the whole response.
  const limited = await readWithLimit(res, config.max_bytes, ctx.signal);
  if (!limited.ok) return fromErr(readFailure(limited, ctx, config.max_bytes, "response"));

  return ok({ status: res.status, content_type: ct, body: limited.text });
}

export function matchesAny(contentType: string, patterns: string[]): boolean {
  // Strip parameters (`;` and onwards).
  const main = contentType.split(";")[0]?.trim() ?? "";
  return patterns.some((p) => matchOneType(main, p.toLowerCase()));
}

function matchOneType(actual: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "*/*") return true;
  if (pattern.endsWith("/*")) {
    const family = pattern.slice(0, -2);
    return actual.startsWith(family + "/");
  }
  return actual === pattern;
}
