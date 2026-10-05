/**
 * rss_feed executor. Parses RSS 2.0 and Atom feeds. The feed URL is configured
 * in TOML (not input-derived), so no SSRF surface. Returns recent items.
 */

import type { ExecutorContext } from "./common";
import { fromErr, logExecutorProblem, mapOriginStatus, originFetch, readFailure, readWithLimit } from "./common";
import { err, ok, type Envelope } from "../envelope";

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

const ITEM_RE = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const TAG_RE = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");

export function parseFeed(xml: string): FeedItem[] {
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(ITEM_RE)) {
    const block = m[2];
    if (!block) continue;
    const title = stripCdata(extract(block, TAG_RE("title"))) ?? "";
    const link = extractLink(block);
    const pub = stripCdata(
      extract(block, TAG_RE("pubDate")) ?? extract(block, TAG_RE("updated")) ?? extract(block, TAG_RE("published")),
    );
    const summary = stripCdata(
      extract(block, TAG_RE("description")) ?? extract(block, TAG_RE("summary")) ?? extract(block, TAG_RE("content")),
    ) ?? "";
    out.push({ title, url: link ?? "", published: pub ?? null, summary });
  }
  return out;
}

function extract(block: string, re: RegExp): string | undefined {
  const m = block.match(re);
  return m?.[1]?.trim();
}

function extractLink(block: string): string | undefined {
  // RSS: <link>URL</link>. Atom: <link href="URL" .../>.
  const rss = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
  if (rss?.[1]?.trim()) return rss[1].trim();
  const atom = block.match(/<link\b[^>]*\bhref=("|')([^"']+)\1/i);
  return atom?.[2]?.trim();
}

function stripCdata(s: string | undefined): string | undefined {
  if (!s) return s;
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
}
