/**
 * dom_extract executor. Fetches a URL (template-substituted), extracts a
 * region via CSS selector using HTMLRewriter, strips known noise tags, and
 * clamps total text length.
 *
 * Important: HTMLRewriter is streaming and selector support is limited. For
 * v1 we extract a text-only view of the matched region.
 */

import type { ExecutorContext } from "./common";
import { fromErr, isAbortError, mapOriginStatus, originFetch, resolveUrl, timeoutError } from "./common";
import { err, ok, type Envelope } from "../envelope";

export interface DomExtractConfig {
  url_template: string;
  selector: string;
  strip: string[];
  max_chars: number;
}

export async function runDomExtract(
  ctx: ExecutorContext,
  config: DomExtractConfig,
  input: Record<string, unknown>,
): Promise<Envelope<{ url: string; text: string; truncated: boolean }>> {
  const resolved = resolveUrl(ctx, { urlTemplate: config.url_template, input });
  if (!resolved.ok) return err(resolved.error.code, resolved.error.message, resolved.error.retriable);

  const res = await originFetch(ctx, resolved.url, { acceptHeader: "text/html, */*" });
  if ("error" in res) return fromErr(res.error);
  const mapped = mapOriginStatus(res.status);
  if (mapped) return fromErr(mapped);
  if (!isHtmlResponse(res)) {
    return err("schema_mismatch", `expected text/html, got ${res.headers.get("content-type") ?? "unknown"}`, false);
  }

  let text = "";
  let truncated = false;
  const wantSelector = config.selector;
  const stripSelectors = new Set(config.strip);
  let inMatched = false;
  let depthInsideMatched = 0;
  let suppressDepth = 0;

  const rewriter = new HTMLRewriter()
    .on(wantSelector, {
      element(el) {
        inMatched = true;
        depthInsideMatched = 1;
        // Whenever we encounter the matched element, push a small marker.
        el.onEndTag(() => {
          depthInsideMatched--;
          if (depthInsideMatched <= 0) inMatched = false;
        });
      },
      text(chunk) {
        if (truncated) return;
        if (!inMatched || suppressDepth > 0) return;
        const left = config.max_chars - text.length;
        if (left <= 0) {
          truncated = true;
          return;
        }
        const t = chunk.text;
        text += t.length > left ? t.slice(0, left) : t;
        if (text.length >= config.max_chars) truncated = true;
      },
    });

  for (const tag of stripSelectors) {
    rewriter.on(tag, {
      element(el) {
        suppressDepth++;
        el.onEndTag(() => {
          suppressDepth--;
        });
      },
    });
  }

  const transformed = rewriter.transform(res);
  // Drain the transformed body so the handlers fire, discarding the output. Reading
  // chunk by chunk (rather than transformed.text()) keeps a huge page from being
  // buffered, stops as soon as max_chars is reached, and lets the run-wide abort
  // signal release a body that stalls.
  const drained = await drain(transformed, () => truncated, ctx.signal);
  if (drained === "aborted") return fromErr(timeoutError(ctx.timeoutMs));

  // Collapse whitespace.
  text = text.replace(/\s+/g, " ").trim();
  return ok({ url: resolved.url.toString(), text, truncated });
}

/**
 * Read `res.body` to the end (or until `enough()` says the handlers have what
 * they need), throwing the chunks away. "aborted" when `signal` fires first.
 * A stream error that is not an abort propagates.
 */
async function drain(
  res: Response,
  enough: () => boolean,
  signal?: AbortSignal,
): Promise<"done" | "aborted"> {
  if (!res.body) return "done";
  const reader = res.body.getReader();
  const onAbort = () => {
    reader.cancel().catch(() => {});
  };
  if (signal?.aborted) {
    onAbort();
    return "aborted";
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!enough()) {
      const { done } = await reader.read();
      if (done) break;
    }
    if (signal?.aborted) return "aborted";
    if (enough()) await reader.cancel().catch(() => {});
    return "done";
  } catch (e) {
    if (signal?.aborted || isAbortError(e)) return "aborted";
    throw e;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get("content-type") ?? "";
  return /^text\/html\b/i.test(ct);
}
