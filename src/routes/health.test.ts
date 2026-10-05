import { afterEach, describe, it, expect, vi } from "vitest";
import { healthResponse } from "./health";
import type { Config } from "../config-types";
import { expiryInDays, makeOriginTrialToken } from "../test-support/origin-trial";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "x", description: "", locale: "en" },
    origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"], forward_cookies: false },
    features: {
      inject_html: true,
      webmcp_landing: true,
      manifest: true,
      link_header: true,
      link_tag: true,
      llms_txt: true,
      robots_txt: true,
      agents_md: true,
      api_catalog: true, ai_catalog: false, agent_skills: true, agent_skills_index: true, subresource_integrity: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" }, ai_catalog: { path: "/.well-known/ard.json", aliases: ["/.well-known/ai-catalog.json"], mode: "synthesize", skill_type: "application/ai-skill+md", host_identifier: "", representative_queries: [], tags: [] }, agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] }, agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
    origin_trial: { tokens: [] },
    paths: { namespace: "/_webmcp" },
    injection: { exclude_paths: [] },
    cache: {
      manifest_max_age: 300, manifest_s_maxage: 86400, manifest_swr: 604800, manifest_sie: 86400,
      landing_max_age: 300, landing_s_maxage: 86400, landing_swr: 86400, landing_sie: 86400,
      llms_txt_max_age: 300, llms_txt_s_maxage: 3600, llms_txt_swr: 86400, llms_txt_sie: 86400,
      robots_txt_max_age: 300, robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400,
      agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400,
      agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800,
      api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400, ai_catalog_max_age: 300, ai_catalog_s_maxage: 21600, ai_catalog_swr: 86400, ai_catalog_sie: 86400, agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400, agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
      bootstrap_max_age: 31536000, widget_max_age: 31536000,
      executor_defaults: { max_age: 0, s_maxage: 300, swr: 1800, sie: 86400 },
    },
    cors: { allowed_origins: [] },
    health: { public: true, token: "" },
    dev: { origin: "http://localhost:8080" },
    rate_limit: { requests_per_minute_per_ip: 60 },
    tools: [
      {
        name: "search_pages",
        description: "x",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      },
    ],
    forms: [],
    ...overrides,
  };
}

describe("healthResponse", () => {
  it("returns the build-time deployed_at, not an epoch timestamp", async () => {
    const buildTime = "2026-05-13T20:00:00.000Z";
    const res = await healthResponse(new Request("https://example.com/_webmcp/health"), makeConfig(), {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: buildTime,
    });
    const body = await res.json() as { deployed_at: string };
    expect(body.deployed_at).toBe(buildTime);
    expect(body.deployed_at).not.toContain("1970");
  });

  it("surfaces a preflight result when provided", async () => {
    const ranAt = "2026-05-13T19:55:00.000Z";
    const res = await healthResponse(new Request("https://example.com/_webmcp/health"), makeConfig(), {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: "2026-05-13T20:00:00.000Z",
      preflight: { ran_at: ranAt, collisions: [], warnings: ["one warning"], config_hash: "abc12345" },
    });
    const body = await res.json() as { preflight: { ran_at: string; warnings: string[]; config_hash: string } };
    expect(body.preflight.ran_at).toBe(ranAt);
    expect(body.preflight.warnings).toEqual(["one warning"]);
    expect(body.preflight.config_hash).toBe("abc12345");
  });

  it("defaults preflight.ran_at to null when no preflight result is provided", async () => {
    const res = await healthResponse(new Request("https://example.com/_webmcp/health"), makeConfig(), {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: "2026-05-13T20:00:00.000Z",
    });
    const body = await res.json() as { preflight: { ran_at: string | null } };
    expect(body.preflight.ran_at).toBeNull();
  });

  describe("widget_asset_present", () => {
    const opts = { configHash: "abc12345", schemaVersion: 1, deployedAt: "2026-05-13T20:00:00.000Z" };
    const req = () => new Request("https://example.com/_webmcp/health");

    function headBucket(present: boolean) {
      const head = vi.fn(async (key: string) => (present ? ({ key } as unknown as R2Object) : null));
      return { head } satisfies Pick<R2Bucket, "head">;
    }

    it("is true when the widget object exists in the bucket", async () => {
      const bucket = headBucket(true);
      const res = await healthResponse(req(), makeConfig(), { ...opts, widgetAsset: "widget.0123456789abcdef.js", bucket });
      const body = (await res.json()) as { widget_asset_present: boolean | null };
      expect(body.widget_asset_present).toBe(true);
      expect(bucket.head).toHaveBeenCalledWith("widget.0123456789abcdef.js");
    });

    it("is false when the widget object is missing from the bucket", async () => {
      const bucket = headBucket(false);
      const res = await healthResponse(req(), makeConfig(), { ...opts, widgetAsset: "widget.0123456789abcdef.js", bucket });
      const body = (await res.json()) as { widget_asset_present: boolean | null };
      expect(body.widget_asset_present).toBe(false);
    });

    it("is null and never calls head when the build has no widget asset", async () => {
      const bucket = headBucket(true);
      const res = await healthResponse(req(), makeConfig(), { ...opts, widgetAsset: null, bucket });
      const body = (await res.json()) as { widget_asset_present: boolean | null };
      expect(body.widget_asset_present).toBeNull();
      expect(bucket.head).not.toHaveBeenCalled();
    });

    it("is null and never calls head when fallback_widget is off", async () => {
      const bucket = headBucket(true);
      const config = makeConfig({ features: { ...makeConfig().features, fallback_widget: false } });
      const res = await healthResponse(req(), config, { ...opts, widgetAsset: "widget.0123456789abcdef.js", bucket });
      const body = (await res.json()) as { widget_asset_present: boolean | null };
      expect(body.widget_asset_present).toBeNull();
      expect(bucket.head).not.toHaveBeenCalled();
    });

    it("is null when no bucket binding is available", async () => {
      const res = await healthResponse(req(), makeConfig(), { ...opts, widgetAsset: "widget.0123456789abcdef.js" });
      const body = (await res.json()) as { widget_asset_present: boolean | null };
      expect(body.widget_asset_present).toBeNull();
    });

    it("is null (unknown) rather than failing the health check when the bucket probe throws", async () => {
      const bucket = { head: vi.fn(async () => { throw new Error("r2 unavailable"); }) } satisfies Pick<R2Bucket, "head">;
      const res = await healthResponse(req(), makeConfig(), { ...opts, widgetAsset: "widget.0123456789abcdef.js", bucket });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { widget_asset_present: boolean | null };
      expect(body.widget_asset_present).toBeNull();
    });
  });

  it("requires bearer token when health.token is set", async () => {
    const config = makeConfig({ health: { public: true, token: "s3cret" } });
    const unauth = await healthResponse(new Request("https://example.com/_webmcp/health"), config, {
      configHash: "abc12345",
      schemaVersion: 1,
      deployedAt: "2026-05-13T20:00:00.000Z",
    });
    expect(unauth.status).toBe(401);
    const authed = await healthResponse(
      new Request("https://example.com/_webmcp/health", { headers: { authorization: "Bearer s3cret" } }),
      config,
      { configHash: "abc12345", schemaVersion: 1, deployedAt: "2026-05-13T20:00:00.000Z" },
    );
    expect(authed.status).toBe(200);
  });

  describe("the CF_WEBMCP_HEALTH_TOKEN secret (envToken)", () => {
    const base = { configHash: "abc12345", schemaVersion: 1, deployedAt: "2026-05-13T20:00:00.000Z" };
    const get = (config: Config, envToken: string | undefined, bearer?: string) =>
      healthResponse(
        new Request("https://example.com/_webmcp/health", bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined),
        config,
        { ...base, envToken },
      );

    it("with public = false and only the secret: 401 without auth or with a wrong bearer, 200 with the secret", async () => {
      const config = makeConfig({ health: { public: false, token: "" } });

      const none = await get(config, "from-secret");
      expect(none.status).toBe(401);
      expect(none.headers.get("x-robots-tag")).toBe("noindex");
      expect((await get(config, "from-secret", "wrong")).status).toBe(401);
      expect((await get(config, "from-secret", "from-secret")).status).toBe(200);
    });

    it("the secret wins over [health].token: the TOML token is rejected", async () => {
      const config = makeConfig({ health: { public: false, token: "from-toml" } });

      expect((await get(config, "from-secret", "from-toml")).status).toBe(401);
      expect((await get(config, "from-secret", "from-secret")).status).toBe(200);
    });

    it("falls back to [health].token when no secret is set", async () => {
      const config = makeConfig({ health: { public: false, token: "from-toml" } });

      expect((await get(config, undefined, "from-toml")).status).toBe(200);
      expect((await get(config, undefined)).status).toBe(401);
    });

    it("an empty secret counts as unset", async () => {
      const closed = makeConfig({ health: { public: false, token: "" } });
      const open = makeConfig({ health: { public: true, token: "" } });
      const toml = makeConfig({ health: { public: false, token: "from-toml" } });

      expect((await get(closed, "")).status).toBe(404);
      expect((await get(open, "")).status).toBe(200);
      expect((await get(toml, "", "from-toml")).status).toBe(200);
    });

    it("with public = false and neither token: 404", async () => {
      const res = await get(makeConfig({ health: { public: false, token: "" } }), undefined);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    });

    it("with public = true, a secret alone still requires the bearer", async () => {
      const config = makeConfig({ health: { public: true, token: "" } });

      expect((await get(config, "from-secret")).status).toBe(401);
      expect((await get(config, "from-secret", "from-secret")).status).toBe(200);
    });
  });
});

describe("healthResponse bearer comparison", () => {
  const base = { configHash: "abc12345", schemaVersion: 1, deployedAt: "2026-05-13T20:00:00.000Z" };
  const get = (config: Config, bearer: string, envToken?: string) =>
    healthResponse(
      new Request("https://example.com/_webmcp/health", { headers: { authorization: bearer } }),
      config,
      { ...base, envToken },
    );
  const tomlToken = makeConfig({ health: { public: false, token: "s3cret-token" } });
  const closed = makeConfig({ health: { public: false, token: "" } });

  it.each([
    ["shorter", "Bearer s3cret"],
    ["longer", "Bearer s3cret-token-and-then-some"],
    ["empty", "Bearer "],
    ["missing scheme", "s3cret-token"],
    ["same length, one character off", "Bearer s3cret-tokeN"],
  ])("a %s wrong bearer gets 401 with [health].token", async (_label, bearer) => {
    const res = await get(tomlToken, bearer);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it.each([
    ["shorter", "Bearer s3cret"],
    ["longer", "Bearer s3cret-token-and-then-some"],
  ])("a %s wrong bearer gets 401 with the secret", async (_label, bearer) => {
    expect((await get(closed, bearer, "s3cret-token")).status).toBe(401);
  });

  it("accepts the right token from either source", async () => {
    expect((await get(tomlToken, "Bearer s3cret-token")).status).toBe(200);
    expect((await get(closed, "Bearer s3cret-token", "s3cret-token")).status).toBe(200);
  });

  it("hashes both sides and compares the two 32-byte digests, whatever the lengths", async () => {
    const digest = vi.spyOn(crypto.subtle, "digest");
    const equal = vi.spyOn(crypto.subtle as unknown as { timingSafeEqual: (a: ArrayBuffer, b: ArrayBuffer) => boolean }, "timingSafeEqual");

    // A candidate of another length must not return before the comparison runs: that would leak the token length.
    const short = await get(tomlToken, "Bearer x");
    expect(short.status).toBe(401);
    expect(digest).toHaveBeenCalledTimes(2);
    expect(equal).toHaveBeenCalledTimes(1);
    const [a, b] = equal.mock.calls[0]!;
    expect(a.byteLength).toBe(32);
    expect(b.byteLength).toBe(32);

    const long = await get(tomlToken, `Bearer ${"x".repeat(500)}`);
    expect(long.status).toBe(401);
    expect(digest).toHaveBeenCalledTimes(4);
    expect(equal).toHaveBeenCalledTimes(2);
  });
});

describe("origin_trials", () => {
  const opts = { configHash: "abc12345", schemaVersion: 1, deployedAt: "2026-05-13T20:00:00.000Z" };
  const get = (tokens: string[], init?: RequestInit) =>
    healthResponse(
      new Request("https://example.com/_webmcp/health", init),
      makeConfig({ origin_trial: { tokens } }),
      opts,
    );
  type Trial = { feature?: string; expires_at?: string; expired?: boolean; error?: string };
  const trialsOf = async (res: Response) => ((await res.json()) as { origin_trials: Trial[] }).origin_trials;

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is an empty array when no token is configured", async () => {
    expect(await trialsOf(await get([]))).toEqual([]);
  });

  it("lists feature, expiry as an ISO string and expired for each token, in order", async () => {
    const soon = expiryInDays(20);
    const later = expiryInDays(300);
    const res = await get([
      makeOriginTrialToken({ feature: "WebMCP", expiry: soon }),
      makeOriginTrialToken({ feature: "OtherTrial", expiry: later }),
    ]);

    expect(await trialsOf(res)).toEqual([
      { feature: "WebMCP", expires_at: new Date(soon * 1000).toISOString(), expired: false },
      { feature: "OtherTrial", expires_at: new Date(later * 1000).toISOString(), expired: false },
    ]);
  });

  it("marks a token whose expiry has passed as expired", async () => {
    const past = expiryInDays(-2);
    const trials = await trialsOf(await get([makeOriginTrialToken({ expiry: past })]));
    expect(trials).toEqual([{ feature: "WebMCP", expires_at: new Date(past * 1000).toISOString(), expired: true }]);
  });

  it("computes expired when the request arrives, not when the config was built", async () => {
    const token = makeOriginTrialToken({ expiry: expiryInDays(1) });
    expect((await trialsOf(await get([token])))[0]!.expired).toBe(false);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 3 * 86_400_000);

    expect((await trialsOf(await get([token])))[0]!.expired).toBe(true);
  });

  it("reports a token that does not decode as undecodable, without echoing it", async () => {
    const garbage = "QUJDREVGR0hJSktMTU5PUA==";
    const good = makeOriginTrialToken({ expiry: expiryInDays(100) });
    const res = await get([garbage, good]);
    const text = await res.text();

    expect(text).not.toContain(garbage);
    expect(text).not.toContain(good);
    const trials = (JSON.parse(text) as { origin_trials: Trial[] }).origin_trials;
    expect(trials[0]).toEqual({ error: "undecodable" });
    expect(trials[1]!.feature).toBe("WebMCP");
  });

  it("stays behind the health token", async () => {
    const config = makeConfig({ health: { public: true, token: "s3cret" }, origin_trial: { tokens: [makeOriginTrialToken()] } });
    const denied = await healthResponse(new Request("https://example.com/_webmcp/health"), config, opts);
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain("origin_trials");

    const allowed = await healthResponse(
      new Request("https://example.com/_webmcp/health", { headers: { authorization: "Bearer s3cret" } }),
      config,
      opts,
    );
    expect((await trialsOf(allowed))).toHaveLength(1);
  });
});
