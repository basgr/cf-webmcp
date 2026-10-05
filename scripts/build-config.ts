/**
 * Compile webmcp.toml into TypeScript modules consumed by the Worker.
 *
 * Outputs (all under src/generated/, gitignored):
 *   - config.ts        Typed Config object.
 *   - manifest.json    Body for /.well-known/webmcp.json.
 *   - bootstrap.js     The script served at /<namespace>/bootstrap.<hash>.js, where
 *                      <hash> is the first 16 hex of the sha256 of these exact bytes.
 *   - landing.html     Body for /<webmcp_landing.path>.
 *   - hash.ts          Exports CONFIG_HASH and the asset names.
 *
 * Both served assets are content-addressed so immutable caching and the SRI
 * `integrity` attribute always describe the same bytes:
 *   - bootstrap.<sha256(bootstrap) 16 hex>.js, computed from the generated body;
 *   - widget.<served_sha256 16 hex>.js, read from vendor/webmcp/current.json
 *     (the build never looks at the vendored widget file itself).
 * CONFIG_HASH stays a hash of the config alone: preflight recomputes it from the TOML.
 * The ETags of the generated documents (MANIFEST_ETAG, LANDING_ETAG, ARD_ETAG) are hashes
 * of their own bytes, and INJECTION_HASH covers what shapes the injected HTML.
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
import { decodeOriginTrialToken, type OriginTrialPayload } from "../src/origin-trial.js";
import { buildFrontmatter, buildSkillBody, skillName } from "../src/routes/agent-skills.js";
import {
  ARD_PATH,
  ARD_PREDECESSOR_PATH,
  ARD_REL,
  didWeb,
  publisherProblem,
  siteHost,
  sitePublisher,
  urnAir,
} from "../src/ard.js";
import { LICENSE_PREAMBLE } from "../src/widget-preamble.js";
import { widgetEnabled } from "../src/widget-state.js";
import { apiCatalogServed, skillsIndexServed } from "../src/served.js";
import { formToolsStamped } from "../src/runtime-copy.js";
import { cachesResults } from "../src/tool-cache.js";
import { configLinkOptions } from "../src/injection/html-rewriter.js";
import { bridgeNpmVersion, sha256Hex, widgetAssetName } from "./widget-pin.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "src", "generated");
const DEFAULT_WIDGET_PIN_PATH = path.join(ROOT, "vendor", "webmcp", "current.json");

interface BuildOptions {
  tomlPath: string;
  outDir: string;
  /** Widget pin to read (default vendor/webmcp/current.json). Overridable for tests. */
  widgetPinPath?: string;
  /** The clock the [origin_trial] expiry checks read (default: now). Overridable for tests. */
  now?: Date;
}

async function readToml(filePath: string): Promise<Record<string, unknown>> {
  const text = await fs.readFile(filePath, "utf8");
  return TOML.parse(text) as Record<string, unknown>;
}

/**
 * Resolve `inherits = "wordpress.toml"`. Single-parent only, no chaining.
 * Top-level blocks in the child replace the parent block; tools merge by name.
 * Exported so scripts/preflight.ts reads the same merged config the build does.
 */
export async function resolveInherits(
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
 * Property names that every JavaScript object already has. An input property called one of these
 * cannot be told from the inherited member (an input's `constructor` is the Object function), and
 * `__proto__` is the prototype chain itself; the schema layer drops a `__proto__` key without a word.
 */
const RESERVED_PROPERTY_NAMES: readonly string[] = ["__proto__", "constructor", "prototype"];

/**
 * Refuse a tool whose input_schema declares (or requires) a reserved property name. It runs on the
 * resolved TOML before the schema parse, because the schema drops a `__proto__` key silently and
 * the refusal must name it. Every offender is reported at once.
 */
function checkReservedPropertyNames(raw: Record<string, unknown>): void {
  const tools = raw["tools"];
  if (!Array.isArray(tools)) return;
  const problems: string[] = [];
  tools.forEach((tool, i) => {
    if (typeof tool !== "object" || tool === null) return;
    const t = tool as Record<string, unknown>;
    const label = typeof t["name"] === "string" ? `tool "${t["name"]}"` : `tools[${i}]`;
    const schema = t["input_schema"];
    if (typeof schema !== "object" || schema === null) return;
    const s = schema as Record<string, unknown>;
    const properties = s["properties"];
    if (typeof properties === "object" && properties !== null) {
      for (const name of Object.keys(properties)) {
        if (RESERVED_PROPERTY_NAMES.includes(name)) problems.push(`${label} input_schema.properties declares "${name}"`);
      }
    }
    const required = s["required"];
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === "string" && RESERVED_PROPERTY_NAMES.includes(name)) {
          problems.push(`${label} input_schema.required lists "${name}"`);
        }
      }
    }
  });
  if (problems.length === 0) return;
  throw new Error(
    `[build-config] reserved property name in input_schema: ${problems.join("; ")}. Every JavaScript object already has ` +
      `${RESERVED_PROPERTY_NAMES.map((n) => `"${n}"`).join(", ")}, so an input property of that name cannot be told from the inherited member ` +
      `and an input built from it could carry a polluted prototype to origin. Rename the property.`,
  );
}

/**
 * Refuse a tool whose executor reads an input name the tool does not declare in
 * input_schema.properties. Only declared properties reach an executor (the exec route passes
 * declaredProperties of the validated input, and keys its cache on the same), so a name that is
 * not declared could never be set, and a url_template placeholder would always be missing. The
 * executors read input in two ways: through the placeholders of a url_template (dom_extract,
 * http_json, http_get) and, for sitemap_filter, through the one field `query` (a tool that does not
 * declare it lists the sitemap without filtering, which is a legitimate tool, so that is a warning:
 * declaredInputWarnings). rss_feed reads none. Every offender is reported at once.
 */
function checkDeclaredInputs(config: Config): void {
  const problems: string[] = [];
  for (const tool of config.tools) {
    const declared = (name: string): boolean => Object.prototype.hasOwnProperty.call(tool.input_schema.properties, name);
    const executor = tool.executor;
    if (executor.type === "dom_extract" || executor.type === "http_json" || executor.type === "http_get") {
      for (const name of compileTemplate(executor.url_template).params) {
        if (!declared(name)) problems.push(`tool "${tool.name}" (${executor.type}) has the url_template placeholder {{${name}}}`);
      }
    }
  }
  if (problems.length === 0) return;
  throw new Error(
    `[build-config] undeclared input name: ${problems.join("; ")}, and input_schema.properties does not declare it. ` +
      `Only declared properties reach an executor, so it could never be set. Declare it under [tools.input_schema.properties.<name>].`,
  );
}

/**
 * A sitemap_filter tool filters on the input name `query`, which only reaches it when the tool
 * declares it. Before only declared properties reached executors, an undeclared `query` that a
 * caller sent was read anyway; now it is dropped, so such a tool lists the sitemap without
 * filtering. That is exactly what a listing tool wants and exactly what a forgotten declaration
 * looks like, so the build says it once per tool instead of refusing.
 */
export function declaredInputWarnings(config: Config): string[] {
  return config.tools
    .filter((t) => t.executor.type === "sitemap_filter" && !Object.prototype.hasOwnProperty.call(t.input_schema.properties, "query"))
    .map(
      (t) =>
        `[build-config] tool "${t.name}" (sitemap_filter) does not declare the input property "query", so it lists the sitemap without filtering ` +
        `(a caller's undeclared query is dropped, as is every undeclared property). Declare [tools.input_schema.properties.query] if it should filter.`,
    );
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

/**
 * Refuse a [origin].base_url whose origin is not in [origin].allowed_origins. The Worker
 * requests only listed origins for the merge routes and never sends the deploy token
 * anywhere else, so with base_url off the list every merge route (llms.txt, robots.txt,
 * agents.md, the catalogs, SKILL.md in merge mode) would answer 502. Compared by origin,
 * so a path, a trailing slash, letter case or a default port make no difference.
 */
function checkBaseUrlAllowed(config: Config): void {
  const base = new URL(config.origin.base_url).origin;
  const allowed = config.origin.allowed_origins.map((u) => new URL(u).origin);
  if (allowed.includes(base)) return;
  throw new Error(
    `[build-config] [origin].base_url ${JSON.stringify(config.origin.base_url)} (origin ${base}) is not in ` +
      `[origin].allowed_origins ${JSON.stringify(config.origin.allowed_origins)}. The Worker only requests listed origins ` +
      `for the merge routes and only sends the deploy token there, so they would all answer 502. Add ${base} to allowed_origins.`,
  );
}

function computeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

/**
 * The strong ETag of a body the Worker serves from this build: the first 16 hex of the
 * sha256 of its exact (UTF-8) bytes, in quotes. Any change to the bytes moves it, whether
 * it came from the TOML, the widget pin or a cf-webmcp upgrade; nothing else does.
 */
function bodyEtag(body: string): string {
  return `"${sha256Hex(body).slice(0, 16)}"`;
}

/** What INJECTION_HASH covers besides the config: values the build derives or reads elsewhere. */
export interface InjectionHashInputs {
  /** cf-webmcp's version from package.json: a release may change how pages are rewritten. */
  version: string;
  /** The script src (bootstrap.<sha16>.js). */
  bootstrapAsset: string;
  /** The script's integrity attribute, null when [features].subresource_integrity is off. */
  bootstrapSri: string | null;
  /**
   * rewriterSourceHash of src/injection/html-rewriter.ts: a change to the rewriter's code
   * changes the rewritten pages even when the version is not bumped.
   */
  rewriterSha256: string;
  /**
   * The values html-rewriter.ts imports from other modules, by name (REWRITER_IMPORTS):
   * its source hash does not see them, but they are written into the injected tags.
   */
  rewriterImports: Record<string, string>;
}

/** The rewriter source the build hashes into INJECTION_HASH. */
const REWRITER_SOURCE = path.join(ROOT, "src", "injection", "html-rewriter.ts");

/**
 * Every value html-rewriter.ts imports from another module (a test keeps this list in
 * step with its import lines). ARD_REL is the rel of the ARD <link> tag. The other rel
 * values and media types of the injected tags are literals in html-rewriter.ts itself,
 * covered by its source hash.
 */
export const REWRITER_IMPORTS: Record<string, string> = { ARD_REL };

/**
 * sha256 (64 hex) of a source text with CRLF line endings read as LF, so a Windows
 * checkout (core.autocrlf) and a Linux one of the same commit hash alike.
 */
export function rewriterSourceHash(text: string): string {
  return sha256Hex(text.replace(/\r\n/g, "\n"));
}

/**
 * INJECTION_HASH: the first 16 hex of the sha256 over everything that shapes what the
 * Worker does to a proxied page, so the ETag suffix of rewritten pages moves exactly
 * when the rewritten output can:
 *   - the inputs above (version, script src and integrity, rewriter source and the
 *     values it imports);
 *   - [features].inject_html and [injection].exclude_paths: whether a page is rewritten;
 *   - [paths].namespace: the script src path;
 *   - the <link> tags as configLinkOptions builds them for the handler: [features].link_tag,
 *     and for the manifest, API catalog, ARD manifest, SKILL.md and llms.txt the feature
 *     flag, mode and path, all on the site URL ([site].public_url, else [site].domain);
 *   - [[forms]], whole: names, descriptions, selectors, params, paths and autosubmit;
 *   - [origin_trial].tokens, which go out on rewritten pages as Origin-Trial headers.
 * No other config field, and not the widget: neither the bootstrap nor the injected page
 * names it. A config field the injected page does not show (cache TTLs, rate limits, CORS,
 * health, the site's name and description, the other routes' settings) must not make every
 * visitor refetch every page. [[tools]] reach the page through the bootstrap file name,
 * which is addressed by the bootstrap's content alone and so moves only when a tool, the
 * namespace or the generator changes.
 */
export function injectionHashOf(config: Config, inputs: InjectionHashInputs): string {
  return sha256Hex(
    JSON.stringify({
      version: inputs.version,
      bootstrap_asset: inputs.bootstrapAsset,
      bootstrap_sri: inputs.bootstrapSri,
      rewriter_sha256: inputs.rewriterSha256,
      rewriter_imports: inputs.rewriterImports,
      inject_html: config.features.inject_html,
      exclude_paths: config.injection.exclude_paths,
      namespace: config.paths.namespace,
      links: configLinkOptions(config),
      forms: config.forms,
      origin_trial_tokens: config.origin_trial.tokens,
    }),
  ).slice(0, 16);
}

/** cf-webmcp's own version, from package.json. */
async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, "package.json"), "utf8")) as { version?: unknown };
  if (typeof pkg.version !== "string") throw new Error("[build-config] package.json has no version");
  return pkg.version;
}

/**
 * CONFIG_HASH: the first 8 hex of the sha256 of the validated, inheritance-resolved
 * config. Exported so scripts/preflight.ts stamps its result with the very same
 * function; a preflight hash that differs from the build's marks the result stale.
 */
export function configHashOf(config: Config): string {
  return computeHash(JSON.stringify(config));
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
    /** Absent while [features].webmcp_landing is off: there is no landing page to point at. */
    landing?: string;
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
      ...(config.features.webmcp_landing ? { landing: `${base}${config.webmcp_landing.path}` } : {}),
      bootstrap: `${base}${ns}/${bootstrapName}`,
      health: `${base}${ns}/health`,
      ...(apiCatalogServed(config)
        ? { api_catalog: `${base}${config.api_catalog.path}` }
        : {}),
      ...(config.features.agent_skills && config.agent_skills.mode !== "passthrough"
        ? { agent_skills: `${base}${config.agent_skills.path}` }
        : {}),
      ...(skillsIndexServed(config)
        ? { agent_skills_index: `${base}${config.agent_skills_index.path}` }
        : {}),
    },
    generated_at: new Date().toISOString(),
    config_hash: configHash,
  };
}

/**
 * Per-executor-type defaults for the WebMCP ToolAnnotations dictionary.
 *
 * The executors read: sitemap_filter, rss_feed, dom_extract, http_get and an http_json
 * GET do not mutate origin state, so readOnlyHint defaults to true and consequentialHint
 * (Chrome's "this call may not be undoable") to false for them. An http_json POST sends the
 * tool input to origin as a request body, and what origin does with it is unknown: it
 * defaults to readOnlyHint false and consequentialHint true. untrustedContentHint
 * varies: sitemap_filter returns URL + lastmod strings (structurally
 * constrained, low free-form-content risk), the other four surface
 * origin-fetched content that an agent should treat with the usual
 * untrusted-content care. An executor type this table does not know is assumed
 * to write: not read-only, consequential.
 *
 * Publishers can override each field per-tool via `[tools.annotations]`.
 * Exported for the build tests.
 */
export function defaultAnnotationsFor(
  executorType: string,
  method?: string,
): {
  readOnlyHint: boolean;
  untrustedContentHint: boolean;
  consequentialHint: boolean;
} {
  switch (executorType) {
    case "sitemap_filter":
      return { readOnlyHint: true, untrustedContentHint: false, consequentialHint: false };
    case "http_json":
      // `method` is the executor's: GET (the default) reads, POST sends a body.
      return method === "POST"
        ? { readOnlyHint: false, untrustedContentHint: true, consequentialHint: true }
        : { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false };
    case "rss_feed":
    case "dom_extract":
    case "http_get":
      return { readOnlyHint: true, untrustedContentHint: true, consequentialHint: false };
    default:
      return { readOnlyHint: false, untrustedContentHint: true, consequentialHint: true };
  }
}

/**
 * A value as a JavaScript literal: its JSON. U+2028 and U+2029 are legal raw in a JSON string
 * but end a line in a JavaScript string literal before ES2019, so a tool description that holds
 * one would be a syntax error on an older engine. Both go out as escapes. (Built from char
 * codes: the escapes themselves must not appear as raw characters in this source.)
 */
function jsLiteral(value: unknown): string {
  const backslash = String.fromCharCode(92);
  return JSON.stringify(value)
    .split(String.fromCharCode(0x2028))
    .join(backslash + "u2028")
    .split(String.fromCharCode(0x2029))
    .join(backslash + "u2029");
}

/**
 * jsLiteral for a value written into an inline <script> of an HTML page. The HTML parser ends
 * the element at the first `</script`, whatever JavaScript string it sits in, and after a `<!--`
 * a `<script` inside makes it skip the next end tag. So `</` goes out as `<\/` and `<!--` as
 * `<\!--`: inside a JavaScript string both escapes read as the characters they replace. Every
 * `<` in JSON text is inside a string, so no other token changes.
 */
function inlineScriptLiteral(value: unknown): string {
  const backslash = String.fromCharCode(92);
  return jsLiteral(value)
    .split("</")
    .join("<" + backslash + "/")
    .split("<!--")
    .join("<" + backslash + "!--");
}

/**
 * The exec client of the generated scripts: ORIGIN and run(endpoint, input), which POSTs the
 * input to an exec endpoint and returns the MCP tool-result shape. The bootstrap and the
 * landing's widget init both embed this one text, so the two cannot drift apart. Indented for
 * the body of an IIFE.
 *
 * The exec endpoints are built at run time from the origin of the page the script runs on
 * (`location.protocol + '//' + location.host`, else root-relative under an opaque origin) plus
 * `<namespace>/exec/<tool>`, never from [site].domain: see buildBootstrap.
 */
const EXEC_CLIENT_JS = `  // The exec endpoints are paths. They are called on the origin of the page this
  // script runs on, which is the host the visitor used (www, workers.dev, a
  // preview host) and is not changed by a <base href>. Under an opaque origin
  // (location.origin is the string 'null') or without a location, the path stays
  // root-relative.
  var ORIGIN = '';
  try {
    if (typeof location !== 'undefined' && location && location.origin !== 'null' && location.host && /^https?:$/.test(location.protocol)) {
      ORIGIN = location.protocol + '//' + location.host;
    }
  } catch (e) {}
  // Returns the WebMCP/MCP tool-result shape: a content array. The cf-webmcp
  // executor envelope ({ ok, data | error }) is carried as the text payload so
  // the agent retains structured success/error, and isError is set unless the
  // envelope is an explicit ok:true.
  function run(endpoint, input) {
    return fetch(ORIGIN + endpoint, {
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
  }`;

/**
 * The script body served at /<namespace>/bootstrap.<hash>.js.
 *
 * The exec endpoints it calls are built at run time from the origin of the page it runs on
 * (`location.protocol + '//' + location.host`, else root-relative under an opaque origin) plus
 * `<namespace>/exec/<tool>`, never from [site].domain: the script must work on whichever host
 * served the page (www, workers.dev, preview and staging hosts), where an absolute URL to the
 * canonical host is cross-origin and the exec endpoint sends no CORS headers. The discovery
 * documents (manifest, Link header, llms.txt, agents.md, SKILL.md) stay absolute on the site
 * URL: they are read from outside the page.
 *
 * Threat model of the page-wide registry: it guards against the script running twice and
 * against page scripts that throw, freeze or occupy its key by accident or crudely; none of
 * those can make it throw or register a name twice. It does not defend against a page script
 * that sets out to defeat it by replacing builtins (Object.defineProperty, Object.freeze,
 * Object.prototype.hasOwnProperty) or by installing an accessor or stateful Proxy under the
 * key. Such a script runs with the page's full authority and could register one of our tool
 * names itself, which crashes the renderer just the same; no state this script keeps on the
 * page can be protected from it.
 *
 * The body depends on [[tools]] and [paths].namespace only, and names no config hash: the
 * file is addressed by its content, so a config change that touches neither keeps the URL
 * (and every page that points at it) valid.
 */
function buildBootstrap(config: Config): string {
  const ns = config.paths.namespace;
  const toolPayload = config.tools.map((t) => {
    const defaults = defaultAnnotationsFor(t.executor.type, "method" in t.executor ? t.executor.method : undefined);
    const override = t.annotations ?? {};
    const annotations = {
      readOnlyHint: override.read_only_hint ?? defaults.readOnlyHint,
      untrustedContentHint: override.untrusted_content_hint ?? defaults.untrustedContentHint,
      consequentialHint: override.consequential_hint ?? defaults.consequentialHint,
    };
    return {
      name: t.name,
      ...(t.title !== undefined ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.input_schema,
      annotations,
      endpoint: `${ns}/exec/${t.name}`,
    };
  });

  const toolsJson = jsLiteral(toolPayload);

  // Worker serves this file with content-type application/javascript; charset=utf-8.
  // ES5 style for maximum browser reach (no arrow fns / spread).
  return `// cf-webmcp bootstrap
(function () {
  // Host object: document.modelContext is the current binding (Apr 2026 WebMCP
  // draft, Chrome 150+); navigator.modelContext is the deprecated 146-149 one
  // and merely reading it logs a console deprecation warning, so probe document
  // first and only fall back to navigator. Same tool shape on both.
  var ctx = null;
  if (typeof document !== 'undefined' && document.modelContext && typeof document.modelContext.registerTool === 'function') {
    ctx = document.modelContext;
  } else if (typeof navigator !== 'undefined' && navigator.modelContext && typeof navigator.modelContext.registerTool === 'function') {
    ctx = navigator.modelContext;
  }
  if (!ctx) return;
  var TOOLS = ${toolsJson};
  // How long to wait for getTools() before registering without it.
  var GETTOOLS_TIMEOUT_MS = 1500;
  // Where the page-wide record of the names this script has registered lives.
  var REGISTRY_KEY = '__cfWebmcpRegistered';
  // Cloudflare WebMCP Labs (a dashboard preview feature) injects
  // /.webmcp/bridge.js, which registers its own tools on this same host object.
  // The build refuses the tool and form names Labs reserves; the names of tools
  // it proxies from the site's MCP server are not known at build time, so say so
  // in the console when the bridge is on the page. *= and not $=: the script is
  // often cache-busted (bridge.js?v=1).
  try {
    if (document.querySelector('script[src*="/.webmcp/bridge.js"]') && typeof console !== 'undefined' && console.info) {
      console.info('cf-webmcp: Cloudflare WebMCP Labs bridge detected; keep tool names distinct from its tools');
    }
  } catch (e) {}
  // De-dupe against tools already on the page. Registering the same WebMCP tool
  // name twice (this script's registerTool plus a stamped <form toolname>, or
  // plus another script's registerTool) crashes the renderer (Chrome
  // bad_message 345, RFHI_WEBMCP_REGISTER_DUPLICATE_TOOL_NAME) - a Mojo IPC kill
  // that try/catch cannot trap. The build refuses cf-webmcp's own tool/form name
  // collisions; this guard additionally covers names a publisher hand-stamped in
  // origin HTML, which the build cannot see. First the [toolname] elements,
  // which is synchronous. Whether getTools() also lists declarative form tools
  // is not known, so it adds to that set and never replaces it. Object.create(null)
  // so a hostile toolname like "__proto__" cannot poison the lookup.
  var declared = Object.create(null);
  try {
    var stamped = document.querySelectorAll('[toolname]');
    for (var i = 0; i < stamped.length; i++) {
      var nm = stamped[i].getAttribute('toolname');
      if (nm) declared[nm] = true;
    }
  } catch (e) {}
${EXEC_CLIENT_JS}
  // One AbortController per tool: Chrome (153+) unregisters a tool when the
  // signal passed to registerTool aborts. Older builds ignore the second
  // argument (WebIDL drops extra arguments), so it is always passed. Nothing
  // aborts these controllers and nothing is exposed globally; they are held here
  // so a later SPA-navigation hook can unregister a tool.
  var controllers = [];
  // The names this script has registered, kept for the whole page and not only
  // for this run: the script can run more than once on a page (a second tag,
  // Turbo / htmx / pjax re-running body scripts, two builds from this version on
  // such as a cached bootstrap next to a fresh one), and a second registration of
  // a name kills the renderer. A non-enumerable property under a constant key,
  // first on the host object, else on document; only if neither holder has the
  // key and neither can take it is it local to this run. Looked up at the moment
  // of registering, so it also covers a getTools() answer that was taken before
  // another run registered. The page's own scripts can set the key first, to
  // anything: see registerAll for what happens then.
  function inspectHolder(holder) {
    var state = { registry: null, taken: false };
    try {
      if (holder && Object.prototype.hasOwnProperty.call(holder, REGISTRY_KEY)) {
        state.taken = true;
        var found = holder[REGISTRY_KEY];
        if (found && typeof found === 'object') state.registry = found;
      }
    } catch (e) {
      // Cannot even ask: the holder is hostile. Treat the key as held by the page.
      state.taken = true;
    }
    return state;
  }
  function newRegistry(holder) {
    try {
      if (!holder || !Object.isExtensible(holder)) return null;
      var created = Object.create(null);
      Object.defineProperty(holder, REGISTRY_KEY, { value: created });
      return created;
    } catch (e) {
      return null;
    }
  }
  var holders = [ctx];
  if (typeof document !== 'undefined') holders.push(document);
  var states = [];
  var registered = null;
  var taken = false;
  var h;
  for (h = 0; h < holders.length; h++) {
    states.push(inspectHolder(holders[h]));
    if (states[h].taken) taken = true;
    if (!registered && states[h].registry) registered = states[h].registry;
  }
  // A holder whose key the page already holds is left alone (not redefined).
  for (h = 0; h < holders.length && !registered; h++) {
    if (!states[h].taken) registered = newRegistry(holders[h]);
  }
  if (!registered) {
    // A key the page holds, with no registry we can use behind it, is the page's
    // decision. An empty frozen object keeps no record, so no registration is
    // ever kept (see registerAll) and none is made: registering without a record
    // is how a second run kills the renderer. A run-local object is only for
    // the case where no holder has the key at all and none could take it.
    registered = taken ? Object.freeze(Object.create(null)) : Object.create(null);
  }
  var done = false;
  function warnFailed(name, e) {
    try {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('cf-webmcp: failed to register tool', name, e);
      }
    } catch (err) {}
  }
  // Registers every tool whose name is not in "known". Runs once: every path
  // below (getTools missing, throwing, rejecting, resolving) ends here, and the
  // flag makes a second arrival a no-op. Nothing in here may throw: it also runs
  // from the timer and from promise handlers.
  function registerAll(known) {
    if (done) return;
    done = true;
    TOOLS.forEach(function (t) {
      // Check the name, record it, and register only if the record reads back as
      // kept. The registry can be an object the page controls: one that throws,
      // is frozen, or drops writes. Then the tool is not registered, because a
      // registration with no record is one a later run cannot see.
      var skip = true;
      try {
        if (!known[t.name] && !registered[t.name]) {
          registered[t.name] = true;
          skip = registered[t.name] !== true;
        }
      } catch (e) {}
      if (skip) return;
      try {
        var toolDef = {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: t.annotations,
          execute: function (input) { return run(t.endpoint, input); },
        };
        if (t.title) toolDef.title = t.title;
        var controller = typeof AbortController === 'function' ? new AbortController() : null;
        var result;
        if (controller) {
          controllers.push(controller);
          result = ctx.registerTool(toolDef, { signal: controller.signal });
        } else {
          result = ctx.registerTool(toolDef);
        }
        // registerTool may return a promise; a rejection must not surface as an
        // unhandled one.
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(function (e) { warnFailed(t.name, e); });
        }
      } catch (e) {
        warnFailed(t.name, e);
      }
    });
  }
  // Everything about getTools() is read inside the try: it may be missing, a
  // getter that throws, or throw when called.
  var pending = null;
  try {
    if (typeof ctx.getTools === 'function' && typeof Promise === 'function') {
      pending = Promise.resolve(ctx.getTools());
    }
  } catch (e) {
    pending = null;
  }
  function registerFromDeclared() {
    registerAll(declared);
  }
  if (!pending) {
    registerFromDeclared();
  } else {
    // A getTools() that never settles must not leave the page without its tools:
    // after the timeout, register against the [toolname] set alone. The done flag
    // makes a getTools() answer that comes later a no-op.
    var timer = null;
    try {
      if (typeof setTimeout === 'function') timer = setTimeout(registerFromDeclared, GETTOOLS_TIMEOUT_MS);
    } catch (e) {
      timer = null;
    }
    var stopTimer = function () {
      try {
        if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
      } catch (e) {}
      timer = null;
    };
    pending.then(function (list) {
      stopTimer();
      var known = Object.create(null);
      var k;
      for (k in declared) known[k] = true;
      if (list && typeof list.length === 'number') {
        for (var j = 0; j < list.length; j++) {
          // One entry that cannot be read must not discard the rest. An entry is a
          // tool object with a name, or the name itself.
          try {
            var entry = list[j];
            var entryName = typeof entry === 'string' ? entry : (entry && entry.name);
            if (typeof entryName === 'string' && entryName) known[entryName] = true;
          } catch (e) {}
        }
      }
      registerAll(known);
    }, function () {
      stopTimer();
      registerFromDeclared();
    }).catch(function () {
      stopTimer();
      registerFromDeclared();
    });
  }
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
 * How long the widget stays connected without activity on the page (the widget resets its timer
 * on mousemove, keypress, click and scroll, webmcp.js:636-639): 30
 * minutes, in milliseconds, for the vendored widget's `inactivityTimeout` option (webmcp.js:17;
 * its default is 5 minutes). A tool call does not reset that timer. Well below 2147483647, the
 * largest delay setTimeout keeps (a larger one fires at once).
 */
const WIDGET_INACTIVITY_MS = 30 * 60 * 1000;

/**
 * {{widget_block}}: the pairing instructions, the widget's <script> and the inline script that
 * starts the widget. It is built only when the widget ships (the feature is on and the pin is
 * usable), so a landing without the widget carries no pairing copy and no bridge command.
 *
 * Every bridge command names the release of the vendored widget: the pin's version without its
 * leading "v" (upstream tag v0.1.13 is npm version 0.1.13). The steps follow what the pinned
 * bridge needs, not its own shortcuts:
 *   - `--foreground` in a terminal. Without it the bridge forks its websocket daemon with no
 *     terminal attached, and on Windows that daemon exits at once (it calls
 *     process.stdin.setRawMode, which only a terminal has; src/websocket-server.js:1504-1514).
 *   - The client entry by hand, pinned. The bridge's own `--config <client>` writes
 *     `@jason.today/webmcp@latest --mcp`, and on Windows into a directory Claude Desktop does not
 *     read (src/config.js:56-104), so the landing never offers it.
 *   - The bridge running before the client starts: the client's side of the bridge reconnects
 *     without its token (src/server.js:216-222), so it connects only on its first try.
 *   - A restart after the very first run: that run writes the bridge's server token to
 *     ~/.webmcp/.env (src/websocket-server.js:1421-1427) but compares connections against the
 *     value it loaded at start-up (src/config.js:28-31, src/websocket-server.js:111-118), so it
 *     refuses the client's side until it is started again.
 * The Claude Desktop entry is JSON, HTML-escaped into a <code> block.
 *
 * The step that points at the widget stays hidden until the widget is on the page, and an empty
 * status line below the steps takes the init script's message when it cannot be loaded.
 *
 * With SRI the widget's tag carries `integrity` and `crossorigin="anonymous"`: the integrity
 * value is the hash of the composed R2 object (preamble + widget), which the Worker serves
 * unmodified.
 */
function buildWidgetBlock(config: Config, widgetUrl: string, sri: string | null, cliVersion: string): string {
  const sriAttrs = sri ? ` integrity="${escapeHtml(sri)}" crossorigin="anonymous"` : "";
  const spec = `@jason.today/webmcp@${cliVersion}`;
  const code = (text: string): string => `<code>${escapeHtml(text)}</code>`;
  const clientEntry = JSON.stringify({ mcpServers: { webmcp: { command: "npx", args: ["-y", spec, "--mcp"] } } }, null, 2);
  const minutes = WIDGET_INACTIVITY_MS / 60000;
  return [
    `<h2>Pairing required</h2>`,
    `    <p>Your browser does not expose WebMCP natively. A desktop MCP client can still call this page's tools through the WebMCP bridge, a small program on your computer, and the widget on this page.</p>`,
    `    <ol>`,
    `      <li>Start the bridge in a terminal and leave the terminal open while you use this site's tools:`,
    `        <pre>${code(`npx -y ${spec} --foreground`)}</pre>`,
    `        Press Ctrl+C in that terminal to stop it. The first time you run the bridge on a computer, stop it with Ctrl+C as soon as it has started and run the same command again: the first run creates the bridge's settings in ${code("~/.webmcp")} but does not use them yet.</li>`,
    `      <li>Add the bridge to your MCP client, then restart the client (quit it fully and open it again). The bridge must already be running when the client starts.`,
    `        <ul>`,
    `          <li>Claude Desktop: in ${code("claude_desktop_config.json")} (macOS: ${code("~/Library/Application Support/Claude/")}, Windows: ${code("%APPDATA%\\Claude\\")}), add the ${code("webmcp")} entry inside ${code("mcpServers")}; if the file does not exist, create it with this content:`,
    `            <pre>${code(clientEntry)}</pre></li>`,
    `          <li>Cursor: the same ${code("webmcp")} entry inside ${code("mcpServers")} in ${code("~/.cursor/mcp.json")}.</li>`,
    `          <li>Claude Code: ${code(`claude mcp add --scope user webmcp -- npx -y ${spec} --mcp`)}</li>`,
    `          <li>Other MCP clients: add a local server that runs ${code(`npx -y ${spec} --mcp`)}, where the client's documentation says.</li>`,
    `        </ul>`,
    `      </li>`,
    `      <li>Ask your MCP client for a WebMCP pairing token, or run ${code(`npx -y ${spec} --new`)} in a second terminal.</li>`,
    `      <li id="webmcp-widget-step" hidden>Click the blue square in the bottom right corner of this page, paste the token and press Connect. Keep this tab open. The widget disconnects after ${minutes} minutes without mouse or keyboard activity on this page; to reconnect, get a new token and repeat this step.</li>`,
    `    </ol>`,
    `    <p id="webmcp-widget-error" role="status" hidden></p>`,
    `    <p>If your client shows no tools from this site, check that the terminal from step 1 is still open, then restart the MCP client. After restarting your computer, repeat step 1 before you open the client. If step 1 says the server is already running, the bridge is running in the background; restart the MCP client.</p>`,
    `    <script src="${escapeHtml(widgetUrl)}" defer${sriAttrs}></script>`,
    `    <script>`,
    buildWidgetInit(config),
    `</script>`,
  ].join("\n");
}

/**
 * The inline script that starts the vendored widget (jasonjmcghee/WebMCP) and registers this
 * site's tools with it, one `registerTool(name, description, inputSchema, execute)` call per
 * tool. The widget sends what `execute` returns to the bridge as the tool result, and the bridge
 * answers the MCP `tools/call` with that value unchanged, so `execute` returns an MCP
 * CallToolResult: the bootstrap's run(), the envelope as text and isError unless ok:true.
 *
 * It runs on window load: the widget's script is deferred, so it has run by then. Nothing starts
 * when the browser has WebMCP of its own: the state script then shows Connected and the
 * bootstrap has registered the tools there. Otherwise the widget starts with a 30 minute
 * inactivity timeout, and once it is on the page the step that points at it is revealed. When
 * it cannot be loaded (its script did not run: R2 answered 503, an SRI mismatch; its constructor
 * threw; it put nothing on the page), the script says so in the console and in the pairing
 * block's status line, as text. Every step that can throw is caught, and the script is its own
 * <script> element, so a widget failure never reaches the landing's state script.
 *
 * Every value from the config goes in through inlineScriptLiteral, so a description cannot end
 * the <script> element. ES5, like the rest of the landing.
 */
function buildWidgetInit(config: Config): string {
  const ns = config.paths.namespace;
  const registrations = config.tools.map((t) => {
    const name = inlineScriptLiteral(t.name);
    const endpoint = inlineScriptLiteral(`${ns}/exec/${t.name}`);
    return `    try {
      w.registerTool(${name}, ${inlineScriptLiteral(t.description)}, ${inlineScriptLiteral(t.input_schema)}, function (input) { return run(${endpoint}, input); });
    } catch (e) {
      warn('could not register tool ' + ${name}, e);
    }`;
  });
  return `(function () {
  // cf-webmcp: starts the fallback widget and registers this site's tools with it.
${EXEC_CLIENT_JS}
  // The error goes to the console only when there is one: a missing argument would print as "undefined".
  function warn(what, e) {
    try {
      if (typeof console === 'undefined' || !console.warn) return;
      if (e === undefined) console.warn('cf-webmcp: fallback widget: ' + what);
      else console.warn('cf-webmcp: fallback widget: ' + what, e);
    } catch (err) {}
  }
  // The pairing block's step that points at the widget, hidden until the widget is there.
  function showWidgetStep() {
    try {
      var step = document.getElementById('webmcp-widget-step');
      if (step) step.removeAttribute('hidden');
    } catch (e) {}
  }
  // The widget cannot be loaded: say so in the console and, as text, in the pairing block.
  function failed(what, e) {
    warn(what, e);
    try {
      var line = document.getElementById('webmcp-widget-error');
      if (line) {
        line.textContent = 'The pairing widget could not be loaded, so this page cannot be paired right now. Reload the page to try again.';
        line.removeAttribute('hidden');
      }
    } catch (err) {}
  }
  // The same test the state script uses for Connected: document.modelContext with
  // registerTool, else the deprecated navigator alias with it.
  function hasNativeWebMCP() {
    try {
      var dmc = 'modelContext' in document ? document.modelContext : null;
      if (dmc && typeof dmc.registerTool === 'function') return true;
      var nmc = 'modelContext' in navigator ? navigator.modelContext : null;
      return !!nmc && typeof nmc.registerTool === 'function';
    } catch (e) {
      return false;
    }
  }
  function start() {
    if (hasNativeWebMCP()) return;
    // The widget script did not run: R2 answered 503, the SRI check failed, or the network did.
    if (typeof WebMCP === 'undefined') {
      failed('the widget script did not load');
      return;
    }
    var w;
    try {
      w = new WebMCP({ inactivityTimeout: ${WIDGET_INACTIVITY_MS} });
    } catch (e) {
      failed('the widget could not start', e);
      return;
    }
    var mounted = null;
    try {
      mounted = document.querySelector('[data-webmcp-widget]');
    } catch (e) {}
    if (!mounted) {
      failed('the widget did not appear on the page');
      return;
    }
    showWidgetStep();
${registrations.join("\n")}
  }
  try {
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start);
  } catch (e) {
    warn('could not start', e);
  }
})();`;
}

/**
 * The bootstrap's <script> for the landing page: deferred, with `integrity` and
 * `crossorigin="anonymous"` when SRI is on, as the Worker injects it into proxied pages, but with
 * a root-relative src. (The injected one names the request's origin, so a <base href> in an
 * origin page cannot move it; the Worker generates this page and it has no <base>.) The landing
 * is served by the Worker itself, so the injection never reaches it; without this tag the page
 * would say its tools are registered with your agent while registering none.
 */
function buildBootstrapBlock(bootstrapUrl: string, sri: string | null): string {
  const sriAttrs = sri ? ` integrity="${escapeHtml(sri)}" crossorigin="anonymous"` : "";
  return `<script src="${escapeHtml(bootstrapUrl)}" defer${sriAttrs}></script>`;
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
 *   {{widget_block}}      - the pairing instructions with the bridge CLI command pinned to
 *                           the widget's version, the widget <script> and the inline script
 *                           that starts it (empty if disabled, which includes a missing or
 *                           unpinned vendor/webmcp/current.json)
 *   {{widget_enabled_js}} - literal "true" or "false" for inline JS
 *   {{bootstrap_block}}   - the bootstrap <script>: root-relative src, deferred, with
 *                           integrity + crossorigin="anonymous" when
 *                           [features].subresource_integrity is on. It registers this
 *                           site's tools on the landing page itself, because the
 *                           Worker's HTML injection does not reach the landing.
 *                           A template without the placeholder loads nothing; one with it
 *                           more than once fails the build (include it once).
 *
 * The runtime state-branching JS in the template is what selects which
 * state-* div becomes visible. As long as the override template keeps the
 * three state divs and the closing inline script, the branching keeps working.
 */
async function buildLanding(
  config: Config,
  configHash: string,
  widget: WidgetBuild,
  bootstrap: { asset: string; sri: string | null },
  tomlPath: string,
): Promise<string> {
  const ns = config.paths.namespace;
  const toolList = config.tools
    .map(
      (t) =>
        `<li><code>${escapeHtml(t.name)}</code> - ${escapeHtml(t.description)}</li>`,
    )
    .join("");
  // The widget is shown only when the feature is on AND this build has a usable
  // pin; otherwise block, enabled flag and the Worker's widget route all agree on "off".
  const widgetBlock =
    widgetEnabled(config, widget.asset) && widget.cliVersion !== null
      ? buildWidgetBlock(config, `${ns}/${widget.asset}`, widget.sri, widget.cliVersion)
      : "";
  const showWidget = widgetBlock !== "";

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

  // Each tag loads and runs the bootstrap again; a page needs it once. (The bootstrap keeps a
  // page-wide record of what it registered, so a second run cannot register a name twice, but a
  // second tag is still a mistake, and one the build can see.)
  const bootstrapBlocks = (templateSrc.match(/\{\{\s*bootstrap_block\s*\}\}/g) ?? []).length;
  if (bootstrapBlocks > 1) {
    throw new Error(
      `[build-config] landing template ${templatePath} contains {{bootstrap_block}} ${bootstrapBlocks} times. ` +
        `Include it once: each placeholder becomes a <script> tag that loads and runs the bootstrap again.`,
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
    bootstrap_block: buildBootstrapBlock(`${ns}/${bootstrap.asset}`, bootstrap.sri),
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
  widget: WidgetBuild,
  buildAt: string,
  preflight: PreflightResult,
  agentSkillsDigest: string | null,
  bootstrapSri: string | null,
  llmsTxtTokenHints: { manifest: number; landing: number },
  http: { manifestEtag: string; landingEtag: string; ardEtag: string; injectionHash: string; version: string },
): string {
  // Plain JSON dump plus the derived hash and asset names.
  const json = JSON.stringify(config, null, 2);
  return `// Auto-generated by scripts/build-config.ts. Do not edit.
/* eslint-disable */
import type { Config } from "../config-types";

/**
 * Hash of the config alone (preflight recomputes it from the TOML). Shown on
 * /_webmcp/health and part of the exec cache key. Not an ETag: the bodies below
 * also change with the widget pin and the generator.
 */
export const CONFIG_HASH = ${JSON.stringify(configHash)};
/** cf-webmcp's version from package.json. Part of the exec cache key, so an upgrade starts a fresh cache. */
export const CF_WEBMCP_VERSION = ${JSON.stringify(http.version)};
/**
 * Strong ETags of the bodies served from this build: "<first 16 hex of the sha256 of
 * the exact bytes>", quotes included. ARD_ETAG is of the synthesized ARD manifest.
 */
export const MANIFEST_ETAG = ${JSON.stringify(http.manifestEtag)};
export const LANDING_ETAG = ${JSON.stringify(http.landingEtag)};
export const ARD_ETAG = ${JSON.stringify(http.ardEtag)};
/**
 * 16 hex over everything that shapes the injected HTML (injectionHashOf in
 * scripts/build-config.ts). Appended inside the quotes of origin's ETag on every
 * rewritten page, so a deploy that changes the injection fails every revalidation
 * of a page rewritten by an earlier build.
 */
export const INJECTION_HASH = ${JSON.stringify(http.injectionHash)};
/** Content-addressed: bootstrap.<sha256(bootstrap body) first 16 hex>.js. */
export const BOOTSTRAP_ASSET = ${JSON.stringify(bootstrapName)};
/**
 * Content-addressed R2 key of the widget: widget.<served_sha256 first 16 hex>.js,
 * from vendor/webmcp/current.json. null when the build ships no widget (no usable pin).
 */
export const WIDGET_ASSET: string | null = ${JSON.stringify(widget.asset)};
/**
 * Subresource Integrity hash for the widget object, "sha384-<base64>" over the
 * composed bytes (license preamble + widget) the Worker serves from R2. null when
 * there is no widget or [features].subresource_integrity = false.
 */
export const WIDGET_SRI: string | null = ${JSON.stringify(widget.sri)};
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
    config.manifest.aliases.forEach((a, i) => {
      if (a !== config.manifest.path) claimed.push({ name: `manifest.aliases[${i}]`, path: a });
    });
  }
  if (config.features.webmcp_landing) claimed.push({ name: "webmcp_landing", path: config.webmcp_landing.path });
  if (config.features.llms_txt && config.llms_txt.mode !== "passthrough") claimed.push({ name: "llms_txt", path: config.llms_txt.path });
  if (config.features.robots_txt && config.robots_txt.mode !== "passthrough") claimed.push({ name: "robots_txt", path: config.robots_txt.path });
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    claimed.push({ name: "agents_md", path: config.agents_md.path });
    config.agents_md.aliases.forEach((a, i) => claimed.push({ name: `agents_md.aliases[${i}]`, path: a }));
  }
  if (apiCatalogServed(config)) {
    claimed.push({ name: "api_catalog", path: config.api_catalog.path });
  }
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    claimed.push({ name: "ai_catalog", path: config.ai_catalog.path });
    config.ai_catalog.aliases.forEach((a, i) => {
      if (a !== config.ai_catalog.path) claimed.push({ name: `ai_catalog.aliases[${i}]`, path: a });
    });
  }
  if (config.features.agent_skills && config.agent_skills.mode !== "passthrough") {
    claimed.push({ name: "agent_skills", path: config.agent_skills.path });
    config.agent_skills.aliases.forEach((a, i) => claimed.push({ name: `agent_skills.aliases[${i}]`, path: a }));
  }
  if (skillsIndexServed(config)) {
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
 * Tool names Cloudflare WebMCP Labs registers on document.modelContext. Labs is a dashboard
 * preview feature that injects `<script type="module" src="/.webmcp/bridge.js"
 * data-packs="c2pa,mcp-server-client" data-mcp-url="/mcp">`; the c2pa pack registers these two
 * tools. Anything else Labs registers (tools proxied from the site's own MCP server) is named
 * by the site and cannot be known here. One list, used by the build check below.
 */
export const CLOUDFLARE_WEBMCP_LABS_TOOL_NAMES: readonly string[] = ["scan_images_c2pa", "inspect_image_c2pa"];

/**
 * Refuse a `[[tools]]` or `[[forms]]` name that Cloudflare WebMCP Labs has taken. A page that
 * runs both Labs and cf-webmcp would register the name twice, and a duplicate name kills the
 * Chrome renderer (bad_message 345). A form counts too: its stamped `toolname` attribute is
 * registered by the browser as a tool. Every offender is reported at once.
 */
function checkReservedToolNames(config: Config): void {
  const reserved = new Set(CLOUDFLARE_WEBMCP_LABS_TOOL_NAMES);
  const problems: string[] = [];
  for (const t of config.tools) {
    if (reserved.has(t.name)) problems.push(`[[tools]] name "${t.name}"`);
  }
  for (const f of config.forms) {
    if (reserved.has(f.name)) problems.push(`[[forms]] name "${f.name}"`);
  }
  if (problems.length === 0) return;
  throw new Error(
    `[build-config] reserved tool name: ${problems.join(", ")}. ` +
      `Cloudflare WebMCP Labs (a dashboard preview feature that injects /.webmcp/bridge.js) registers ` +
      `${CLOUDFLARE_WEBMCP_LABS_TOOL_NAMES.join(" and ")} on document.modelContext. A page that runs both would ` +
      `register the name twice, which kills the Chrome renderer (bad_message 345). Rename it.`,
  );
}

/**
 * Refuse builds where one WebMCP tool name would be registered twice on a page.
 * A duplicate name kills the Chrome renderer (bad_message 345,
 * RFHI_WEBMCP_REGISTER_DUPLICATE_TOOL_NAME) - a browser-side Mojo IPC
 * validation kill that no try/catch can trap. cf-webmcp emits two registration
 * surfaces on one page: the injected bootstrap calls `registerTool` for every
 * `[[tools]]` entry, and a matching `[[forms]]` rule stamps a `toolname`
 * attribute that the browser auto-registers. So the build must guarantee:
 *   - no duplicate name within `[[tools]]`,
 *   - no duplicate name within `[[forms]]`,
 *   - and the `[[tools]]` and `[[forms]]` name sets are disjoint.
 * (The bootstrap also de-dupes at runtime against names hand-stamped in origin
 * HTML, which the build cannot see; this guard covers cf-webmcp's own config.)
 */
function checkToolNameCollisions(config: Config): void {
  const toolNames = new Set<string>();
  for (const t of config.tools) {
    if (toolNames.has(t.name)) {
      throw new Error(
        `[build-config] duplicate tool name "${t.name}" in [[tools]]. ` +
          `Registering the same WebMCP tool name twice crashes the browser renderer (Chrome bad_message 345). ` +
          `Each tool name must be unique.`,
      );
    }
    toolNames.add(t.name);
  }
  const formNames = new Set<string>();
  for (const f of config.forms) {
    if (formNames.has(f.name)) {
      throw new Error(
        `[build-config] duplicate [[forms]] name "${f.name}". ` +
          `Two forms stamping the same toolname on one page register a WebMCP tool twice and crash the renderer (Chrome bad_message 345). ` +
          `Each form name must be unique.`,
      );
    }
    formNames.add(f.name);
    if (toolNames.has(f.name)) {
      throw new Error(
        `[build-config] tool/form name collision: "${f.name}" is both a [[tools]] name and a [[forms]] name. ` +
          `The bootstrap registers it via registerTool while the matching form stamps the same toolname on the page, ` +
          `registering the tool twice and killing the renderer (Chrome bad_message 345, RFHI_WEBMCP_REGISTER_DUPLICATE_TOOL_NAME). ` +
          `Rename one of them.`,
      );
    }
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

/**
 * `widget` is the Worker's own answer to "is the widget on" (widgetEnabled over the build's
 * widget asset): the SKILL.md wording depends on it, and the digest must cover the bytes the
 * Worker serves, which it renders with the same value.
 */
async function computeAgentSkillsDigest(config: Config, widget: boolean): Promise<string | null> {
  if (!skillsIndexServed(config)) return null;
  const body = buildFrontmatter(config) + buildSkillBody(config, widget);
  const hex = createHash("sha256").update(body).digest("hex");
  return `sha256:${hex}`;
}

export function stringifyCanonical(obj: unknown): string {
  const sortReplacer = (_key: string, value: unknown): unknown => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
  return JSON.stringify(obj, sortReplacer, 2) + "\n";
}

/**
 * Refuse a build whose skill name would be empty: [agent_skills].name unset and
 * nothing left of [site].name after slugify (a name in a script without an
 * ASCII decomposition, say). The SKILL.md frontmatter, the skills index and the
 * ARD entry identifier all need it, so it is required whenever one of them is
 * served.
 */
function checkSkillName(config: Config): void {
  const used =
    (config.features.agent_skills && config.agent_skills.mode !== "passthrough") ||
    skillsIndexServed(config) ||
    (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough" && config.features.agent_skills);
  if (!used || skillName(config) !== "") return;
  throw new Error(
    `[build-config] no skill name: [site].name ${JSON.stringify(config.site.name)} has no letters a-z or digits left after ` +
      `removing accents, and [agent_skills].name is not set. Set [agent_skills].name to lowercase letters and digits ` +
      `joined by hyphens, such as "my-site".`,
  );
}

export interface AiCatalogEntry {
  identifier: string;
  displayName: string;
  type: string;
  url: string;
  description?: string;
  capabilities?: string[];
  representativeQueries?: string[];
  tags?: string[];
}

/**
 * The did:web host and the urn:air publisher of the ARD manifest, or a build
 * error naming the [site] field that cannot be used: a [site].domain the URL
 * parser refuses as a host (an invalid IPv4 address such as 1.2.3.4.5). The schema
 * already refuses a [site].domain port outside 1 to 65535, and accepts only an
 * http(s) origin as [site].public_url.
 */
function ardHosts(config: Config): { host: string; publisher: string } {
  try {
    return { host: siteHost(config.site), publisher: sitePublisher(config.site) };
  } catch (e) {
    throw new Error(`[build-config] ${(e as Error).message}`);
  }
}

/**
 * Warnings about an ARD manifest that is served (feature on, not passthrough)
 * but will not be found or will not satisfy ARD v0.91:
 *   - [ai_catalog].path left at the predecessor path, or moved elsewhere while
 *     /.well-known/ard.json is not an alias: v0.91 consumers MUST fetch ard.json.
 *   - a urn:air publisher that is not a fully qualified domain name (localhost,
 *     an IP address, a single label, an empty label). Not an error: the
 *     example-site fixture runs on localhost.
 */
export function ardWarnings(config: Config): string[] {
  if (!config.features.ai_catalog || config.ai_catalog.mode === "passthrough") return [];
  const out: string[] = [];
  const { path, aliases } = config.ai_catalog;
  if (path === ARD_PREDECESSOR_PATH) {
    out.push(
      `[build-config] [ai_catalog].path is ${ARD_PREDECESSOR_PATH}, the predecessor path: consumers of ARD v0.91 MUST fetch ` +
        `${ARD_PATH}; move [ai_catalog].path to the default (${ARD_PATH}).`,
    );
  } else if (path !== ARD_PATH && !aliases.includes(ARD_PATH)) {
    out.push(
      `[build-config] [ai_catalog].path is ${path}, so ${ARD_PATH} is not served: consumers of ARD v0.91 MUST fetch ${ARD_PATH}. ` +
        `Add it to [ai_catalog].aliases or move [ai_catalog].path to the default.`,
    );
  }
  if (config.features.agent_skills) {
    const publisher = ardHosts(config).publisher;
    const problem = publisherProblem(publisher);
    if (problem !== null) {
      out.push(
        `[build-config] the urn:air publisher "${publisher}" (from [site].domain) ${problem}: ARD v0.91 requires a fully qualified ` +
          `domain name there (spec/urn-naming-guide.md section 2). The manifest is built anyway; use the real domain, or a name ` +
          `under .localhost for local work.`,
      );
    }
  }
  return out;
}

/**
 * [origin].forward_cookies is accepted for old configs and does nothing. It was meant to let
 * tool executors pass the visitor's cookies on to origin, and nothing ever did: an executor, and
 * every route that fetches from origin for the Worker's own purposes (llms.txt, robots.txt,
 * agents.md, the catalogs, SKILL.md), builds its own request with its own headers and no
 * visitor cookies, so cached executor answers stay the same for every visitor. The proxy is a
 * different path, which the setting never governed: a proxied request reaches origin exactly
 * as the visitor sent it, cookies included, whatever the value. Say so when it is true, so
 * that nobody relies on it.
 */
export function deadConfigWarnings(config: Config): string[] {
  const out: string[] = [];
  if (config.origin.forward_cookies) {
    out.push(
      `[build-config] [origin].forward_cookies = true has no effect: tool executors and the routes that fetch from origin never send ` +
        `the visitor's cookies, whatever this says (they build their own requests, so a cached tool answer is the same for every visitor), ` +
        `and proxied requests reach origin exactly as the visitor sent them, cookies included. Remove the line.`,
    );
  }
  return out;
}

/**
 * A `?` in a path glob ([injection].exclude_paths, [[forms]].paths). matchGlob compares the
 * pattern with the pathname only, which never holds a query string, and reads `?` as exactly
 * one character. v0.5.1 read it as a regex quantifier (the previous character optional), so a
 * pattern written for that, or one meant to match a query string, matches something else now.
 * One warning per pattern, naming the field and the pattern.
 */
export function globPatternWarnings(config: Config): string[] {
  const out: string[] = [];
  const warn = (field: string, pattern: string) =>
    out.push(
      `[build-config] ${field} pattern ${JSON.stringify(pattern)} contains "?", which matches exactly one character ` +
        `(any character, "/" included). Patterns are matched against the path only, never a query string. Before v0.6.0 ` +
        `"?" made the previous character optional; check that the pattern still matches the pages you mean.`,
    );
  for (const p of config.injection.exclude_paths) if (p.includes("?")) warn("[injection].exclude_paths", p);
  for (const f of config.forms) {
    for (const p of f.paths) if (p.includes("?")) warn(`[[forms]] ${JSON.stringify(f.name)} paths`, p);
  }
  return out;
}

/**
 * A url_template whose first placeholder is in the path and has nothing fixed in front of it but
 * the origin (its static path prefix is `/`, as in `https://example.com{{path}}`): a caller then
 * chooses the whole path, so the tool can request any path on the origin, and every request
 * carries the deploy-token headers. An origin endpoint that echoes request headers would answer
 * with the token. The Worker replaces the token in tool output (src/redact.ts), but only as
 * written or JSON-escaped, so the build suggests narrowing the template. A placeholder whose
 * values the publisher fixed (a `map:` operator, or an `enum` on its input property) cannot
 * choose any path, so it gets no warning; docs/security.md says so. Advice only; the build goes
 * on. One warning per tool.
 */
export function rootTemplateWarnings(config: Config): string[] {
  const out: string[] = [];
  for (const tool of config.tools) {
    const executor = tool.executor;
    if (executor.type !== "dom_extract" && executor.type !== "http_json" && executor.type !== "http_get") continue;
    const template = executor.url_template;
    const compiled = compileTemplate(template);
    // Once a placeholder sits in the query, so do all after it: the first one decides.
    const first = compiled.slots[0];
    if (compiled.pathPrefix !== "/" || first === undefined || first.isQuery || first.operator === "map") continue;
    const property = tool.input_schema.properties[first.name] as { enum?: unknown[] } | undefined;
    if (Array.isArray(property?.enum) && property.enum.length > 0) continue;
    // The origin the template names before its first placeholder, when it names one outright.
    const authority = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#{}]+)\/?$/.exec(template.slice(0, template.indexOf("{{")));
    let origin: string | null = null;
    try {
      origin = authority ? new URL(authority[1]!).origin : null;
    } catch {
      origin = null;
    }
    const where = origin ?? "the origins it can reach";
    const example = origin ? `, such as ${origin}/docs/{{${first.name}}}` : "";
    out.push(
      `[build-config] tool "${tool.name}" (${executor.type}) can request any path on ${where}: its url_template ` +
        `${JSON.stringify(template)} has nothing fixed between the origin and {{${first.name}}}, so a caller chooses the whole path, ` +
        `and with CF_WEBMCP_DEPLOY_TOKEN set every such request carries the deploy-token headers. An origin endpoint that echoes ` +
        `request headers would answer with the token; the Worker replaces it in tool output with [redacted], but only as written or ` +
        `JSON-escaped. If the tool only needs ` +
        `part of the site, narrow the template to a fixed path prefix${example}.`,
    );
  }
  return out;
}

/**
 * A `[tools.cache]` on a POST http_json tool that does not turn caching on: the tool is not
 * cached unless s_maxage is greater than 0 (src/tool-cache.ts), so a table with a max_age, swr or
 * sie but no s_maxage is ignored. Say so once per tool. An explicit `s_maxage = 0` is not
 * ignored but understood: it is how a publisher says "never cache", so it gets no warning.
 */
export function toolCacheWarnings(config: Config): string[] {
  return config.tools
    .filter((t) => t.cache !== undefined && !cachesResults(t) && t.cache.s_maxage !== 0)
    .map(
      (t) =>
        `[build-config] tool "${t.name}" is an http_json POST tool with a [tools.cache] but no s_maxage greater than 0, so it is not cached: ` +
        `a POST tool is cached only when [tools.cache].s_maxage is set (max_age, swr and sie alone do not turn caching on). ` +
        `Set s_maxage to cache it, or remove [tools.cache] (s_maxage = 0 says "never" on purpose and is not warned about).`,
    );
}

/**
 * The API catalog's only entry of ours points at the WebMCP manifest, and RFC 9727 section 4.1
 * requires an API catalog to link to API endpoints. With [features].manifest off the catalog is
 * therefore not served, in any mode (src/served.ts): say so, so that the config says what runs.
 */
export function apiCatalogWarnings(config: Config): string[] {
  if (config.features.manifest || !config.features.api_catalog || config.api_catalog.mode === "passthrough") return [];
  return [
    `[build-config] [features].api_catalog is on but [features].manifest is off: the only entry cf-webmcp puts in the API catalog ` +
      `points at the manifest, and RFC 9727 section 4.1 requires an API catalog to link to API endpoints, so the catalog at ` +
      `${config.api_catalog.path} is not served, in any mode: no route (the path is left to origin), no Link header or <link> ` +
      `entry, no llms.txt line. Set [features].api_catalog = false to say so.`,
  ];
}

/**
 * The skills index lists the SKILL.md with a digest of the bytes the Worker serves, so it exists
 * only with agent_skills on in synthesize or replace mode (src/served.ts). When it is on but one
 * of those fails there is no digest to list: it is not served, its path is left to origin and the
 * manifest has no link to it. Say which condition, so that the config says what runs.
 */
export function skillsIndexWarnings(config: Config): string[] {
  if (!config.features.agent_skills_index || config.agent_skills_index.mode === "passthrough" || skillsIndexServed(config)) return [];
  const reason = !config.features.agent_skills
    ? "[features].agent_skills is off, so there is no SKILL.md for it to list"
    : config.agent_skills.mode === "merge"
      ? "agent_skills is in merge mode, so the SKILL.md holds origin's file and the build cannot compute its digest"
      : "agent_skills is in passthrough mode, so the SKILL.md is origin's and the build cannot compute its digest";
  return [
    `[build-config] [features].agent_skills_index is on but ${reason}: the skills index at ${config.agent_skills_index.path} is not served ` +
      `(the path is left to origin, and the manifest has no links.agent_skills_index). Set [features].agent_skills_index = false ` +
      `or [agent_skills_index].mode = "passthrough" to say so, or serve a SKILL.md the build can hash (agent_skills in synthesize or replace mode).`,
  ];
}

/**
 * The ARD v0.91 manifest: `entries` is the only member ARD defines. `host` is
 * a transport member ARD ignores (v0.91 section 5.1); it keeps the predecessor
 * ai-catalog Host Info shape, and there is no specVersion.
 */
export interface AiCatalogDoc {
  host: { displayName: string; identifier: string };
  entries: AiCatalogEntry[];
}

/**
 * Build the ARD ard.json document. One entry, auto-derived from the Agent
 * Skill, emitted only when agent_skills is enabled (any mode - the SKILL.md URL
 * on the publisher domain is valid even in passthrough). When agent_skills is
 * off, entries is [] and a warning is logged.
 *
 * host.identifier is did:web of the site's canonical host (public_url, else
 * domain), a port percent-encoded. The urn:air publisher segment is
 * [site].domain without its port: the ARD URN naming guide keeps the real
 * domain in local development too, so a dev public_url does not change it.
 */
export function buildAiCatalog(config: Config): AiCatalogDoc {
  const base = siteBase(config);
  const { host, publisher } = ardHosts(config);
  const hostInfo = {
    displayName: config.site.name,
    identifier: config.ai_catalog.host_identifier || didWeb(host),
  };
  const entries: AiCatalogEntry[] = [];
  if (config.features.agent_skills) {
    // A form tool exists only while the Worker stamps forms (src/runtime-copy.ts), as in
    // agents.md and SKILL.md.
    const capabilities = [
      ...config.tools.map((t) => t.name),
      ...(formToolsStamped(config) ? config.forms.map((f) => f.name) : []),
    ];
    const entry: AiCatalogEntry = {
      // The same name as the SKILL.md frontmatter and the skills index.
      identifier: urnAir(publisher, "skill", skillName(config)),
      // Human-readable: the site's name, not the slug.
      displayName: config.site.name,
      type: config.ai_catalog.skill_type,
      url: `${base}${config.agent_skills.path}`,
      description: config.agent_skills.description || config.site.description || undefined,
      capabilities: capabilities.length ? capabilities : undefined,
    };
    if (config.ai_catalog.representative_queries.length) {
      entry.representativeQueries = config.ai_catalog.representative_queries;
    }
    if (config.ai_catalog.tags.length) entry.tags = config.ai_catalog.tags;
    for (const k of Object.keys(entry) as (keyof AiCatalogEntry)[]) {
      if (entry[k] === undefined) delete entry[k];
    }
    entries.push(entry);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      "[build-config] ai_catalog is enabled but agent_skills is off; the catalog will have no entries. Enable agent_skills to list the site skill.",
    );
  }
  return { host: hostInfo, entries };
}

/** What this build ships for the widget. All null when the widget is disabled for lack of a usable pin. */
interface WidgetBuild {
  /** R2 key / URL file name, widget.<served_sha256 16 hex>.js. */
  asset: string | null;
  /** served_sri from the pin, or null when subresource_integrity is off or there is no widget. */
  sri: string | null;
  /** npm version of the bridge CLI that matches the widget: the pin's version without its "v". */
  cliVersion: string | null;
}

const SERVED_SHA256_RE = /^[0-9a-f]{64}$/;
const SERVED_SRI_RE = /^sha384-[A-Za-z0-9+/]{64}$/;

/**
 * Resolve the widget from vendor/webmcp/current.json, and only from there: the
 * vendored webmcp.js is gitignored and absent in CI, so the build never reads it.
 *
 * A pin that is missing, "unpinned", lacks valid served_sha256 / served_sri, or
 * has a version that is not a release tag (vX.Y.Z, from which the landing
 * names the bridge CLI) disables the widget consistently (no asset, no landing
 * block, widget_enabled_js false) with a warning when fallback_widget is on. The
 * build still succeeds, so a fresh checkout or CI smoke build works without a
 * pinned widget.
 */
async function resolveWidget(config: Config, pinPath: string): Promise<WidgetBuild> {
  const wanted = config.features.fallback_widget;
  const rel = path.relative(ROOT, pinPath) || pinPath;
  const disable = (reason: string): WidgetBuild => {
    if (wanted) {
      // eslint-disable-next-line no-console
      console.warn(
        `[build-config] [features].fallback_widget is on but ${reason}, so the widget is disabled in this build ` +
          `(no widget route, no pairing instructions or widget scripts on the landing, widget_enabled_js = false). ` +
          `Pin one with \`npm run update-widget -- --version=vX.Y.Z --sha256=<hex>\`, then \`npm run upload-widget\`.`,
      );
    }
    return { asset: null, sri: null, cliVersion: null };
  };

  let text: string;
  try {
    text = await fs.readFile(pinPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return disable(`the widget pin ${rel} does not exist`);
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`[build-config] widget pin ${rel} is not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[build-config] widget pin ${rel} must be a JSON object`);
  }
  const pin = parsed as Record<string, unknown>;

  if (pin["version"] === "unpinned") return disable(`no widget is pinned (${rel} says "unpinned")`);
  const servedSha256 = pin["served_sha256"];
  const servedSri = pin["served_sri"];
  if (
    typeof servedSha256 !== "string" ||
    !SERVED_SHA256_RE.test(servedSha256) ||
    typeof servedSri !== "string" ||
    !SERVED_SRI_RE.test(servedSri)
  ) {
    return disable(`${rel} has no valid served_sha256 / served_sri (written by an older update-widget?)`);
  }
  // The landing tells the visitor which bridge CLI to run, and that release must match the widget.
  const version = pin["version"];
  const cliVersion = typeof version === "string" ? bridgeNpmVersion(version) : null;
  if (cliVersion === null) {
    return disable(
      `${rel} has version ${JSON.stringify(version)}, which is not a release tag (vX.Y.Z), so the landing cannot name the matching bridge CLI`,
    );
  }

  if (wanted && pin["preamble_sha256"] !== sha256Hex(LICENSE_PREAMBLE)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[build-config] widget preamble mismatch: src/widget-preamble.ts no longer hashes to the preamble_sha256 recorded in ${rel}. ` +
        `upload-widget will refuse to upload until the pin is regenerated; run \`npm run update-widget\` for the current pin.`,
    );
  }

  return {
    asset: widgetAssetName(servedSha256),
    sri: config.features.subresource_integrity ? servedSri : null,
    cliVersion,
  };
}

/** A token that expires within this long of the build gets a warning. */
const ORIGIN_TRIAL_WARN_WITHIN_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Whether a token's origin covers the site: the same origin (scheme, host, port), or, for a
 * token with isSubdomain, the same scheme and port on the token's host or any subdomain of
 * it. URL.origin drops a default port, so a token's explicit `https://example.com:443`
 * equals a site `https://example.com`.
 */
function originTrialCoversSite(payload: OriginTrialPayload, site: URL): boolean {
  const tokenOrigin = new URL(payload.origin);
  if (tokenOrigin.origin === site.origin) return true;
  return (
    payload.isSubdomain === true &&
    tokenOrigin.protocol === site.protocol &&
    tokenOrigin.port === site.port &&
    site.hostname.endsWith(`.${tokenOrigin.hostname}`)
  );
}

/**
 * "in N days" from one day up, "in N hours" below that, "in less than an hour" under an hour.
 * Whole units, rounded down: the warning never promises more time than there is.
 */
function timeLeft(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? "" : "s"}`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return "in less than an hour";
}

/**
 * Checks [origin_trial].tokens, which the Worker sends as `Origin-Trial` headers unchanged.
 * Chrome ignores a token without saying so, so every way a token silently does nothing is a
 * build error: it cannot be decoded (decodeOriginTrialToken is as strict as Chrome's parser),
 * it is listed twice, it is a third-party token (not accepted as a header on a first-party
 * document; Chrome reads the flag on version 3 tokens only), it was issued for another origin
 * than the site's, or it has expired. A token that expires within 30 days is a warning. Every
 * problem is reported at once, by index; no message carries a token beyond
 * decodeOriginTrialToken's short prefix. The signature is not checked: that is Chrome's job.
 */
function checkOriginTrial(config: Config, now: Date): void {
  const tokens = config.origin_trial.tokens;
  if (tokens.length === 0) return;

  const siteUrl = siteBase(config);
  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    throw new Error(
      `[build-config] origin_trial: cannot check the tokens against the site origin, because the site URL ` +
        `${JSON.stringify(siteUrl)} ([site].public_url, else https://<[site].domain>) is not a URL.`,
    );
  }

  const nowMs = now.getTime();
  const problems: string[] = [];
  const warnings: string[] = [];
  const firstIndex = new Map<string, number>();

  tokens.forEach((token, i) => {
    const name = `origin_trial.tokens[${i}]`;
    const earlier = firstIndex.get(token);
    if (earlier !== undefined) {
      problems.push(`${name} repeats origin_trial.tokens[${earlier}]; list each token once.`);
      return;
    }
    firstIndex.set(token, i);

    let version: number;
    let payload: OriginTrialPayload;
    try {
      ({ version, payload } = decodeOriginTrialToken(token));
    } catch (e) {
      problems.push(`${name} cannot be used: ${(e as Error).message}`);
      return;
    }

    const expiryMs = payload.expiry * 1000;
    const expiresAt = new Date(expiryMs).toISOString();
    const label = `${name} (feature ${JSON.stringify(payload.feature)}, expires ${expiresAt})`;
    const own: string[] = [];
    if (payload.isThirdParty && version === 3) {
      own.push(
        `is a third-party token. Chrome does not accept a third-party token delivered as an Origin-Trial HTTP header on a ` +
          `first-party document. Register the trial as a first-party one for ${site.origin} and use that token.`,
      );
    }
    if (!originTrialCoversSite(payload, site)) {
      own.push(
        `was issued for ${payload.origin}${payload.isSubdomain ? " and its subdomains" : ""}, but this site's origin is ` +
          `${site.origin} ([site].public_url, else https://<[site].domain>). Chrome ignores a token for another origin. ` +
          `Register the trial for ${site.origin}.`,
      );
    }
    if (expiryMs <= nowMs) {
      own.push(`has expired. Chrome ignores an expired token. Renew the trial registration and replace the token.`);
    }
    for (const text of own) problems.push(`${label} ${text}`);

    if (own.length === 0 && expiryMs - nowMs <= ORIGIN_TRIAL_WARN_WITHIN_MS) {
      warnings.push(
        `[build-config] ${name} (feature ${JSON.stringify(payload.feature)}) expires ${expiresAt}, ` +
          `${timeLeft(expiryMs - nowMs)}. Renew it and redeploy before then: after that Chrome ignores it.`,
      );
    }
  });

  if (problems.length > 0) {
    throw new Error(`[build-config] origin_trial check failed:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  for (const w of warnings) {
    // eslint-disable-next-line no-console
    console.warn(w);
  }
}

/**
 * v0.6.0 made the desktop-bridge widget opt-in ([features].fallback_widget defaults to false), so
 * a config written for an earlier release that relied on the old default loses the pairing flow
 * on upgrade. Say so whenever the resolved TOML (after `inherits`, before the schema fills in
 * defaults) has no fallback_widget key. A notice only: the parsed config, and so CONFIG_HASH, is
 * the same with the key absent or set to false.
 */
function noticeUnsetFallbackWidget(raw: Record<string, unknown>): void {
  const features = raw["features"];
  const isSet =
    typeof features === "object" &&
    features !== null &&
    !Array.isArray(features) &&
    Object.prototype.hasOwnProperty.call(features, "fallback_widget");
  if (isSet) return;
  // eslint-disable-next-line no-console
  console.warn(
    "[build-config] fallback_widget is not set; since v0.6.0 it defaults to false (the desktop-bridge widget is opt-in). " +
      "Set it explicitly to silence this notice.",
  );
}

export async function buildConfig(opts: BuildOptions): Promise<void> {
  const baseDir = path.dirname(opts.tomlPath);
  const rawIn = await readToml(opts.tomlPath);
  const merged = await resolveInherits(rawIn, baseDir);

  checkReservedPropertyNames(merged);
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    throw new Error(`[build-config] config validation failed:\n${issues}`);
  }
  const config = parsed.data;
  noticeUnsetFallbackWidget(merged);

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
  checkBaseUrlAllowed(config);
  checkDeclaredInputs(config);
  checkAllowList(config);
  checkPathCollisions(config);
  checkSkillName(config);
  checkReservedToolNames(config);
  checkToolNameCollisions(config);
  checkOriginTrial(config, opts.now ?? new Date());

  // CONFIG_HASH covers the config alone (preflight recomputes it from the TOML,
  // through the same resolveInherits and configHashOf). It names no served asset and
  // is no ETag: those are hashed from the bodies themselves below.
  const configHash = configHashOf(config);

  // Content-addressed assets. The bootstrap is named after its own bytes, so a
  // generator change with an unchanged TOML still moves the URL, together with
  // the SRI hash computed below over the same string, and a TOML edit that leaves
  // [[tools]] and [paths].namespace alone does not.
  const bootstrap = buildBootstrap(config);
  const bootstrapName = `bootstrap.${sha256Hex(bootstrap).slice(0, 16)}.js`;
  // The SRI hash is over the same string, and the landing page's own <script> for the
  // bootstrap needs both, so both are fixed before the landing is built.
  const bootstrapSri = computeBootstrapSri(config, bootstrap);
  // The widget is named after the composed object recorded in the pin, so a TOML
  // edit never moves it and a pin change always does.
  const widget = await resolveWidget(config, opts.widgetPinPath ?? DEFAULT_WIDGET_PIN_PATH);

  const manifest = buildManifest(config, configHash, bootstrapName);
  const landing = await buildLanding(
    config,
    configHash,
    widget,
    { asset: bootstrapName, sri: bootstrapSri },
    opts.tomlPath,
  );
  const aiCatalog = config.features.ai_catalog ? buildAiCatalog(config) : null;
  const aiCatalogStr = aiCatalog ? stringifyCanonical(aiCatalog) : "";
  for (const warning of [
    ...ardWarnings(config),
    ...apiCatalogWarnings(config),
    ...skillsIndexWarnings(config),
    ...toolCacheWarnings(config),
    ...declaredInputWarnings(config),
    ...deadConfigWarnings(config),
    ...globPatternWarnings(config),
    ...rootTemplateWarnings(config),
  ]) {
    // eslint-disable-next-line no-console
    console.warn(warning);
  }
  const buildAt = new Date().toISOString();
  const preflight = await loadPreflightResult(opts.outDir, configHash);
  const agentSkillsDigest = await computeAgentSkillsDigest(config, widgetEnabled(config, widget.asset));
  const manifestStr = JSON.stringify(manifest, null, 2);
  // Token-budget hints for the /llms.txt links, computed over the exact
  // bodies the worker serves at those paths.
  const llmsTxtTokenHints = {
    manifest: estimateTokens(manifestStr),
    landing: estimateTokens(landing),
  };
  // The ETags are over the exact strings embedded in assets.ts below.
  const version = await packageVersion();
  const http = {
    manifestEtag: bodyEtag(manifestStr),
    landingEtag: bodyEtag(landing),
    ardEtag: bodyEtag(aiCatalogStr),
    injectionHash: injectionHashOf(config, {
      version,
      bootstrapAsset: bootstrapName,
      bootstrapSri,
      rewriterSha256: rewriterSourceHash(await fs.readFile(REWRITER_SOURCE, "utf8")),
      rewriterImports: REWRITER_IMPORTS,
    }),
    version,
  };
  const configTs = buildConfigTs(
    config,
    configHash,
    bootstrapName,
    widget,
    buildAt,
    preflight,
    agentSkillsDigest,
    bootstrapSri,
    llmsTxtTokenHints,
    http,
  );

  const assetsTs = `// Auto-generated by scripts/build-config.ts. Do not edit.
/* eslint-disable */

export const BOOTSTRAP_JS: string = ${JSON.stringify(bootstrap)};
export const LANDING_HTML: string = ${JSON.stringify(landing)};
export const MANIFEST_JSON: string = ${JSON.stringify(manifestStr)};
export const AI_CATALOG_JSON: string = ${JSON.stringify(aiCatalogStr)};
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
      `export const CONFIG_HASH = ${JSON.stringify(configHash)};\nexport const BOOTSTRAP_ASSET = ${JSON.stringify(bootstrapName)};\nexport const WIDGET_ASSET: string | null = ${JSON.stringify(widget.asset)};\n`,
    ),
    ...(aiCatalog ? [fs.writeFile(path.join(opts.outDir, "ard.json"), aiCatalogStr)] : []),
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
