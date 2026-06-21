/**
 * GET /robots.txt handler. Same merge model as llms.txt, with a hash-marker
 * pair since robots.txt comments start with `#`.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

const BEGIN = "# cf-webmcp:begin";
const END = "# cf-webmcp:end";

export async function robotsTxtResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  const block = buildBlock(config);
  let body: string;

  const target = new URL(config.robots_txt.path, config.origin.base_url);
  const upstream = await proxyToOrigin(target);
  if (upstream.status === 404) {
    body = `${BEGIN}\n${block}\n${END}\n`;
  } else if (upstream.status === 200 && isTextish(upstream.headers.get("content-type"))) {
    const original = await upstream.text();
    body = mergeBlock(original, block);
  } else {
    return upstream;
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.robots_txt_max_age,
        s_maxage: config.cache.robots_txt_s_maxage,
        swr: config.cache.robots_txt_swr,
        sie: config.cache.robots_txt_sie,
      }),
      "x-content-type-options": "nosniff",
    },
  });
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
  if (config.features.ai_catalog && config.features.robots_txt) {
    const base = config.site.public_url ?? `https://${config.site.domain}`;
    lines.push(`Agentmap: ${base}${config.ai_catalog.path}`);
  }
  return lines.join("\n");
}

function isTextish(ct: string | null): boolean {
  if (!ct) return true;
  return /^text\/plain/i.test(ct);
}
