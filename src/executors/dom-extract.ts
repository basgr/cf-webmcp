/**
 * dom_extract executor. Fetches a URL (template-substituted), extracts a
 * region via CSS selector using HTMLRewriter, strips known noise tags, and
 * clamps total text length.
 *
 * Important: HTMLRewriter is streaming and selector support is limited. For
 * v1 we extract a text-only view of the matched region.
 */

import type { ExecutorContext } from "./common";
import { fromErr, mapOriginStatus, originFetch, resolveUrl } from "./common";
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
  // Drain the body so the handlers fire.
  await transformed.text();

  // Collapse whitespace.
  text = text.replace(/\s+/g, " ").trim();
  return ok({ url: resolved.url.toString(), text, truncated });
}

function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get("content-type") ?? "";
  return /^text\/html\b/i.test(ct);
}
