/**
 * GET /llms.txt handler.
 *
 * Modes (configured via [llms_txt].mode):
 *   - merge:      fetch origin's llms.txt, splice our block into a marker region
 *                 or append if marker absent. Idempotent on re-run.
 *   - synthesize: generate from TOML only, ignore origin
 *   - replace:    generate from TOML, discard any origin content
 *   - passthrough: route not registered (handled by router/feature toggle, not here)
 *
 * Merge reads origin's file through a 1 MiB cap (src/routes/read-capped.ts). A larger file is
 * relayed as origin sent it; one whose body fails mid-read is answered with the block alone,
 * as when origin has no file, but cached for a minute only. Either way the X-Robots-Tag rule
 * of the apex files applies (src/robots-tag.ts).
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { applyRobotsTagRule } from "../robots-tag";
import { ORIGIN_FAILURE_CACHE_CONTROL, readTextCapped } from "./read-capped";

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

/**
 * `widget` says whether the desktop-bridge widget is on (widgetEnabled in src/widget-state.ts:
 * the feature on and a widget in the build). It decides how the landing page is described:
 * "Pairing page" when it is, "WebMCP page" when it is not. Without an answer it follows
 * [features].fallback_widget.
 */
export async function llmsTxtResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
  tokenHints?: LlmsTxtTokenHints,
  widget: boolean = config.features.fallback_widget,
): Promise<Response> {
  const block = buildBlock(config, tokenHints, widget);
  // The document without origin's file: the block between its markers.
  const standalone = `${BEGIN}\n${block}\n${END}\n`;
  let body: string;
  let cacheControl = buildCacheControl({
    max_age: config.cache.llms_txt_max_age,
    s_maxage: config.cache.llms_txt_s_maxage,
    swr: config.cache.llms_txt_swr,
    sie: config.cache.llms_txt_sie,
  });

  if (config.llms_txt.mode === "synthesize" || config.llms_txt.mode === "replace") {
    body = standalone;
  } else {
    // merge (passthrough never gets here: the router leaves that path to origin)
    const target = new URL(config.llms_txt.path, config.origin.base_url);
    const upstream = await proxyToOrigin(target);
    if (upstream.status === 404) {
      body = standalone;
    } else if (upstream.status === 200 && isTextish(upstream.headers.get("content-type"))) {
      const read = await readTextCapped(upstream);
      if (read.kind === "text") {
        body = mergeBlock(read.text, block);
      } else if (read.kind === "relay") {
        // Over the cap: origin's file, not ours to merge into.
        return applyRobotsTagRule(read.upstream, config, config.llms_txt.path);
      } else {
        // The body failed mid-read: the block alone, for a minute.
        body = standalone;
        cacheControl = ORIGIN_FAILURE_CACHE_CONTROL;
      }
    } else {
      // Pass origin's response through, augmentation is best-effort. At its apex path
      // this route never carries X-Robots-Tag, so the noindex proxyToOrigin puts on its
      // own relays and failures comes off here (see src/robots-tag.ts).
      return applyRobotsTagRule(upstream, config, config.llms_txt.path);
    }
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
  return applyRobotsTagRule(response, config, config.llms_txt.path);
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

function buildBlock(config: Config, tokenHints: LlmsTxtTokenHints | undefined, widget: boolean): string {
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
  ];
  // Each line exists only while the document it names is served. The landing is called a
  // pairing page only when the widget that does the pairing is on.
  if (config.features.webmcp_landing) {
    lines.push(`- ${widget ? "Pairing page" : "WebMCP page"}: [${landing}](${landing})${landingTokens}`);
  }
  if (config.features.manifest) {
    lines.push(`- Tool catalogue: [${manifest}](${manifest})${manifestTokens}`);
  }
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    lines.push(`- Agent instructions: [${agentsMd}](${agentsMd})`);
  }
  if (config.features.api_catalog && config.api_catalog.mode !== "passthrough") {
    lines.push(`- API catalog (RFC 9727): [${apiCatalog}](${apiCatalog})`);
  }
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    const aiCatalog = `${base}${config.ai_catalog.path}`;
    lines.push(`- AI agent catalog (ARD): [${aiCatalog}](${aiCatalog})`);
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
