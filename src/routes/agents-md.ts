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
 * Plus an alias redirect handler: paths in [agents_md].aliases 301 to the
 * canonical [agents_md].path.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

const BEGIN = "<!-- cf-webmcp:begin -->";
const END = "<!-- cf-webmcp:end -->";

export async function agentsMdResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  const block = buildBlock(config);
  let body: string;

  if (config.agents_md.mode === "synthesize" || config.agents_md.mode === "replace") {
    body = `${BEGIN}\n${block}\n${END}\n`;
  } else {
    // merge
    const target = new URL(config.agents_md.path, config.origin.base_url);
    const upstream = await proxyToOrigin(target);
    if (upstream.status === 404) {
      body = `${BEGIN}\n${block}\n${END}\n`;
    } else if (upstream.status === 200 && isTextish(upstream.headers.get("content-type"))) {
      const original = await upstream.text();
      body = mergeBlock(original, block);
    } else {
      return upstream;
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.agents_md_max_age,
        s_maxage: config.cache.agents_md_s_maxage,
        swr: config.cache.agents_md_swr,
        sie: config.cache.agents_md_sie,
      }),
      "x-content-type-options": "nosniff",
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

function buildBlock(config: Config): string {
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

  lines.push(
    ``,
    `Full tool schema: [${manifestUrl}](${manifestUrl})`,
    ``,
    `### How agents connect`,
    ``,
    `- **Browser-native agents** (Chrome with WebMCP flag enabled, Cloudflare Browser Run lab sessions): tools auto-register via \`navigator.modelContext\` when the page loads. No setup.`,
    `- **Desktop MCP clients** (Claude Desktop, Cursor, Claude Code, Windsurf): pair at [${landingUrl}](${landingUrl}). The pairing page hosts the localhost-bridge widget.`,
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
    `- The fallback widget only initialises on the pairing page above.`,
  );

  return lines.join("\n");
}

function isTextish(ct: string | null): boolean {
  if (!ct) return true;
  return /^text\/(plain|markdown)/i.test(ct);
}
