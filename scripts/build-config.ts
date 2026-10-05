/**
 * Compile webmcp.toml into TypeScript modules consumed by the Worker.
 *
 * Outputs (all under src/generated/, gitignored):
 *   - config.ts        Typed Config object.
 *   - manifest.json    Body for /.well-known/webmcp.json.
 *   - bootstrap.js     The script served at /<namespace>/bootstrap.<hash>.js, where
 *                      <hash> is the first 16 hex of the sha256 of these exact bytes.
 *   - landing.html     Body for /<webmcp_landing.path>.
 *   - hash.ts          Exports CONFIG_HASH so other modules can stamp ETags.
 *
 * Both served assets are content-addressed so immutable caching and the SRI
 * `integrity` attribute always describe the same bytes:
 *   - bootstrap.<sha256(bootstrap) 16 hex>.js, computed from the generated body;
 *   - widget.<served_sha256 16 hex>.js, read from vendor/webmcp/current.json
 *     (the build never looks at the vendored widget file itself).
 * CONFIG_HASH stays a hash of the config alone: preflight recomputes it from the TOML.
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
import { SKILL_MEDIA_TYPE, didWeb, siteHost, urnAir } from "../src/ard.js";
import { LICENSE_PREAMBLE } from "../src/widget-preamble.js";
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

/**
 * Per-executor-type defaults for the WebMCP ToolAnnotations dictionary.
 *
 * All five executor types are read-only (none mutate origin state), so
 * readOnlyHint defaults to true and consequentialHint (Chrome's "this call may not
 * be undoable") to false across the board. untrustedContentHint
 * varies: sitemap_filter returns URL + lastmod strings (structurally
 * constrained, low free-form-content risk), the other four surface
 * origin-fetched content that an agent should treat with the usual
 * untrusted-content care. An executor type this table does not know is assumed
 * to write: not read-only, consequential.
 *
 * Publishers can override each field per-tool via `[tools.annotations]`.
 * Exported for the build tests.
 */
export function defaultAnnotationsFor(executorType: string): {
  readOnlyHint: boolean;
  untrustedContentHint: boolean;
  consequentialHint: boolean;
} {
  switch (executorType) {
    case "sitemap_filter":
      return { readOnlyHint: true, untrustedContentHint: false, consequentialHint: false };
    case "rss_feed":
    case "dom_extract":
    case "http_json":
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
 */
function buildBootstrap(config: Config, configHash: string): string {
  const ns = config.paths.namespace;
  const toolPayload = config.tools.map((t) => {
    const defaults = defaultAnnotationsFor(t.executor.type);
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
  return `// cf-webmcp bootstrap, config_hash=${configHash}
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
 * How long the widget stays connected without mouse or keyboard activity on the page: 30
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
    config.features.fallback_widget && widget.asset !== null && widget.cliVersion !== null
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
): string {
  // Plain JSON dump plus the derived hash and asset names.
  const json = JSON.stringify(config, null, 2);
  return `// Auto-generated by scripts/build-config.ts. Do not edit.
/* eslint-disable */
import type { Config } from "../config-types";

export const CONFIG_HASH = ${JSON.stringify(configHash)};
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
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    claimed.push({ name: "ai_catalog", path: config.ai_catalog.path });
    for (const a of config.ai_catalog.aliases) {
      if (a !== config.ai_catalog.path) claimed.push({ name: "ai_catalog.alias", path: a });
    }
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

async function computeAgentSkillsDigest(config: Config): Promise<string | null> {
  if (!config.features.agent_skills_index) return null;
  if (config.agent_skills_index.mode === "passthrough") return null;
  if (config.agent_skills.mode === "merge" || config.agent_skills.mode === "passthrough") return null;
  const body = buildFrontmatter(config) + buildSkillBody(config);
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
    (config.features.agent_skills_index && config.agent_skills_index.mode !== "passthrough") ||
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
  const host = siteHost(config.site);
  const hostInfo = {
    displayName: config.site.name,
    identifier: config.ai_catalog.host_identifier || didWeb(host),
  };
  const entries: AiCatalogEntry[] = [];
  if (config.features.agent_skills) {
    const capabilities = [
      ...config.tools.map((t) => t.name),
      ...config.forms.map((f) => f.name),
    ];
    const entry: AiCatalogEntry = {
      // The same name as the SKILL.md frontmatter and the skills index.
      identifier: urnAir(config.site.domain, "skill", skillName(config)),
      displayName: config.agent_skills.name || config.site.name,
      type: SKILL_MEDIA_TYPE,
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
  checkAllowList(config);
  checkPathCollisions(config);
  checkSkillName(config);
  checkReservedToolNames(config);
  checkToolNameCollisions(config);
  checkOriginTrial(config, opts.now ?? new Date());

  // CONFIG_HASH covers the config alone (preflight recomputes it from the TOML,
  // through the same resolveInherits and configHashOf) and stamps ETags. It does
  // NOT name the served assets.
  const configHash = configHashOf(config);

  // Content-addressed assets. The bootstrap is named after its own bytes, so a
  // generator change with an unchanged TOML still moves the URL, together with
  // the SRI hash computed below over the same string.
  const bootstrap = buildBootstrap(config, configHash);
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
  const buildAt = new Date().toISOString();
  const preflight = await loadPreflightResult(opts.outDir, configHash);
  const agentSkillsDigest = await computeAgentSkillsDigest(config);
  const manifestStr = JSON.stringify(manifest, null, 2);
  // Token-budget hints for the /llms.txt links, computed over the exact
  // bodies the worker serves at those paths.
  const llmsTxtTokenHints = {
    manifest: estimateTokens(manifestStr),
    landing: estimateTokens(landing),
  };
  const configTs = buildConfigTs(config, configHash, bootstrapName, widget, buildAt, preflight, agentSkillsDigest, bootstrapSri, llmsTxtTokenHints);

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
