/**
 * rss_feed executor. Parses RSS 2.0 and Atom feeds. The feed URL is configured
 * in TOML (not input-derived), so no SSRF surface. Returns recent items.
 */

import type { ExecutorContext } from "./common";
import { fromErr, logExecutorProblem, mapOriginStatus, originFetch, readFailure, readWithLimit } from "./common";
import { err, ok, type Envelope } from "../envelope";
import { elementContents, unwrapCdata } from "./xml-scan";

/** Largest feed body we will read. */
export const MAX_FEED_BYTES = 2 * 1024 * 1024;

export interface RssConfig {
  feed_url: string;
  max_items: number;
}

export interface FeedItem {
  title: string;
  url: string;
  published: string | null;
  summary: string;
}

export async function runRssFeed(
  ctx: ExecutorContext,
  config: RssConfig,
  _input: Record<string, unknown>,
): Promise<Envelope<{ items: FeedItem[] }>> {
  // The build checks feed_url, so neither refusal is expected; their messages name no host all
  // the same, and the log gets the detail.
  let url: URL;
  try {
    url = new URL(config.feed_url);
  } catch {
    logExecutorProblem("refused feed_url", { reason: "malformed" });
    return err("internal", "feed_url is not a valid URL", false);
  }
  if (!ctx.allowedOrigins.includes(url.origin)) {
    logExecutorProblem("refused feed_url", { reason: "origin not in allowed_origins", origin: url.origin });
    return err("internal", "feed_url is not in allowed_origins", false);
  }
  const res = await originFetch(ctx, url, { acceptHeader: "application/rss+xml, application/atom+xml, application/xml, */*" });
  if ("error" in res) return fromErr(res.error);
  const mapped = mapOriginStatus(res.status);
  if (mapped) return fromErr(mapped);
  const body = await readWithLimit(res, MAX_FEED_BYTES, ctx.signal);
  if (!body.ok) return fromErr(readFailure(body, ctx, MAX_FEED_BYTES, "feed"));
  const items = parseFeed(body.text).slice(0, config.max_items);
  return ok({ items });
}

const ITEM_TAGS = ["item", "entry"] as const;

/**
 * Reads RSS items and Atom entries in one pass over the body, whatever tags are left open: the
 * body is origin's, up to 2 MiB, and the lazy regexes this replaces took minutes on 2 MiB of
 * unclosed tags (src/executors/xml-scan.ts has the scan). It returns what those regexes returned,
 * quirks included: a link in CDATA is not unwrapped, an empty first `<link>` element sends the
 * link to the Atom `href`, the last `href` in a start tag wins and `rel` is not looked at.
 * rss.test.ts keeps the regex parser as an oracle and compares.
 */
export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const block of elementContents(xml, ITEM_TAGS)) {
    if (!block) continue;
    const title = stripCdata(firstElement(block, "title")) ?? "";
    const link = extractLink(block);
    const pub = stripCdata(
      firstElement(block, "pubDate") ?? firstElement(block, "updated") ?? firstElement(block, "published"),
    );
    const summary = stripCdata(
      firstElement(block, "description") ?? firstElement(block, "summary") ?? firstElement(block, "content"),
    ) ?? "";
    out.push({ title, url: link ?? "", published: pub ?? null, summary });
  }
  return out;
}

/** The first `<tag>` element's content in `block`, trimmed; undefined when there is none, "" when it is empty. */
function firstElement(block: string, tag: string): string | undefined {
  return elementContents(block, tag, 1)[0]?.trim();
}

function extractLink(block: string): string | undefined {
  // RSS: <link>URL</link>. Atom: <link href="URL" .../>.
  const rss = firstElement(block, "link");
  if (rss) return rss;
  return atomHref(block)?.trim();
}

const LINK_OPEN = /<link\b/gi;
const HREF_ATTR = /\bhref=(["'])/gi;
const QUOTE = /["']/g;

/**
 * The value of an `href` attribute of the first `<link` start tag that has one, as the regex
 * `<link\b[^>]*\bhref=("|')([^"']+)\1` (flag `i`) finds it, in one pass. What the regex does:
 *
 *   - `[^>]*` stays inside the start tag, and backtracks from its end, so with several valid
 *     `href="..."` in one tag the last one wins. The attribute itself needs `\b` before it
 *     (`data-href` counts, `xhref` does not), no blanks around `=`, a quote, one or more characters
 *     that are not quotes, and the same quote again. The value may hold `>` and run past the end
 *     of the start tag.
 *   - Whether an `href="..."` is valid does not depend on which `<link` it is read from. So a
 *     start tag with none makes every `<link` inside the same tag fail too, and the scan goes on
 *     after its `>`; with no `>` left, it stops.
 *   - Every candidate `href="` is looked at once, and its closing quote search ends at the next
 *     candidate's opening quote at the latest.
 */
function atomHref(block: string): string | undefined {
  let cursor = 0;
  // The first `href=` and quote at or after the last position searched from: undefined not searched yet, null none.
  let hit: RegExpExecArray | null | undefined;
  const hitFrom = (from: number): RegExpExecArray | null => {
    if (hit === undefined || (hit !== null && hit.index < from)) {
      HREF_ATTR.lastIndex = from;
      hit = HREF_ATTR.exec(block);
    }
    return hit;
  };
  for (;;) {
    LINK_OPEN.lastIndex = cursor;
    const link = LINK_OPEN.exec(block);
    if (link === null) return undefined;
    const tagStart = link.index + link[0].length;
    const gt = block.indexOf(">", tagStart);
    const tagEnd = gt === -1 ? block.length : gt;
    let value: string | undefined;
    for (let from = tagStart; ; ) {
      const attr = hitFrom(from);
      if (attr === null || attr.index >= tagEnd) break;
      const valueStart = attr.index + attr[0].length;
      QUOTE.lastIndex = valueStart;
      const close = QUOTE.exec(block);
      if (close !== null && close.index > valueStart && close[0] === attr[1]) value = block.slice(valueStart, close.index);
      from = valueStart;
    }
    if (value !== undefined) return value;
    if (gt === -1) return undefined;
    cursor = gt + 1;
  }
}

function stripCdata(s: string | undefined): string | undefined {
  if (!s) return s;
  return unwrapCdata(s).trim();
}
