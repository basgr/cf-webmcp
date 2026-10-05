/**
 * GET /robots.txt handler. Same merge model as llms.txt, with a hash-marker
 * pair since robots.txt comments start with `#`. Same 1 MiB cap on origin's file too:
 * a larger one is relayed as origin sent it, and one whose body fails mid-read is
 * answered with the block alone, cached for a minute only.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { applyRobotsTagRule } from "../robots-tag";
import { ORIGIN_FAILURE_CACHE_CONTROL, readTextCapped } from "./read-capped";

const BEGIN = "# cf-webmcp:begin";
const END = "# cf-webmcp:end";

export async function robotsTxtResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  const block = buildBlock(config);
  // The document without origin's file: the block between its markers.
  const standalone = `${BEGIN}\n${block}\n${END}\n`;
  let body: string;
  let cacheControl = buildCacheControl({
    max_age: config.cache.robots_txt_max_age,
    s_maxage: config.cache.robots_txt_s_maxage,
    swr: config.cache.robots_txt_swr,
    sie: config.cache.robots_txt_sie,
  });

  const target = new URL(config.robots_txt.path, config.origin.base_url);
  const upstream = await proxyToOrigin(target);
  if (upstream.status === 404) {
    body = standalone;
  } else if (upstream.status === 200 && isTextish(upstream.headers.get("content-type"))) {
    const read = await readTextCapped(upstream);
    if (read.kind === "text") {
      body = mergeBlock(read.text, block);
    } else if (read.kind === "relay") {
      // Over the cap: origin's file, not ours to merge into. Same header policy as any answer here.
      return applyRobotsTagRule(read.upstream, config, config.robots_txt.path);
    } else {
      // The body failed mid-read: the block alone, for a minute.
      body = standalone;
      cacheControl = ORIGIN_FAILURE_CACHE_CONTROL;
    }
  } else {
    // Relay origin's answer. At its apex path this route never carries X-Robots-Tag, so
    // the noindex proxyToOrigin puts on its own relays and failures comes off here
    // (see src/robots-tag.ts).
    return applyRobotsTagRule(upstream, config, config.robots_txt.path);
  }

  const response = new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
    },
  });
  // No X-Robots-Tag at the apex; noindex if the configured path sits under a protected prefix.
  return applyRobotsTagRule(response, config, config.robots_txt.path);
}

export function mergeBlock(original: string, block: string): string {
  const beginIdx = original.indexOf(BEGIN);
  const endIdx = original.indexOf(END);
  if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
    const before = original.slice(0, beginIdx);
    const after = original.slice(endIdx + END.length);
    return `${before}${BEGIN}\n${block}\n${END}${after}`;
  }
  const trimmed = original.endsWith("\n") ? original : original + "\n";
  return `${trimmed}\n${BEGIN}\n${block}\n${END}\n`;
}

function buildBlock(config: Config): string {
  const ns = config.paths.namespace;
  const lines = [`User-agent: *`, `Disallow: ${ns}/`];
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    const base = config.site.public_url ?? `https://${config.site.domain}`;
    lines.push(`Agentmap: ${base}${config.ai_catalog.path}`);
  }
  return lines.join("\n");
}

/**
 * The content types the robots.txt route merges into: preflight judges origin's file with this
 * very test (a 200 without a Content-Type counts).
 */
export function isTextish(ct: string | null): boolean {
  if (!ct) return true;
  return /^text\/plain/i.test(ct);
}
