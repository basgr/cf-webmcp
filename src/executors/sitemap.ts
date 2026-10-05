/**
 * sitemap_filter executor.
 * Fetches a sitemap.xml from origin and filters entries by substring match
 * (case-insensitive, no regex). Returns up to max_results entries.
 *
 * The sitemap URL is taken directly from TOML (validated at build time to be
 * in allowed_origins), not from agent input. Only the `query` parameter is
 * agent-provided. This means the SSRF surface is empty for this executor.
 */

import type { ExecutorContext } from "./common";
import { fromErr, logExecutorProblem, mapOriginStatus, originFetch, readFailure, readWithLimit } from "./common";
import { err, ok, type Envelope } from "../envelope";
import { elementContents, unwrapCdata } from "./xml-scan";

/** Largest sitemap body we will read. The protocol caps a sitemap at 50 MB; this is a deliberate, lower bound for an edge Worker. */
export const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;

export interface SitemapConfig {
  sitemap_url: string;
  max_results: number;
}

export interface SitemapInput {
  query?: unknown;
}

interface SitemapEntry {
  url: string;
  lastmod?: string;
}

export async function runSitemapFilter(
  ctx: ExecutorContext,
  config: SitemapConfig,
  input: SitemapInput,
): Promise<Envelope<{ entries: SitemapEntry[] }>> {
  // The build checks sitemap_url, so neither refusal is expected; their messages name no host all
  // the same, and the log gets the detail.
  let url: URL;
  try {
    url = new URL(config.sitemap_url);
  } catch {
    logExecutorProblem("refused sitemap_url", { reason: "malformed" });
    return err("internal", "sitemap_url is not a valid URL", false);
  }
  if (!ctx.allowedOrigins.includes(url.origin)) {
    logExecutorProblem("refused sitemap_url", { reason: "origin not in allowed_origins", origin: url.origin });
    return err("internal", "sitemap_url is not in allowed_origins", false);
  }

  const res = await originFetch(ctx, url, { acceptHeader: "application/xml, text/xml, */*" });
  if ("error" in res) return fromErr(res.error);
  const mapped = mapOriginStatus(res.status);
  if (mapped) return fromErr(mapped);

  const body = await readWithLimit(res, MAX_SITEMAP_BYTES, ctx.signal);
  if (!body.ok) return fromErr(readFailure(body, ctx, MAX_SITEMAP_BYTES, "sitemap"));
  const entries = parseSitemap(body.text);

  const q = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const filtered = q
    ? entries.filter((e) => e.url.toLowerCase().includes(q))
    : entries;
  return ok({ entries: filtered.slice(0, config.max_results) });
}

/**
 * Minimal sitemap parser. Accepts plain <urlset> sitemaps. Sitemap-index files
 * are not followed in v1 (publishers can point the executor at a leaf sitemap).
 *
 * Tag matching is tolerant of attributes, CDATA, and namespaces, and case-insensitive.
 * Robust enough for well-formed sitemaps. Malformed XML returns whatever it
 * could parse. It reads the body in one pass (src/executors/xml-scan.ts), whatever
 * tags are left open: the body is origin's, up to 5 MiB.
 */
export function parseSitemap(xml: string): SitemapEntry[] {
  const out: SitemapEntry[] = [];
  for (const block of elementContents(xml, "url")) {
    if (!block) continue;
    const loc = extractTag(block, "loc");
    if (!loc) continue;
    const lastmod = extractTag(block, "lastmod");
    const entry: SitemapEntry = { url: loc };
    if (lastmod !== undefined) entry.lastmod = lastmod;
    out.push(entry);
  }
  return out;
}

/** The first `<tag>` element's content in `block`, CDATA unwrapped and trimmed; undefined when there is none or it is empty. */
function extractTag(block: string, tag: string): string | undefined {
  const content = elementContents(block, tag, 1)[0];
  if (!content) return undefined;
  return unwrapCdata(content).trim();
}
