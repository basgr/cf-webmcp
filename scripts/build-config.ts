/**
 * Compile webmcp.toml into TypeScript modules consumed by the Worker.
 *
 * Outputs (all under src/generated/, gitignored):
 *   - config.ts        Typed Config object.
 *   - manifest.json    Body for /.well-known/webmcp.json.
 *   - bootstrap.js     The script served at /<namespace>/bootstrap.<hash>.js.
 *   - landing.html     Body for /<webmcp_landing.path>.
 *   - hash.ts          Exports CONFIG_HASH so other modules can stamp ETags.
 *
 * Build refuses to emit if any check fails.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { ConfigSchema, type Config, type ToolConfig, type ExecutorConfig } from "../src/config-types.js";
import { compileTemplate } from "../src/mini-language.js";
import { buildFrontmatter, buildSkillBody } from "../src/routes/agent-skills.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "src", "generated");

interface BuildOptions {
  tomlPath: string;
  outDir: string;
}

async function readToml(filePath: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(filePath, "utf8");
  return TOML.parse(text) as Record<string, unknown>;
}

/**
 * Resolve `inherits = "wordpress.toml"`. Single-parent only, no chaining.
 * Top-level blocks in the child replace the parent block; tools merge by name.
 */
async function resolveInherits(
  raw: Record<string, unknown>,
  baseDir: string,
): Promise<Record<string, unknown>> {
  const inherits = raw["inherits"];
  if (!inherits) return raw;
  if (typeof inherits !== "string") {
    throw new Error(`[build-config] inherits must be a string, got ${typeof inherits}`);
  }
  const parentPath = path.resolve(baseDir, inherits);
  const parent = await readToml(parentPath);
  if ("inherits" in parent) {
    throw new Error(
      `[build-config] chained inheritance not allowed: ${inherits} also has inherits`,
    );
  }

  const merged: Record<string, unknown> = { ...parent };
  for (const [key, value] of Object.entries(raw)) {
    if (key === "inherits") continue;
    if (key === "tools" && Array.isArray(value) && Array.isArray(parent["tools"])) {
      const parentTools = parent["tools"] as Array<{ name?: string }>;
      const childTools = value as Array<{ name?: string }>;
      const childNames = new Set(childTools.map((t) => t.name));
      const merged_ = [
        ...parentTools.filter((t) => !childNames.has(t.name)),
        ...childTools,
      ];
      merged["tools"] = merged_;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Sample inputs that exercise every URL template against the allow-list.
 * The check is paranoid by design: if a template can ever resolve outside
 * allowed_origins, build fails.
 */
function checkAllowList(config: Config): void {
  const allowed = new Set(config.origin.allowed_origins.map((u) => new URL(u).origin));
  const probeInputs: Record<string, unknown>[] = [
    {}, // missing-everything path (tests defaults and optional)
    // single-attempt probe that fills every known param with an evil value
  ];

  for (const tool of config.tools) {
    if (
      tool.executor.type !== "dom_extract" &&
      tool.executor.type !== "http_json" &&
      tool.executor.type !== "http_get"
    ) {
      continue;
    }
    const template = tool.executor.url_template;
    const compiled = compileTemplate(template);

    // Build a probe input that fills every param with both a benign and a hostile value.
    const benign: Record<string, unknown> = {};
    const hostile: Record<string, unknown> = {};
    for (const p of compiled.params) {
      // Leading "/" so path-position params don't fuse with the host
      // (e.g. "https://example.com{{path}}" with path="x" → "example.comx").
      benign[p] = "/x";
      hostile[p] = "https://evil.example.com/";
    }

    const tries = [{}, benign, hostile, ...probeInputs];
    for (const input of tries) {
      let resolved: string;
      try {
        resolved = compiled.resolver(input);
      } catch {
        // Missing required params throw; that is fine, not an allow-list failure.
        continue;
      }
      let parsed: URL;
      try {
        parsed = new URL(resolved);
      } catch {
        // The probe input does not satisfy the runtime schema (e.g. failed a
        // pattern check). That is a runtime input-validation concern; not an
        // allow-list failure for the build to flag.
        continue;
      }
      if (!allowed.has(parsed.origin)) {
        throw new Error(
          `[build-config] tool "${tool.name}" url_template can resolve to origin ${parsed.origin} which is not in [origin].allowed_origins. ` +
            `Either add it to allowed_origins or restrict the template.`,
        );
      }
    }
  }
}

function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * Rough token-count estimate for a body cf-webmcp serves, used to annotate
 * llms.txt links with `(~N tokens)` context-budget hints. Deliberately a
 * dependency-free heuristic (~4 chars/token, rounded to a tidy multiple)
 * rather than a real tokenizer: these are budgeting hints for agents, not
 * billing figures, and we avoid pulling a tokenizer into the build.
 */
function estimateTokens(body: string): number {
  const raw = Math.round(body.length / 4);
  if (raw <= 0) return 10;
  // Round to nearest 10 (<1000) or 100 (>=1000) so the figure reads as the
  // estimate it is.
  const step = raw >= 1000 ? 100 : 10;
  return Math.max(step, Math.round(raw / step) * step);
}

interface ManifestTool {
  name: string;
  description: string;
  inputSchema: ToolConfig["input_schema"];
  endpoint: string;
  method: "POST";
  transport: "cf-webmcp/1";
}

interface Manifest {
  schema_version: 1;
  site: { domain: string; name: string; description: string };
  tools: ManifestTool[];
  links: {
    self: string;
    landing: string;
    bootstrap: string;
    health: string;
    api_catalog?: string;
    agent_skills?: string;
    agent_skills_index?: string;
  };
  generated_at: string;
  config_hash: string;
}

function siteBase(config: Config): string {
  return config.site.public_url ?? `https://${config.site.domain}`;
}

function buildManifest(config: Config, configHash: string, bootstrapName: string): Manifest {
  const base = siteBase(config);
  const ns = config.paths.namespace;
  return {
    schema_version: 1,
    site: {
      domain: config.site.domain,
      name: config.site.name,
      description: config.site.description,
    },
    tools: config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.input_schema,
      endpoint: `${base}${ns}/exec/${t.name}`,
      method: "POST",
      transport: "cf-webmcp/1",
    })),
    links: {
      self: `${base}${config.manifest.path}`,
      landing: `${base}${config.webmcp_landing.path}`,
      bootstrap: `${base}${ns}/${bootstrapName}`,
      health: `${base}${ns}/health`,
      ...(config.features.api_catalog && config.api_catalog.mode !== "passthrough"
        ? { api_catalog: `${base}${config.api_catalog.path}` }
        : {}),
      ...(config.features.agent_skills && config.agent_skills.mode !== "passthrough"
        ? { agent_skills: `${base}${config.agent_skills.path}` }
        : {}),
      ...(config.features.agent_skills_index &&
      config.agent_skills_index.mode !== "passthrough" &&
      (config.agent_skills.mode === "synthesize" || config.agent_skills.mode === "replace")
        ? { agent_skills_index: `${base}${config.agent_skills_index.path}` }
        : {}),
    },
    generated_at: new Date().toISOString(),
    config_hash: configHash,
  };
}

/** The script body served at /<namespace>/bootstrap.<hash>.js. */
/**
 * Per-executor-type defaults for the WebMCP ToolAnnotations dictionary.
 *
 * All five executor types are read-only (none mutate origin state), so
 * readOnlyHint defaults to true across the board. untrustedContentHint
 * varies: sitemap_filter returns URL + lastmod strings (structurally
 * constrained, low free-form-content risk), the other four surface
 * origin-fetched content that an agent should treat with the usual
 * untrusted-content care.
 *
 * Publishers can override either field per-tool via `[tools.annotations]`.
 */
function defaultAnnotationsFor(executorType: string): { readOnlyHint: boolean; untrustedContentHint: boolean } {
  switch (executorType) {
    case "sitemap_filter":
      return { readOnlyHint: true, untrustedContentHint: false };
    case "rss_feed":
    case "dom_extract":
    case "http_json":
    case "http_get":
      return { readOnlyHint: true, untrustedContentHint: true };
    default:
      return { readOnlyHint: false, untrustedContentHint: true };
  }
}

function buildBootstrap(config: Config, configHash: string): string {
  const base = siteBase(config);
  const ns = config.paths.namespace;
  const toolPayload = config.tools.map((t) => {
    const defaults = defaultAnnotationsFor(t.executor.type);
    const override = t.annotations ?? {};
    const annotations = {
      readOnlyHint: override.read_only_hint ?? defaults.readOnlyHint,
      untrustedContentHint: override.untrusted_content_hint ?? defaults.untrustedContentHint,
    };
    return {
      name: t.name,
      ...(t.title !== undefined ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.input_schema,
      annotations,
      endpoint: `${base}${ns}/exec/${t.name}`,
    };
  });

  // Worker serves this file with content-type application/javascript; charset=utf-8.
  // ES5 style for maximum browser reach (no arrow fns / spread).
  return `// cf-webmcp bootstrap, config_hash=${configHash}
(function () {
  // Host object: navigator.modelContext (current Chrome Canary) or
  // document.modelContext (the Apr 2026 WebMCP draft). Use whichever exposes
  // registerTool; same tool shape on both.
  var ctx = null;
  if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') {
    ctx = navigator.modelContext;
  } else if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.registerTool === 'function') {
    ctx = document.modelContext;
  }
  if (!ctx) return;
  var TOOLS = ${JSON.stringify(toolPayload)};
  // Returns the WebMCP/MCP tool-result shape: a content array. The cf-webmcp
  // executor envelope ({ ok, data | error }) is carried as the text payload so
  // the agent retains structured success/error, and isError is set unless the
  // envelope is an explicit ok:true.
  function run(endpoint, input) {
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input || {}),
      credentials: 'omit',
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: { code: 'internal', message: 'invalid json from executor', retriable: false } };
      });
    }).catch(function (e) {
      return { ok: false, error: { code: 'internal', message: String(e && e.message || e), retriable: true } };
    }).then(function (envelope) {
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        // Anything that is not an explicit ok:true counts as an error, so a
        // structurally-broken envelope is never silently surfaced as success.
        isError: !(envelope && envelope.ok === true),
      };
    });
  }
  TOOLS.forEach(function (t) {
    try {
      var toolDef = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
        execute: function (input) { return run(t.endpoint, input); },
      };
      if (t.title) toolDef.title = t.title;
      ctx.registerTool(toolDef);
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('cf-webmcp: failed to register tool', t.name, e);
      }
    }
  });
})();
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The landing page served at /<webmcp_landing.path>.
 *
 * Loads an HTML template (default: `templates/landing.default.html`) and
 * substitutes `{{placeholder}}` tokens. Publishers can override the template
 * via `[webmcp_landing].template = "path/to/custom.html"` in their TOML
 * (path resolved relative to the TOML file location).
 *
 * Available placeholders:
 *   {{lang}}              - config.site.locale (HTML-escaped)
 *   {{site_name}}         - config.site.name (HTML-escaped)
 *   {{site_description}}  - config.site.description (HTML-escaped)
 *   {{config_hash}}       - build-time hash
 *   {{tool_list}}         - pre-rendered <li>...</li> sequence
 *   {{widget_block}}      - the widget mount + script tag (empty if disabled)
 *   {{widget_enabled_js}} - literal "true" or "false" for inline JS
 *
 * The runtime state-branching JS in the template is what selects which
 * state-* div becomes visible. As long as the override template keeps the
 * three state divs and the closing inline script, the branching keeps working.
 */
async function buildLanding(
  config: Config,
  configHash: string,
  widgetName: string,
  tomlPath: string,
): Promise<string> {
  const ns = config.paths.namespace;
  const widgetUrl = `${ns}/${widgetName}`;
  const toolList = config.tools
    .map(
      (t) =>
        `<li><code>${escapeHtml(t.name)}</code> - ${escapeHtml(t.description)}</li>`,
    )
    .join("");
  const showWidget = config.features.fallback_widget;
  const widgetBlock = showWidget
    ? `<div id="webmcp-widget-mount"></div><script src="${escapeHtml(widgetUrl)}" defer></script>`
    : "";

  const templatePath = config.webmcp_landing.template
    ? path.resolve(path.dirname(tomlPath), config.webmcp_landing.template)
    : path.join(ROOT, "templates", "landing.default.html");

  let templateSrc: string;
  try {
    templateSrc = await fs.readFile(templatePath, "utf8");
  } catch (e) {
    throw new Error(
      `[build-config] landing template not found at ${templatePath}: ${(e as Error).message}`,
    );
  }

  const vars: Record<string, string> = {
    lang: escapeHtml(config.site.locale),
    site_name: escapeHtml(config.site.name),
    site_description: escapeHtml(config.site.description),
    config_hash: configHash,
    tool_list: toolList,
    widget_block: widgetBlock,
    widget_enabled_js: showWidget ? "true" : "false",
  };

  return templateSrc.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, name: string) => {
    if (!(name in vars)) {
      throw new Error(`[build-config] landing template references unknown placeholder "{{${name}}}"`);
    }
    return vars[name]!;
  });
}

interface PreflightResult {
  ran_at: string | null;
  collisions: string[];
  warnings: string[];
  config_hash?: string;
}

function buildConfigTs(
  config: Config,
  configHash: string,
  bootstrapName: string,
  widgetName: string,
  buildAt: string,
  preflight: PreflightResult,
  agentSkillsDigest: string | null,
  bootstrapSri: string | null,
  llmsTxtTokenHints: { manifest: number; landing: number },
): string {
  // Plain JSON dump plus the derived hash and asset names.
  const json = JSON.stringify(config, null, 2);
  return `// Auto-generated by scripts/build-config.ts. Do not edit.
/* eslint-disable */
import type { Config } from "../config-types";

export const CONFIG_HASH = ${JSON.stringify(configHash)};
export const BOOTSTRAP_ASSET = ${JSON.stringify(bootstrapName)};
export const WIDGET_ASSET = ${JSON.stringify(widgetName)};
/**
 * Build-time UTC timestamp. Used by /_webmcp/health for deployed_at.
 * cf-webmcp emits this at build time because Cloudflare Workers freeze
 * Date.now() to 0 during module-init for security reasons - reading a
 * runtime new Date() at top-level would return 1970-01-01.
 */
export const BUILD_AT = ${JSON.stringify(buildAt)};
/**
 * Last preflight result (if scripts/preflight.ts has run since the last
 * build). Worker surfaces this on /_webmcp/health. ran_at is null when
 * no preflight result has been recorded.
 */
export const PREFLIGHT: { ran_at: string | null; collisions: string[]; warnings: string[]; config_hash?: string } = ${JSON.stringify(preflight)};
/**
 * SHA-256 digest of the synthesised SKILL.md body (frontmatter + body),
 * formatted as "sha256:{64hex}" per the Cloudflare Agent Skills Discovery
 * RFC v0.2.0. Computed at build time so /.well-known/agent-skills/index.json
 * can include it without runtime hashing. null when agent_skills.mode is
 * "merge" (digest would not match the served body that mixes in origin
 * content) or when the feature is disabled.
 */
export const AGENT_SKILLS_DIGEST: string | null = ${JSON.stringify(agentSkillsDigest)};
/**
 * Subresource Integrity hash for the bootstrap.<hash>.js body, formatted
 * as "sha384-<base64>". Set on the injected <script integrity="..."> tag
 * so a browser refuses to execute the bootstrap if its body has been
 * substituted between server and client (CDN cache poisoning, MITM on a
 * non-HTTPS leg, intermediary tampering).
 *
 * null when [features].subresource_integrity = false. Browser falls back
 * to plain HTTPS integrity in that case.
 */
export const BOOTSTRAP_SRI: string | null = ${JSON.stringify(bootstrapSri)};
/**
 * Approximate token counts (build-time heuristic, ~4 chars/token) for the
 * documents the synthesised /llms.txt block links to. Used to annotate those
 * links with \`(~N tokens)\` context-budget hints. Only the manifest (tool
 * catalogue) and landing (pairing page) are covered because their bodies are
 * generated and embedded at build time; agents.md and api-catalog are
 * synthesised at request time and are thin pointer documents, so their
 * links stay unannotated.
 */
export const LLMS_TXT_TOKEN_HINTS: { manifest: number; landing: number } = ${JSON.stringify(llmsTxtTokenHints)};

export const config: Config = ${json};
`;
}

/**
 * Read the last preflight result if `scripts/preflight.ts` wrote one. If the
 * recorded `config_hash` does not match the current config hash, surface a
 * stale-result warning but still embed (with the warning) so operators can
 * see that preflight was run against a different config and re-run if needed.
 */
async function loadPreflightResult(outDir: string, currentConfigHash: string): Promise<PreflightResult> {
  const file = path.join(outDir, "preflight.json");
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as PreflightResult;
    if (typeof parsed.ran_at !== "string") return EMPTY_PREFLIGHT;
    const result: PreflightResult = {
      ran_at: parsed.ran_at,
      collisions: Array.isArray(parsed.collisions) ? parsed.collisions : [],
      warnings: Array.isArray(parsed.warnings) ? parsed.warnings.slice() : [],
      config_hash: typeof parsed.config_hash === "string" ? parsed.config_hash : undefined,
    };
    if (result.config_hash && result.config_hash !== currentConfigHash) {
      result.warnings.push(
        `preflight result is stale: ran against config_hash=${result.config_hash}, current build is ${currentConfigHash}. Re-run \`npm run preflight\` before deploy.`,
      );
    }
    return result;
  } catch {
    return EMPTY_PREFLIGHT;
  }
}

const EMPTY_PREFLIGHT: PreflightResult = { ran_at: null, collisions: [], warnings: [] };

/**
 * Compute the SHA-256 digest of the SKILL.md body cf-webmcp will serve at
 * runtime, formatted per Cloudflare Agent Skills Discovery RFC v0.2.0
 * (`sha256:{64hex}`). Returns null when the digest would be unstable or
 * unwanted:
 *   - feature disabled
 *   - agent_skills_index mode is passthrough
 *   - agent_skills mode is merge (origin content is part of the body)
 *   - agent_skills mode is passthrough (we do not serve the SKILL.md)
 */
/**
 * Refuse builds where two cf-webmcp surfaces are configured to the same
 * path. Router uses first-match semantics, so colliding paths cause the
 * second-listed surface to silently never serve. Catches publisher
 * misconfiguration at build time rather than at production smoke.
 */
function checkPathCollisions(config: Config): void {
  const claimed: Array<{ name: string; path: string }> = [];
  if (config.features.manifest) {
    claimed.push({ name: "manifest", path: config.manifest.path });
    for (const a of config.manifest.aliases) {
      if (a !== config.manifest.path) claimed.push({ name: "manifest.alias", path: a });
    }
  }
  if (config.features.webmcp_landing) claimed.push({ name: "webmcp_landing", path: config.webmcp_landing.path });
  if (config.features.llms_txt && config.llms_txt.mode !== "passthrough") claimed.push({ name: "llms_txt", path: config.llms_txt.path });
  if (config.features.robots_txt && config.robots_txt.mode !== "passthrough") claimed.push({ name: "robots_txt", path: config.robots_txt.path });
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    claimed.push({ name: "agents_md", path: config.agents_md.path });
    for (const a of config.agents_md.aliases) claimed.push({ name: "agents_md.alias", path: a });
  }
  if (config.features.api_catalog && config.api_catalog.mode !== "passthrough") {
    claimed.push({ name: "api_catalog", path: config.api_catalog.path });
  }
  if (config.features.agent_skills && config.agent_skills.mode !== "passthrough") {
    claimed.push({ name: "agent_skills", path: config.agent_skills.path });
    for (const a of config.agent_skills.aliases) claimed.push({ name: "agent_skills.alias", path: a });
  }
  if (config.features.agent_skills_index && config.agent_skills_index.mode !== "passthrough") {
    claimed.push({ name: "agent_skills_index", path: config.agent_skills_index.path });
  }
  const seen = new Map<string, string>();
  for (const c of claimed) {
    const existing = seen.get(c.path);
    if (existing) {
      throw new Error(
        `[build-config] path collision: both "${existing}" and "${c.name}" are configured to claim ${c.path}. ` +
          `Router uses first-match semantics; one surface would silently never serve. Reconfigure one of the paths.`,
      );
    }
    seen.set(c.path, c.name);
  }
}

/**
 * Compute the Subresource Integrity hash for the bootstrap body in the
 * "sha384-<base64>" format browsers accept on `<script integrity="...">`.
 * Returns null when [features].subresource_integrity is false so the
 * worker can omit the attribute and crossorigin pairing cleanly.
 */
function computeBootstrapSri(config: Config, bootstrap: string): string | null {
  if (!config.features.subresource_integrity) return null;
  // The bootstrap is served as application/javascript; charset=utf-8, so
  // the hash MUST be over the exact bytes the worker emits. We hash the
  // utf-8 encoding of the source string.
  const b64 = createHash("sha384").update(bootstrap, "utf8").digest("base64");
  return `sha384-${b64}`;
}

async function computeAgentSkillsDigest(config: Config): Promise<string | null> {
  if (!config.features.agent_skills_index) return null;
  if (config.agent_skills_index.mode === "passthrough") return null;
  if (config.agent_skills.mode === "merge" || config.agent_skills.mode === "passthrough") return null;
  const body = buildFrontmatter(config) + buildSkillBody(config);
  const hex = createHash("sha256").update(body).digest("hex");
  return `sha256:${hex}`;
}

export async function buildConfig(opts: BuildOptions): Promise<void> {
  const baseDir = path.dirname(opts.tomlPath);
  const rawIn = await readToml(opts.tomlPath);
  const merged = await resolveInherits(rawIn, baseDir);

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`[build-config] config validation failed:\n${issues}`);
  }
  const config = parsed.data;

  // Compile every url_template to surface mini-language errors at build time,
  // and check allow-list.
  for (const tool of config.tools) {
    if (
      tool.executor.type === "dom_extract" ||
      tool.executor.type === "http_json" ||
      tool.executor.type === "http_get"
    ) {
      compileTemplate(tool.executor.url_template); // throws on bad template
    }
  }
  checkAllowList(config);
  checkPathCollisions(config);

  const canonical = JSON.stringify(config); // deterministic enough
  const configHash = computeHash(canonical);
  const bootstrapName = `bootstrap.${configHash}.js`;
  // Widget file name is fixed at update-widget time and recorded later.
  // For now, expose the hash-based slot the worker will read from R2.
  const widgetName = `widget.${configHash}.js`;

  const manifest = buildManifest(config, configHash, bootstrapName);
  const bootstrap = buildBootstrap(config, configHash);
  const landing = await buildLanding(config, configHash, widgetName, opts.tomlPath);
  const buildAt = new Date().toISOString();
  const preflight = await loadPreflightResult(opts.outDir, configHash);
  const agentSkillsDigest = await computeAgentSkillsDigest(config);
  const bootstrapSri = computeBootstrapSri(config, bootstrap);
  const manifestStr = JSON.stringify(manifest, null, 2);
  // Token-budget hints for the /llms.txt links, computed over the exact
  // bodies the worker serves at those paths.
  const llmsTxtTokenHints = {
    manifest: estimateTokens(manifestStr),
    landing: estimateTokens(landing),
  };
  const configTs = buildConfigTs(config, configHash, bootstrapName, widgetName, buildAt, preflight, agentSkillsDigest, bootstrapSri, llmsTxtTokenHints);

  const assetsTs = `// Auto-generated by scripts/build-config.ts. Do not edit.
/* eslint-disable */

export const BOOTSTRAP_JS: string = ${JSON.stringify(bootstrap)};
export const LANDING_HTML: string = ${JSON.stringify(landing)};
export const MANIFEST_JSON: string = ${JSON.stringify(manifestStr)};
`;

  await fs.mkdir(opts.outDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(opts.outDir, "manifest.json"), manifestStr),
    fs.writeFile(path.join(opts.outDir, "bootstrap.js"), bootstrap),
    fs.writeFile(path.join(opts.outDir, "landing.html"), landing),
    fs.writeFile(path.join(opts.outDir, "config.ts"), configTs),
    fs.writeFile(path.join(opts.outDir, "assets.ts"), assetsTs),
    fs.writeFile(
      path.join(opts.outDir, "hash.ts"),
      `export const CONFIG_HASH = ${JSON.stringify(configHash)};\nexport const BOOTSTRAP_ASSET = ${JSON.stringify(bootstrapName)};\nexport const WIDGET_ASSET = ${JSON.stringify(widgetName)};\n`,
    ),
  ]);

  // eslint-disable-next-line no-console
  console.log(
    `[build-config] OK, hash=${configHash}, tools=${config.tools.length}, output=${path.relative(ROOT, opts.outDir)}`,
  );
}

// CLI entry.
async function main(): Promise<void> {
  const tomlPath = path.resolve(process.env["CF_WEBMCP_CONFIG"] ?? path.join(ROOT, "webmcp.toml"));
  try {
    await fs.access(tomlPath);
  } catch {
    // Fallback to the default template for CI smoke builds.
    const fallback = path.join(ROOT, "templates", "default.toml");
    // eslint-disable-next-line no-console
    console.warn(`[build-config] ${tomlPath} not found, falling back to ${fallback}`);
    await buildConfig({ tomlPath: fallback, outDir: OUT_DIR });
    return;
  }
  await buildConfig({ tomlPath, outDir: OUT_DIR });
}

const __thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __thisFile) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
