/**
 * Zod schemas for the TOML config. Single source of truth.
 * JSON Schema (for VSCode autocomplete) is generated from these via zod-to-json-schema.
 */

import { z } from "zod";

// ---------- Reusable shapes ----------

const PathString = z
  .string()
  .min(1)
  .refine((s) => s.startsWith("/"), { message: "path must start with /" })
  .refine((s) => !s.includes(".."), { message: "path must not contain .." })
  .refine((s) => !s.includes("?") && !s.includes("#"), { message: "path must not contain query or fragment" });

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
  selector: z.string().default("main, article, [role=main]"),
  strip: z.array(z.string()).default(["nav", "footer", "aside", "script", "style", "noscript"]),
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

const Tool = z.object({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, "tool name must match /^[a-z][a-z0-9_]*$/"),
  description: z.string().min(1),
  input_schema: InputSchema.default({ type: "object", required: [], properties: {} }),
  executor: Executor,
  cache: ToolCache.optional(),
  rate_limit: ToolRateLimit.optional(),
});

// ---------- Top-level ----------

const Site = z.object({
  domain: z.string().min(1),
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
  fallback_widget: z.boolean().default(true),
});

const ManifestBlock = z.object({
  path: PathString.default("/.well-known/webmcp.json"),
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

const PathsBlock = z.object({
  namespace: PathString.default("/_webmcp"),
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
  selector: z.string().min(1),
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
    }),
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
