/**
 * Zod schemas for the TOML config. Single source of truth.
 * JSON Schema (for VSCode autocomplete) is generated from these via zod-to-json-schema.
 */

import { z } from "zod";
import { ARD_PATH, ARD_PREDECESSOR_PATH } from "./ard";
import { ORIGIN_TRIAL_TOKEN_RE } from "./origin-trial";
import { checkSelector, type SelectorCheckOptions } from "./selector-grammar";

// ---------- Reusable shapes ----------

/**
 * Adds an issue carrying checkSelector's message. Selectors are checked at build
 * time because HTMLRewriter throws on anything outside its streaming subset, and
 * a selector it rejects costs the injection it was meant for.
 */
function selectorIssue(opts: SelectorCheckOptions) {
  return (selector: string, ctx: z.RefinementCtx) => {
    const message = checkSelector(selector, opts);
    if (message !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  };
}

// Characters we explicitly reject in any PathString. Beyond the standard
// query/fragment/traversal exclusions, this set covers anything that would
// be unsafe to embed in:
//   * an HTTP Link header (`<`, `>`, `"`, control chars)
//   * a 301 Location header (CR/LF would attempt response-splitting)
//   * an HTML <link href=...> attribute (`<`, `>`, `"`)
// The allowed character set is RFC 3986 unreserved + sub-delims + pchar
// extras + percent-encoded triples. Anything else (literal `<`, `>`, `"`,
// backticks, whitespace, C0/C1 controls) is rejected at build time so a
// publisher cannot accidentally produce a malformed Link / Location header.
// U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are also blocked.
// They are legal in modern URL parsers but pre-ES2019 inline `<script>`
// contexts treat them as line terminators. cf-webmcp does not currently
// inline paths into JS, but blocking here is free defense-in-depth.
const PATH_BAD_CHARS = /[\x00-\x20"<>\\^`{|}\x7f-\x9f\u2028\u2029]/;
const PathString = z
  .string()
  .min(1)
  .refine((s) => s.startsWith("/"), { message: "path must start with /" })
  // A leading // is a protocol-relative URL: as a Location it sends the browser to another
  // host, and as a preflight probe path it would send the deploy token there. (A backslash,
  // which browsers read as a slash, is already rejected by PATH_BAD_CHARS.)
  .refine((s) => !s.startsWith("//"), {
    message: "path must not start with // (a protocol-relative URL names another host)",
  })
  .refine((s) => !s.includes(".."), { message: "path must not contain .." })
  .refine((s) => !s.includes("?") && !s.includes("#"), { message: "path must not contain query or fragment" })
  .refine((s) => !PATH_BAD_CHARS.test(s), {
    message: "path contains characters unsafe in HTTP headers (whitespace, controls, or any of < > \" \\ ^ ` { | })",
  });

const HttpsUrl = z
  .string()
  .url()
  .refine((s) => s.startsWith("https://") || s.startsWith("http://"), { message: "must be http(s) URL" });

// JSON Schema subset we accept inside [tools.input_schema].
// Limited on purpose: easier to validate at runtime, easier for agents to reason about.
const InputSchemaProperty: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    type: z.enum(["string", "integer", "number", "boolean", "array"]),
    description: z.string().optional(),
    minimum: z.number().optional(),
    maximum: z.number().optional(),
    pattern: z.string().optional(),
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    items: InputSchemaProperty.optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  }),
);

const InputSchema = z.object({
  type: z.literal("object"),
  required: z.array(z.string()).optional().default([]),
  properties: z.record(InputSchemaProperty).optional().default({}),
});

// ---------- Executors ----------

const SitemapExecutor = z.object({
  type: z.literal("sitemap_filter"),
  sitemap_url: HttpsUrl,
  max_results: z.number().int().positive().max(200).default(20),
});

const RssExecutor = z.object({
  type: z.literal("rss_feed"),
  feed_url: HttpsUrl,
  max_items: z.number().int().positive().max(200).default(20),
});

const DomExtractExecutor = z.object({
  type: z.literal("dom_extract"),
  url_template: z.string().min(1),
  // Both go straight to HTMLRewriter.on(), each on its own, so a comma list is fine here
  // (unlike a form selector, which is composed with its params).
  selector: z.string().superRefine(selectorIssue({ allowList: true })).default("main, article, [role=main]"),
  strip: z
    .array(z.string().superRefine(selectorIssue({ allowList: true })))
    .default(["nav", "footer", "aside", "script", "style", "noscript"]),
  max_chars: z.number().int().positive().max(100_000).default(8_000),
});

const Projection = z.object({
  type: z.enum(["array", "first", "raw"]).default("raw"),
  fields: z.record(z.string()).optional(),
});

const HttpJsonExecutor = z.object({
  type: z.literal("http_json"),
  url_template: z.string().min(1),
  method: z.enum(["GET", "POST"]).default("GET"),
  project: Projection.optional(),
});

const HttpGetExecutor = z.object({
  type: z.literal("http_get"),
  url_template: z.string().min(1),
  method: z.enum(["GET"]).default("GET"),
  max_bytes: z.number().int().positive().max(10_000_000).default(1_048_576), // 1 MiB
  allowed_content_types: z
    .array(z.string())
    .default(["text/*", "application/json", "application/xml", "application/rss+xml", "application/atom+xml"]),
});

const Executor = z.discriminatedUnion("type", [
  SitemapExecutor,
  RssExecutor,
  DomExtractExecutor,
  HttpJsonExecutor,
  HttpGetExecutor,
]);

// ---------- Tool ----------

const ToolCache = z
  .object({
    max_age: z.number().int().nonnegative().optional(),
    s_maxage: z.number().int().nonnegative().optional(),
    swr: z.number().int().nonnegative().optional(),
    sie: z.number().int().nonnegative().optional(),
  })
  .partial();

const ToolRateLimit = z
  .object({
    burst: z.number().int().positive().optional(),
  })
  .partial();

/**
 * Mirrors the WebMCP `ToolAnnotations` dictionary (W3C draft, index.bs):
 *
 *   dictionary ToolAnnotations {
 *     boolean readOnlyHint = false;
 *     boolean untrustedContentHint = false;
 *   };
 *
 * Chrome's imperative API also reads `consequentialHint` (a call the user may not be
 * able to take back); the executors cf-webmcp ships never are, but a publisher can
 * say so for a tool that is. `debugging` (Chrome 156+) is not exposed.
 *
 * Snake-case in TOML; emitted as camelCase in the bootstrap registerTool call.
 * Per-tool overrides take precedence over the executor-type defaults applied
 * in scripts/build-config.ts. None of the fields has a schema default: an omitted
 * field stays out of the parsed config (and out of CONFIG_HASH), and the build
 * resolves it from the executor type.
 */
const ToolAnnotations = z
  .object({
    read_only_hint: z.boolean().optional(),
    untrusted_content_hint: z.boolean().optional(),
    consequential_hint: z.boolean().optional(),
  })
  .partial();

const Tool = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "tool name must match /^[a-z][a-z0-9_]*$/"),
  /**
   * Optional human-friendly tool label. Mirrors the WebMCP draft's
   * `USVString title` member of `ModelContextTool`. When set, surfaces in
   * tool pickers as a friendlier label than the machine-friendly `name`.
   */
  title: z.string().min(1).optional(),
  description: z.string().min(1),
  input_schema: InputSchema.default({ type: "object", required: [], properties: {} }),
  executor: Executor,
  annotations: ToolAnnotations.optional(),
  cache: ToolCache.optional(),
  rate_limit: ToolRateLimit.optional(),
});

// ---------- Top-level ----------

const Site = z.object({
  // A bare hostname (optionally with a port), e.g. `example.com` or
  // `localhost:8787`. Interpolated build-time into `https://${domain}` base
  // URLs (Link header, robots.txt, llms.txt, HTML <link> tag). The ARD
  // manifest's did:web and urn:air identifiers are derived from the host of
  // public_url, or from this domain when public_url is unset (src/ard.ts).
  // The hostname charset forbids CR/LF, double-quotes, whitespace, schemes and
  // paths, so a malicious build-time TOML cannot inject into those headers/text.
  domain: z
    .string()
    .min(1)
    .regex(/^[a-z0-9.-]+(:\d+)?$/i, "domain must be a bare hostname (optionally with port), no scheme or path"),
  name: z.string().min(1),
  description: z.string().default(""),
  locale: z.string().default("en"),
  /**
   * Public base URL used in manifest links and landing page absolute URLs.
   * Defaults to `https://<domain>` when omitted. Override for local dev
   * (e.g. `http://localhost:8787`) so links work in a dev environment.
   */
  public_url: z.string().optional(),
});

const Origin = z.object({
  base_url: HttpsUrl,
  allowed_origins: z.array(HttpsUrl).min(1, "[origin].allowed_origins must contain at least one origin"),
  forward_cookies: z.boolean().default(false),
});

const Features = z.object({
  inject_html: z.boolean().default(true),
  webmcp_landing: z.boolean().default(true),
  manifest: z.boolean().default(true),
  link_header: z.boolean().default(true),
  link_tag: z.boolean().default(true),
  llms_txt: z.boolean().default(true),
  robots_txt: z.boolean().default(true),
  agents_md: z.boolean().default(true),
  api_catalog: z.boolean().default(true),
  ai_catalog: z.boolean().default(false),
  agent_skills: z.boolean().default(true),
  agent_skills_index: z.boolean().default(true),
  /**
   * When true, cf-webmcp emits `integrity="sha384-..."` and
   * `crossorigin="anonymous"` on the injected bootstrap `<script>` tag.
   * Defends against network-level substitution of the bootstrap body
   * (compromised CDN node, MITM on non-HTTPS legs, intermediary cache
   * poisoning). Default true; turn off only if a downstream CSP or
   * tooling layer cannot accept the integrity attribute (unusual).
   */
  subresource_integrity: z.boolean().default(true),
  /**
   * The desktop pairing widget (jasonjmcghee/WebMCP) on the landing page. Opt-in: it needs the
   * widget object in R2 (`npm run upload-widget`) and a bridge program on the visitor's
   * computer, with the limits listed in docs/deployment.md.
   */
  fallback_widget: z.boolean().default(false),
});

const ManifestBlock = z.object({
  // Extensionless by convention, matching IANA-registered well-known suffixes
  // (api-catalog, openid-configuration). Served as application/json.
  path: PathString.default("/.well-known/webmcp"),
  /**
   * Path aliases that 301-redirect to the canonical `path`. The legacy `.json`
   * form is redirected by default so older links and cached `rel="webmcp"`
   * references keep working. Set to an empty array to disable redirects. An
   * alias equal to `path` is ignored (no self-redirect / no collision).
   */
  aliases: z.array(PathString).default(["/.well-known/webmcp.json"]),
});

const LandingBlock = z.object({
  path: PathString.default("/mcp"),
  /**
   * Optional path to a custom landing-page template. Resolved relative to the
   * webmcp.toml file. When set, replaces the shipped default at
   * `templates/landing.default.html`. See docs/customisation.md.
   */
  template: z.string().optional(),
});

const LlmsTxtBlock = z.object({
  path: PathString.default("/llms.txt"),
  mode: z.enum(["merge", "replace", "passthrough", "synthesize"]).default("merge"),
});

const RobotsTxtBlock = z.object({
  path: PathString.default("/robots.txt"),
  mode: z.enum(["merge", "passthrough"]).default("merge"),
});

const AgentsMdBlock = z.object({
  path: PathString.default("/.well-known/agents.md"),
  mode: z.enum(["merge", "replace", "passthrough", "synthesize"]).default("merge"),
  /**
   * Path aliases that 301-redirect to the canonical `path`. Two common
   * community variants are redirected by default. Set to an empty array to
   * disable redirects entirely.
   */
  aliases: z.array(PathString).default(["/AGENTS.md", "/agents.md"]),
});

/**
 * RFC 9727 API Catalog. Publishes a Linkset (RFC 9264) entry pointing at the
 * WebMCP manifest at the well-known catalog path. The catalog format itself
 * defines no API schema; cf-webmcp emits exactly one entry (rel="webmcp")
 * pointing at config.manifest.path. Publishers wanting to advertise other
 * APIs in the same catalog use merge mode and put them in their origin file.
 */
const ApiCatalogBlock = z.object({
  path: PathString.default("/.well-known/api-catalog"),
  mode: z.enum(["merge", "replace", "passthrough", "synthesize"]).default("merge"),
});

/**
 * Anthropic-format Agent Skill (SKILL.md). A site-specific operational guide
 * for agent runtimes that scan skill registries. Auto-generated from
 * [[tools]] + [[forms]], with optional publisher-written prose hints
 * appended for "when to use which tool" / "common pitfalls" guidance.
 *
 * Aliases 301-redirect common case variants (SKILLS.md, skill.md, skills.md)
 * to the canonical path. Mirrors the agents.md alias pattern.
 */
const AgentSkillHint = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
});

/**
 * Cloudflare Agent Skills Discovery RFC v0.2.0 publishes a manifest of
 * available skills at /.well-known/agent-skills/index.json. cf-webmcp emits
 * a single-entry index pointing at its own SKILL.md, with a SHA-256 digest
 * of the synthesised SKILL.md body computed at build time.
 *
 * Modes:
 *   - synthesize (default): emit the index from config; digest pinned at build
 *   - passthrough: do not register the route; origin owns the index
 * Merge / replace are intentionally not exposed - merge is impossible (digest
 * cannot include origin content without runtime fetches) and replace is
 * functionally identical to synthesize for our one-skill case.
 *
 * When agent_skills.mode is "merge" the index handler returns 404 because
 * the build-time digest would not match the merged body served at runtime.
 */
const AgentSkillsIndexBlock = z.object({
  path: PathString.default("/.well-known/agent-skills/index.json"),
  mode: z.enum(["synthesize", "passthrough"]).default("synthesize"),
});

/**
 * Agentic Resource Discovery (ARD) v0.91 manifest. Publishes
 * /.well-known/ard.json listing this site's agentic resources. cf-webmcp
 * auto-derives exactly one entry from the Agent Skill (type
 * application/ai-skill+md). Publisher half only - no registry API, no signing.
 * See docs/ard.md. Default OFF: ARD is a proposal (v0.91). The key keeps its
 * pre-v0.91 name, ai_catalog.
 *
 * Modes:
 *   - synthesize (default): emit the manifest from config, ignore origin
 *   - merge: add our skill entry to origin's manifest (at `path`, or at the
 *     predecessor /.well-known/ai-catalog.json when origin has none at `path`)
 *   - passthrough: route not registered; origin owns the path
 */
const AiCatalogBlock = z.object({
  path: PathString.default(ARD_PATH),
  /**
   * Path aliases that 301-redirect to the canonical `path`. The predecessor
   * path /.well-known/ai-catalog.json is redirected by default, so consumers
   * that still look there find the manifest. Set to an empty array to disable
   * redirects. An alias equal to `path` is ignored.
   */
  aliases: z.array(PathString).default([ARD_PREDECESSOR_PATH]),
  mode: z.enum(["synthesize", "merge", "passthrough"]).default("synthesize"),
  /** Override host.identifier (defaults to did:web:<domain> when empty). */
  host_identifier: z.string().default(""),
  /** Optional 0-5 natural-language sample queries (ARD SHOULD). Omitted from output when empty. */
  representative_queries: z.array(z.string().min(1)).max(5).default([]),
  /** Optional entry tags. Omitted from output when empty. */
  tags: z.array(z.string().min(1)).default([]),
});

const AgentSkillsBlock = z.object({
  path: PathString.default("/.well-known/agent-skills/site/SKILL.md"),
  mode: z.enum(["merge", "replace", "passthrough", "synthesize"]).default("synthesize"),
  /**
   * Override the auto-derived skill name (defaults to slugified [site].name).
   * Lowercase letters and digits in groups joined by single hyphens, the Agent
   * Skills name rule. The SKILL.md frontmatter, the skills index and the ARD
   * entry identifier all use this one value.
   */
  name: z
    .string()
    .regex(
      /^(?:[a-z0-9]+(?:-[a-z0-9]+)*)?$/,
      'agent_skills.name must be lowercase letters and digits, groups joined by single hyphens (e.g. "example-site"), or empty to derive it from [site].name',
    )
    .default(""),
  /** Override the auto-derived skill description (defaults to [site].description). */
  description: z.string().default(""),
  /** Path aliases that 301-redirect to the canonical `path`. Common case-variants by default. */
  aliases: z.array(PathString).default([
    "/.well-known/agent-skills/site/SKILLS.md",
    "/.well-known/agent-skills/site/skill.md",
    "/.well-known/agent-skills/site/skills.md",
  ]),
  /** Hand-written prose sections rendered after the auto-generated tool list. */
  hints: z.array(AgentSkillHint).default([]),
});

/**
 * Chrome origin-trial tokens. Chrome ships WebMCP as an origin trial; a site opts in with
 * its token in an `Origin-Trial` response header on the top-level HTML document. Tokens
 * are issued by Chrome for one origin (see the build checks in scripts/build-config.ts),
 * are emitted as given (one header each), and are never generated or verified here.
 * Public by design: the header is visible to every visitor.
 */
const OriginTrialBlock = z.object({
  tokens: z
    .array(z.string().regex(ORIGIN_TRIAL_TOKEN_RE, "origin-trial token must be standard base64 (A-Z a-z 0-9 + / and up to two = padding)"))
    .default([]),
});

const PathsBlock = z.object({
  // The prefix of every URL cf-webmcp serves under it: `<namespace>/exec/<tool>`,
  // `<namespace>/bootstrap.<hash>.js`. A trailing slash (and so the bare "/") would turn
  // those into `//exec/<tool>`, a protocol-relative URL that names another host.
  namespace: PathString.refine((s) => !s.endsWith("/"), {
    message: "namespace must not be / and must not end with / (it is the prefix of <namespace>/exec/<tool>)",
  }).default("/_webmcp"),
});

const InjectionBlock = z.object({
  exclude_paths: z.array(z.string()).default([]),
});

const CacheBlock = z.object({
  manifest_max_age: z.number().int().nonnegative().default(300),
  manifest_s_maxage: z.number().int().nonnegative().default(86_400),
  manifest_swr: z.number().int().nonnegative().default(604_800),
  manifest_sie: z.number().int().nonnegative().default(86_400),
  landing_max_age: z.number().int().nonnegative().default(300),
  landing_s_maxage: z.number().int().nonnegative().default(86_400),
  landing_swr: z.number().int().nonnegative().default(86_400),
  landing_sie: z.number().int().nonnegative().default(86_400),
  llms_txt_max_age: z.number().int().nonnegative().default(300),
  llms_txt_s_maxage: z.number().int().nonnegative().default(21_600),
  llms_txt_swr: z.number().int().nonnegative().default(86_400),
  llms_txt_sie: z.number().int().nonnegative().default(86_400),
  robots_txt_max_age: z.number().int().nonnegative().default(300),
  robots_txt_s_maxage: z.number().int().nonnegative().default(21_600),
  robots_txt_swr: z.number().int().nonnegative().default(86_400),
  robots_txt_sie: z.number().int().nonnegative().default(86_400),
  agents_md_max_age: z.number().int().nonnegative().default(300),
  agents_md_s_maxage: z.number().int().nonnegative().default(21_600),
  agents_md_swr: z.number().int().nonnegative().default(86_400),
  agents_md_sie: z.number().int().nonnegative().default(86_400),
  /** 301 redirect from aliases to canonical agents.md path. Stable, so cache aggressively. */
  agents_md_redirect_max_age: z.number().int().nonnegative().default(86_400),
  agents_md_redirect_s_maxage: z.number().int().nonnegative().default(604_800),
  api_catalog_max_age: z.number().int().nonnegative().default(300),
  api_catalog_s_maxage: z.number().int().nonnegative().default(21_600),
  api_catalog_swr: z.number().int().nonnegative().default(86_400),
  api_catalog_sie: z.number().int().nonnegative().default(86_400),
  ai_catalog_max_age: z.number().int().nonnegative().default(300),
  ai_catalog_s_maxage: z.number().int().nonnegative().default(21_600),
  ai_catalog_swr: z.number().int().nonnegative().default(86_400),
  ai_catalog_sie: z.number().int().nonnegative().default(86_400),
  agent_skills_max_age: z.number().int().nonnegative().default(300),
  agent_skills_s_maxage: z.number().int().nonnegative().default(21_600),
  agent_skills_swr: z.number().int().nonnegative().default(86_400),
  agent_skills_sie: z.number().int().nonnegative().default(86_400),
  /** 301 redirect from agent-skills aliases to canonical path. Stable, so cache aggressively. */
  agent_skills_redirect_max_age: z.number().int().nonnegative().default(86_400),
  agent_skills_redirect_s_maxage: z.number().int().nonnegative().default(604_800),
  agent_skills_index_max_age: z.number().int().nonnegative().default(300),
  agent_skills_index_s_maxage: z.number().int().nonnegative().default(21_600),
  agent_skills_index_swr: z.number().int().nonnegative().default(86_400),
  agent_skills_index_sie: z.number().int().nonnegative().default(86_400),
  bootstrap_max_age: z.number().int().nonnegative().default(31_536_000),
  widget_max_age: z.number().int().nonnegative().default(31_536_000),
  executor_defaults: z
    .object({
      max_age: z.number().int().nonnegative().default(0),
      s_maxage: z.number().int().nonnegative().default(300),
      swr: z.number().int().nonnegative().default(1_800),
      sie: z.number().int().nonnegative().default(86_400),
    })
    .default({}),
});

const CorsBlock = z.object({
  allowed_origins: z.array(z.string()).default([]),
});

const HealthBlock = z.object({
  public: z.boolean().default(true),
  token: z.string().default(""),
});

const DevBlock = z.object({
  origin: z.string().default("http://localhost:8080"),
});

const RateLimitBlock = z.object({
  requests_per_minute_per_ip: z.number().int().positive().default(60),
});

// ---------- Form attribute injection ----------
//
// Per the W3C WebMCP draft, a <form> can be exposed as an agent-callable tool
// via four declarative attributes (toolname, tooldescription, toolautosubmit,
// toolparamdescription on inputs). The publisher would normally hand-stamp
// these in their HTML. With a [[forms]] block, cf-webmcp does the stamping
// at the edge so existing CMS forms become WebMCP tools with no template edit.

const FormParamInjection = z.object({
  // Params are composed as `${form.selector} ${param.selector}`, so a leading
  // child combinator (`> input`) is meaningful here.
  selector: z.string().min(1).superRefine(selectorIssue({ allowLeadingChild: true })),
  description: z.string().min(1),
});

const FormInjection = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "form tool name must match /^[a-z][a-z0-9_]*$/"),
  description: z.string().min(1),
  selector: z
    .string()
    .min(1)
    .refine((s) => s.startsWith("form"), {
      message: "selector must start with `form` (the matched element must be a <form>)",
    })
    .superRefine(selectorIssue({ allowLeadingChild: false })),
  paths: z.array(z.string()).default([]),
  autosubmit: z.boolean().default(false),
  params: z.array(FormParamInjection).default([]),
});

export type FormInjectionConfig = z.infer<typeof FormInjection>;

// `inherits` is consumed by the build step before validation; do not list here.

export const ConfigSchema = z.object({
  schema_version: z.literal(1),
  site: Site,
  origin: Origin,
  features: Features.default({}),
  manifest: ManifestBlock.default({}),
  webmcp_landing: LandingBlock.default({}),
  llms_txt: LlmsTxtBlock.default({}),
  robots_txt: RobotsTxtBlock.default({}),
  agents_md: AgentsMdBlock.default({}),
  api_catalog: ApiCatalogBlock.default({}),
  ai_catalog: AiCatalogBlock.default({}),
  agent_skills: AgentSkillsBlock.default({}),
  agent_skills_index: AgentSkillsIndexBlock.default({}),
  origin_trial: OriginTrialBlock.default({}),
  paths: PathsBlock.default({}),
  injection: InjectionBlock.default({}),
  cache: CacheBlock.default({}),
  cors: CorsBlock.default({}),
  health: HealthBlock.default({}),
  dev: DevBlock.default({}),
  rate_limit: RateLimitBlock.default({}),
  tools: z.array(Tool).min(1, "at least one tool is required"),
  forms: z.array(FormInjection).default([]),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ToolConfig = z.infer<typeof Tool>;
export type ExecutorConfig = z.infer<typeof Executor>;
export type InputSchemaConfig = z.infer<typeof InputSchema>;
export type InputSchemaProperty_ = z.infer<typeof InputSchemaProperty>;
