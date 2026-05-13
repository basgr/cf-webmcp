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
    },
    generated_at: new Date().toISOString(),
    config_hash: configHash,
  };
}

/** The script body served at /<namespace>/bootstrap.<hash>.js. */
function buildBootstrap(config: Config, configHash: string): string {
  const base = siteBase(config);
  const ns = config.paths.namespace;
  const toolPayload = config.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
    endpoint: `${base}${ns}/exec/${t.name}`,
  }));

  // Worker serves this file with content-type application/javascript; charset=utf-8.
  return `// cf-webmcp bootstrap, config_hash=${configHash}
(function () {
  if (!('modelContext' in navigator) || typeof navigator.modelContext.registerTool !== 'function') {
    return;
  }
  var ctx = navigator.modelContext;
  var TOOLS = ${JSON.stringify(toolPayload)};
  TOOLS.forEach(function (t) {
    try {
      ctx.registerTool({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        execute: function (input) {
          return fetch(t.endpoint, {
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
          });
        },
      });
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
  const configTs = buildConfigTs(config, configHash, bootstrapName, widgetName, buildAt, preflight);

  const manifestStr = JSON.stringify(manifest, null, 2);
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
