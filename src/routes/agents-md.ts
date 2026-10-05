/**
 * GET /.well-known/agents.md handler (default path; configurable).
 *
 * AGENTS.md is an emerging convention for prose, agent-readable instructions
 * about a site or repo. cf-webmcp publishes a `## WebMCP` block describing the
 * site's tool catalogue, discovery URLs, and operational guidance.
 *
 * Modes (configured via [agents_md].mode):
 *   - merge:       fetch origin's agents.md, splice block into a marker region
 *                  or append if marker absent. Idempotent on re-run.
 *   - synthesize:  generate from TOML only, ignore origin.
 *   - replace:     generate from TOML and discard any origin content.
 *   - passthrough: route not registered (handled by router/feature toggle).
 *
 * Merge reads origin's file through a 1 MiB cap (src/routes/read-capped.ts): a larger file is
 * relayed as origin sent it, with noindex; one whose body fails mid-read is answered with the
 * block alone, as when origin has no file, but cached for a minute only.
 *
 * Plus an alias redirect handler: paths in [agents_md].aliases 301 to the
 * canonical [agents_md].path.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { ORIGIN_FAILURE_CACHE_CONTROL, readTextCapped } from "./read-capped";

const BEGIN = "<!-- cf-webmcp:begin -->";
const END = "<!-- cf-webmcp:end -->";

/**
 * `widget` says whether the desktop-bridge widget is on (widgetEnabled in src/widget-state.ts:
 * the feature on and a widget in the build). Only then does the block tell desktop MCP clients
 * to pair on the landing page; otherwise the landing is described as the page it is. Without
 * an answer it follows [features].fallback_widget.
 */
export async function agentsMdResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
  widget: boolean = config.features.fallback_widget,
): Promise<Response> {
  const block = buildBlock(config, widget);
  // The document without origin's file: the block between its markers.
  const standalone = `${BEGIN}\n${block}\n${END}\n`;
  let body: string;
  let cacheControl = buildCacheControl({
    max_age: config.cache.agents_md_max_age,
    s_maxage: config.cache.agents_md_s_maxage,
    swr: config.cache.agents_md_swr,
    sie: config.cache.agents_md_sie,
  });

  if (config.agents_md.mode === "synthesize" || config.agents_md.mode === "replace") {
    body = standalone;
  } else {
    // merge (passthrough never gets here: the router leaves that path to origin)
    const target = new URL(config.agents_md.path, config.origin.base_url);
    const upstream = await proxyToOrigin(target);
    if (upstream.status === 404) {
      body = standalone;
    } else if (upstream.status === 200 && isTextish(upstream.headers.get("content-type"))) {
      const read = await readTextCapped(upstream);
      if (read.kind === "text") {
        body = mergeBlock(read.text, block);
      } else if (read.kind === "relay") {
        // Over the 1 MiB cap: origin's file, not ours to merge into. Noindex, as every answer here.
        return withNoindex(read.upstream);
      } else {
        // The body failed mid-read: the block alone, for a minute.
        body = standalone;
        cacheControl = ORIGIN_FAILURE_CACHE_CONTROL;
      }
    } else {
      // Origin returned something we cannot interpret (HTML, redirect, 5xx).
      // Relay it but enforce noindex since the path is under /.well-known/*.
      return withNoindex(upstream);
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      // Agent-discovery surface served under /.well-known/, not search-engine
      // content. See docs/scope.md and the x-robots coverage test.
      "x-robots-tag": "noindex",
    },
  });
}

export function agentsMdRedirect(config: Config): Response {
  return new Response(null, {
    status: 301,
    headers: {
      location: config.agents_md.path,
      "cache-control": buildCacheControl({
        max_age: config.cache.agents_md_redirect_max_age,
        s_maxage: config.cache.agents_md_redirect_s_maxage,
      }),
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

function buildBlock(config: Config, widget: boolean): string {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const ns = config.paths.namespace;
  const manifestUrl = `${base}${config.manifest.path}`;
  const landingUrl = `${base}${config.webmcp_landing.path}`;
  const healthUrl = `${base}${ns}/health`;

  const lines: string[] = [
    `## WebMCP on this site`,
    ``,
    `${config.site.name} exposes structured tools to AI agents via WebMCP. ${config.site.description}`,
    ``,
    `### Available tools`,
    ``,
  ];

  for (const t of config.tools) {
    lines.push(`- \`${t.name}\`: ${t.description}`);
  }
  // Surface form-injected tools too, since they're equally agent-callable.
  for (const f of config.forms) {
    lines.push(`- \`${f.name}\` (form): ${f.description}`);
  }

  if (config.features.manifest) {
    lines.push(``, `Full tool schema: [${manifestUrl}](${manifestUrl})`);
  }

  lines.push(
    ``,
    `### How agents connect`,
    ``,
    `- **Browser-native agents** (a browser or agent browser with the WebMCP runtime): tools auto-register via \`document.modelContext\` when the page loads. No setup.`,
  );
  // The landing page: a pairing page only while the widget is on; with it off the page lists
  // the tools and says whether the browser exposes WebMCP, and nothing here says to pair. With
  // the landing off it is not mentioned at all.
  if (config.features.webmcp_landing) {
    lines.push(
      widget
        ? `- **Desktop MCP clients** (Claude Desktop, Cursor, Claude Code, Windsurf): pair at [${landingUrl}](${landingUrl}). The pairing page hosts the localhost-bridge widget.`
        : `- **WebMCP page**: [${landingUrl}](${landingUrl}) lists these tools and shows whether your browser exposes WebMCP.`,
    );
  }

  lines.push(
    ``,
    `### Operational notes`,
    ``,
    `- Tool calls go to \`POST ${ns}/exec/<tool_name>\` with a JSON body.`,
    `- Responses use a stable envelope: \`{ ok: true, data }\` or \`{ ok: false, error: { code, message, retriable } }\`.`,
    `- Rate-limited responses include a \`Retry-After\` header; honour it.`,
    `- Operational health: [${healthUrl}](${healthUrl}).`,
    ``,
    `### What to avoid`,
    ``,
    `- Do not call \`${ns}/exec/*\` from cross-origin JS unless the publisher has configured \`[cors].allowed_origins\`.`,
    `- Do not retry on \`rate_limited\` errors faster than \`Retry-After\` indicates.`,
  );
  if (widget && config.features.webmcp_landing) {
    lines.push(`- The fallback widget only initialises on the pairing page above.`);
  }

  return lines.join("\n");
}

/**
 * The content types the agents.md route merges into: preflight judges origin's file with this
 * very test (a 200 without a Content-Type counts).
 */
export function isTextish(ct: string | null): boolean {
  if (!ct) return true;
  return /^text\/(plain|markdown)/i.test(ct);
}

/**
 * Clone a response and add `X-Robots-Tag: noindex`. Used when relaying an
 * origin response from a /.well-known/* route - the origin's headers may not
 * include the noindex tag, but the protected-prefix rule requires it.
 */
function withNoindex(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
