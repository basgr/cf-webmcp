/**
 * GET /.well-known/agent-skills/<slug>/SKILL.md handler.
 *
 * Publishes an Anthropic-format Agent Skill describing the site's WebMCP
 * surface. The body is a markdown document with YAML frontmatter (`name` +
 * `description`) followed by:
 *   - an auto-generated list of `[[tools]]` and `[[forms]]`,
 *   - optional publisher-written `[[agent_skills.hints]]` sections,
 *   - a closing pointer at the WebMCP manifest.
 *
 * Modes match the other discovery routes: merge | replace | passthrough |
 * synthesize. Aliases 301-redirect to the canonical path; defaults cover
 * the common case-variants (SKILLS.md, skill.md, skills.md).
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { SKILL_NAME_MAX, slugify } from "../ard";

const BEGIN = "<!-- cf-webmcp:begin -->";
const END = "<!-- cf-webmcp:end -->";

export async function agentSkillsResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  const built = await buildBody(config, proxyToOrigin);
  if (built.kind === "relay") {
    // Origin returned something that is not markdown (or not a 200/404) in merge
    // mode; pass that same response through unchanged rather than overwrite
    // publisher content, and without asking origin a second time. The path is under
    // /.well-known/* so enforce the noindex tag even on the relayed response.
    return withNoindex(built.upstream);
  }
  const body = built.text;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": buildCacheControl({
        max_age: config.cache.agent_skills_max_age,
        s_maxage: config.cache.agent_skills_s_maxage,
        swr: config.cache.agent_skills_swr,
        sie: config.cache.agent_skills_sie,
      }),
      "x-content-type-options": "nosniff",
      // Agent-discovery surface served under /.well-known/, not search-engine
      // content. See docs/scope.md and the x-robots coverage test.
      "x-robots-tag": "noindex",
    },
  });
}

export function agentSkillsRedirect(config: Config): Response {
  return new Response(null, {
    status: 301,
    headers: {
      location: config.agent_skills.path,
      "cache-control": buildCacheControl({
        max_age: config.cache.agent_skills_redirect_max_age,
        s_maxage: config.cache.agent_skills_redirect_s_maxage,
      }),
      // Aliases live under /.well-known/agent-skills/; same noindex rule
      // as the canonical response.
      "x-robots-tag": "noindex",
    },
  });
}

/** What the merge step produced: the document to serve, or the origin response to relay as it came. */
type BuiltBody = { kind: "body"; text: string } | { kind: "relay"; upstream: Response };

async function buildBody(
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<BuiltBody> {
  const skillBody = buildSkillBody(config);

  if (config.agent_skills.mode === "synthesize" || config.agent_skills.mode === "replace") {
    return { kind: "body", text: buildFrontmatter(config) + skillBody };
  }

  // merge
  const target = new URL(config.agent_skills.path, config.origin.base_url);
  const upstream = await proxyToOrigin(target);
  if (upstream.status === 404) {
    return { kind: "body", text: buildFrontmatter(config) + skillBody };
  }
  if (upstream.status === 200 && isMarkdownish(upstream.headers.get("content-type"))) {
    const original = await upstream.text();
    return { kind: "body", text: mergeBlock(original, skillBody) };
  }
  // Non-markdown / non-200: hand the response itself back for the caller to relay.
  return { kind: "relay", upstream };
}

/**
 * Splice `<!-- cf-webmcp:begin --> ... <!-- cf-webmcp:end -->` into the
 * markdown body of an existing SKILL.md authored by the publisher.
 * If the marker is absent, append at end. Idempotent on re-run.
 *
 * Preserves the publisher's YAML frontmatter intact - they own the
 * canonical name/description of the skill in merge mode.
 */
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
 * The skill's name: [agent_skills].name when set (the schema holds it to the
 * Agent Skills name rule, 64 characters at most), else the slug of [site].name
 * cut to 64 characters, a hyphen left at the end trimmed. The one value used by
 * the synthesized SKILL.md frontmatter, the skills index entry and the ARD entry
 * identifier. The build refuses a config where this is empty and one of those
 * is served.
 */
export function skillName(config: Config): string {
  return config.agent_skills.name || slugify(config.site.name).slice(0, SKILL_NAME_MAX).replace(/-+$/, "");
}

export function buildFrontmatter(config: Config): string {
  const name = skillName(config);
  const description = config.agent_skills.description || config.site.description || `WebMCP-enabled site: ${config.site.name}`;
  // YAML frontmatter values are wrapped in double quotes to be defensive
  // against colons, hashes, leading whitespace, and unicode in site metadata.
  return `---\nname: ${yamlString(name)}\ndescription: ${yamlString(description)}\n---\n\n`;
}

/**
 * Build the SKILL.md body without frontmatter. Exported so build-config.ts
 * can compute the SHA-256 digest at build time for /.well-known/agent-skills/
 * index.json (Cloudflare Agent Skills Discovery RFC). Synthesize and replace
 * modes produce deterministic output from config; merge mode does not (origin
 * content is part of the served body), which is why the index handler returns
 * 404 when agent_skills.mode = "merge".
 */
export function buildSkillBody(config: Config): string {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const manifestUrl = `${base}${config.manifest.path}`;
  const landingUrl = `${base}${config.webmcp_landing.path}`;

  const lines: string[] = [
    `# ${config.site.name}`,
    ``,
    `## Tools available on this site`,
    ``,
    `Browser-native agents register these automatically via \`navigator.modelContext\` when the WebMCP runtime is present. Desktop MCP clients can pair at <${landingUrl}> and call the tools through the localhost bridge.`,
    ``,
  ];

  if (config.tools.length === 0 && config.forms.length === 0) {
    lines.push(`_No tools currently exposed._`);
  } else {
    for (const t of config.tools) {
      const sig = toolSignature(t);
      lines.push(`- \`${sig}\` - ${t.description}`);
    }
    for (const f of config.forms) {
      lines.push(`- \`${f.name}\` (form) - ${f.description}`);
    }
  }

  for (const hint of config.agent_skills.hints) {
    lines.push(``, `## ${hint.heading}`, ``, hint.body.trimEnd());
  }

  lines.push(``, `## Full machine-readable tool schema`, ``, `<${manifestUrl}>`, ``);

  return lines.join("\n");
}

function toolSignature(tool: { name: string; input_schema?: unknown }): string {
  // The properties subtype is recursive (z.lazy) in the Zod schema, so the
  // inferred runtime type is permissive. Read the few fields we need defensively.
  const schema = (tool.input_schema ?? {}) as {
    properties?: Record<string, unknown>;
    required?: unknown;
  };
  const props = schema.properties ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((x): x is string => typeof x === "string") : []);
  const params: string[] = [];
  for (const [name, propSchema] of Object.entries(props)) {
    const type = typeof propSchema === "object" && propSchema !== null && "type" in propSchema && typeof (propSchema as { type: unknown }).type === "string"
      ? (propSchema as { type: string }).type
      : "string";
    const suffix = required.has(name) ? "" : "?";
    params.push(`${name}${suffix}: ${type}`);
  }
  return `${tool.name}(${params.join(", ")})`;
}

function yamlString(s: string): string {
  // Double-quoted YAML scalar. Escape backslashes, double quotes, and the
  // common control chars that would otherwise produce malformed YAML when
  // a publisher's site.name or site.description contains LF/CR/TAB. Other
  // C0 controls (which should never appear in TOML strings anyway) are
  // emitted as \uXXXX so the scalar remains a single line.
  let escaped = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") escaped += "\\\\";
    else if (ch === '"') escaped += '\\"';
    else if (ch === "\n") escaped += "\\n";
    else if (ch === "\r") escaped += "\\r";
    else if (ch === "\t") escaped += "\\t";
    else if (code < 0x20 || code === 0x7f) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += ch;
    }
  }
  return `"${escaped}"`;
}

function isMarkdownish(ct: string | null): boolean {
  if (!ct) return true;
  return /^text\/(plain|markdown|x-markdown)/i.test(ct);
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
