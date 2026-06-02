/**
 * GET /llms.txt handler.
 *
 * Modes (configured via [llms_txt].mode):
 *   - merge:      fetch origin's llms.txt, splice our block into a marker region
 *                 or append if marker absent. Idempotent on re-run.
 *   - synthesize: generate from TOML only, ignore origin
 *   - replace:    generate from TOML, discard any origin content
 *   - passthrough: route not registered (handled by router/feature toggle, not here)
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

const BEGIN = "<!-- cf-webmcp:begin -->";
const END = "<!-- cf-webmcp:end -->";

/**
 * Build-time token-count estimates for the documents the WebMCP block links
 * to. When supplied, the matching links are annotated with `(~N tokens)`
 * context-budget hints. Optional so the function stays usable (and testable)
 * without the generated constant.
 */
export interface LlmsTxtTokenHints {
  manifest: number;
  landing: number;
}

export async function llmsTxtResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
  tokenHints?: LlmsTxtTokenHints,
): Promise<Response> {
  const block = buildBlock(config, tokenHints);
  let body: string;

  if (config.llms_txt.mode === "synthesize" || config.llms_txt.mode === "replace") {
    body = `${BEGIN}\n${block}\n${END}\n`;
  } else {
    // merge
    const target = new URL(config.llms_txt.path, config.origin.base_url);
    const upstream = await proxyToOrigin(target);
    if (upstream.status === 404) {
      body = `${BEGIN}\n${block}\n${END}\n`;
    } else if (upstream.status === 200 && isTextish(upstream.headers.get("content-type"))) {
      const original = await upstream.text();
      body = mergeBlock(original, block);
    } else {
      // Pass origin's response through, augmentation is best-effort.
      return upstream;
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.llms_txt_max_age,
        s_maxage: config.cache.llms_txt_s_maxage,
        swr: config.cache.llms_txt_swr,
        sie: config.cache.llms_txt_sie,
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

function buildBlock(config: Config, tokenHints?: LlmsTxtTokenHints): string {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const landing = `${base}${config.webmcp_landing.path}`;
  const manifest = `${base}${config.manifest.path}`;
  const agentsMd = `${base}${config.agents_md.path}`;
  const apiCatalog = `${base}${config.api_catalog.path}`;
  // `(~N tokens)` budget hints, only on the two links whose bodies are known
  // at build time. Empty string when no hints supplied.
  const landingTokens = tokenHints ? ` (~${tokenHints.landing} tokens)` : "";
  const manifestTokens = tokenHints ? ` (~${tokenHints.manifest} tokens)` : "";
  const lines: string[] = [
    `## WebMCP`,
    ``,
    `${config.site.name} exposes structured tools to AI agents via WebMCP.`,
    ``,
    `- Pairing page: [${landing}](${landing})${landingTokens}`,
    `- Tool catalogue: [${manifest}](${manifest})${manifestTokens}`,
  ];
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    lines.push(`- Agent instructions: [${agentsMd}](${agentsMd})`);
  }
  if (config.features.api_catalog && config.api_catalog.mode !== "passthrough") {
    lines.push(`- API catalog (RFC 9727): [${apiCatalog}](${apiCatalog})`);
  }
  lines.push(``, `### Tools`, ``);
  for (const t of config.tools) {
    lines.push(`- \`${t.name}\` - ${t.description}`);
  }
  return lines.join("\n");
}

function isTextish(ct: string | null): boolean {
  if (!ct) return true;
  return /^text\/(plain|markdown)/i.test(ct);
}
