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
import { browserRegistration, defaultLandingTemplate, formToolsStamped, scriptTools } from "../runtime-copy";
import { isProtectedPath } from "../robots-tag";

const BEGIN = "<!-- cf-webmcp:begin -->";
const END = "<!-- cf-webmcp:end -->";

/**
 * `widget` says whether the desktop-bridge widget is on (widgetEnabled in src/widget-state.ts:
 * the feature on and a widget in the build). Only then does the block tell desktop MCP clients
 * to pair on the landing page; otherwise the landing is described as the page it is. Without
 * an answer it follows [features].fallback_widget.
 *
 * `healthOpen` says whether /_webmcp/health answers without a bearer token; only then does the
 * block link it. The handler works it out with the CF_WEBMCP_HEALTH_TOKEN secret, which only the
 * Worker sees (this document is built per request, so it can). Without an answer it follows
 * the TOML alone.
 */
export async function agentsMdResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
  widget: boolean = config.features.fallback_widget,
  healthOpen: boolean = healthAnswersWithoutToken(config, undefined),
): Promise<Response> {
  const block = buildBlock(config, widget, healthOpen);
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

/**
 * 301 from an [agents_md].aliases path (`pathname`, the alias this request asked for) to the
 * canonical [agents_md].path. The default aliases sit at the apex and carry no X-Robots-Tag; an
 * alias placed under the namespace or /.well-known/ carries noindex, like every answer there.
 */
export function agentsMdRedirect(config: Config, pathname: string): Response {
  const headers: Record<string, string> = {
    location: config.agents_md.path,
    "cache-control": buildCacheControl({
      max_age: config.cache.agents_md_redirect_max_age,
      s_maxage: config.cache.agents_md_redirect_s_maxage,
    }),
  };
  if (isProtectedPath(config, pathname)) headers["x-robots-tag"] = "noindex";
  return new Response(null, { status: 301, headers });
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

/**
 * Whether /_webmcp/health answers without a bearer token: [health].public on and no token, the
 * CF_WEBMCP_HEALTH_TOKEN secret (`envToken`, an empty string counts as unset) or [health].token.
 * The same rule as healthResponse in src/routes/health.ts.
 */
export function healthAnswersWithoutToken(config: Config, envToken: string | undefined): boolean {
  return config.health.public && !(envToken || config.health.token);
}

function buildBlock(config: Config, widget: boolean, healthOpen: boolean): string {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const ns = config.paths.namespace;
  const manifestUrl = `${base}${config.manifest.path}`;
  const landingUrl = `${base}${config.webmcp_landing.path}`;
  const landingLink = `[${landingUrl}](${landingUrl})`;
  const healthUrl = `${base}${ns}/health`;
  // Form tools exist only while the Worker stamps them; everything else here (the bootstrap, the
  // manifest, the exec route, the landing's list, the widget) knows the [[tools]] only.
  const forms = formToolsStamped(config);
  const tools = scriptTools(config);

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
  // Form tools are as agent-callable as the others, on the pages that carry their form.
  if (forms) {
    for (const f of config.forms) {
      lines.push(`- \`${f.name}\` (form): ${f.description}`);
    }
  }

  if (config.features.manifest) {
    lines.push(``, `Full tool schema${forms ? " (the tools that are not forms)" : ""}: [${manifestUrl}](${manifestUrl})`);
  }

  const connect: string[] = [];
  const browser = browserRegistration(config, landingLink);
  if (browser !== null) connect.push(`- **Browser-native agents**: ${browser} No setup.`);
  // The landing page: a pairing page only while the widget is on; with it off the default page
  // lists the tools and says whether the browser exposes WebMCP, and nothing here says to pair.
  // A custom template is only named. With the landing off it is not mentioned at all.
  if (config.features.webmcp_landing) {
    if (widget) {
      connect.push(
        `- **Desktop MCP clients** (Claude Desktop, Cursor, Claude Code, Windsurf): pair at ${landingLink}. The pairing page hosts the localhost-bridge widget.` +
          (forms ? ` The bridge reaches ${tools}.` : ""),
      );
    } else if (defaultLandingTemplate(config)) {
      connect.push(`- **WebMCP page**: ${landingLink} lists ${tools} and shows whether your browser exposes WebMCP.`);
    } else {
      connect.push(`- **WebMCP page**: ${landingLink}.`);
    }
  }
  if (connect.length > 0) lines.push(``, `### How agents connect`, ``, ...connect);

  lines.push(
    ``,
    `### Operational notes`,
    ``,
    `- ${forms ? `Calls to ${tools}` : "Tool calls"} go to \`POST ${ns}/exec/<tool_name>\` with a JSON body.`,
    `- Responses use a stable envelope: \`{ ok: true, data }\` or \`{ ok: false, error: { code, message, retriable } }\`.`,
    // The exec route's own limiter sets Retry-After; an origin 429 becomes the same error without it.
    `- A \`rate_limited\` error (HTTP 429) from this site's own rate limit carries a \`Retry-After\` header; honour it. One that origin's rate limit caused has none.`,
  );
  if (healthOpen) lines.push(`- Operational health: [${healthUrl}](${healthUrl}).`);
  lines.push(
    ``,
    `### What to avoid`,
    ``,
    `- Do not call \`${ns}/exec/*\` from cross-origin JS unless the publisher has configured \`[cors].allowed_origins\`.`,
    `- Do not retry a \`rate_limited\` error sooner than its \`Retry-After\` says; without one, back off before retrying.`,
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
