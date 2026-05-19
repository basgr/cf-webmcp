import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { agentSkillsIndexResponse, AGENT_SKILLS_INDEX_SCHEMA_URI } from "./agent-skills-index";
import { agentSkillsResponse, buildFrontmatter, buildSkillBody } from "./agent-skills";
import type { Config } from "../config-types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "Example Site", description: "An example.", locale: "en", public_url: "https://example.com" },
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
      api_catalog: true,
      agent_skills: true,
      agent_skills_index: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json" },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" },
    agent_skills: {
      path: "/.well-known/agent-skills/site/SKILL.md",
      mode: "synthesize",
      name: "",
      description: "",
      aliases: [],
      hints: [],
    },
    agent_skills_index: {
      path: "/.well-known/agent-skills/index.json",
      mode: "synthesize",
    },
    paths: { namespace: "/_webmcp" },
    injection: { exclude_paths: [] },
    cache: {
      manifest_max_age: 300, manifest_s_maxage: 86400, manifest_swr: 604800, manifest_sie: 86400,
      landing_max_age: 300, landing_s_maxage: 86400, landing_swr: 86400, landing_sie: 86400,
      llms_txt_max_age: 300, llms_txt_s_maxage: 3600, llms_txt_swr: 86400, llms_txt_sie: 86400,
      robots_txt_max_age: 300, robots_txt_s_maxage: 3600, robots_txt_swr: 86400, robots_txt_sie: 86400,
      agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400,
      agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800,
      api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400,
      agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400,
      agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800,
      agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
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
        description: "Search the site.",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      },
    ],
    forms: [],
    ...overrides,
  };
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const FAKE_DIGEST = `sha256:${"a".repeat(64)}`;

describe("agentSkillsIndexResponse", () => {
  it("emits a valid v0.2.0 index document with one skill-md entry", async () => {
    const res = agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), makeConfig(), FAKE_DIGEST);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await res.json() as { $schema: string; skills: Array<{ name: string; type: string; description: string; url: string; digest: string }> };
    expect(body.$schema).toBe(AGENT_SKILLS_INDEX_SCHEMA_URI);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]!.type).toBe("skill-md");
    expect(body.skills[0]!.url).toBe("/.well-known/agent-skills/site/SKILL.md");
    expect(body.skills[0]!.digest).toBe(FAKE_DIGEST);
    expect(body.skills[0]!.name).toBe("example-site"); // slugified
    expect(body.skills[0]!.description).toBe("An example.");
  });

  it("falls back to a friendly description when site.description is empty", async () => {
    const config = makeConfig({
      site: { ...makeConfig().site, description: "" },
    });
    const body = await (await agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), config, FAKE_DIGEST)).json() as { skills: Array<{ description: string }> };
    expect(body.skills[0]!.description).toContain("WebMCP-enabled site");
  });

  it("returns 404 with explanatory body when digest is null (merge mode upstream)", async () => {
    const config = makeConfig({
      agent_skills: { ...makeConfig().agent_skills, mode: "merge" },
    });
    const res = agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), config, null);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toContain("merge");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("matches the build-time digest semantics: digest is over frontmatter + body", async () => {
    // This is a smoke check that the digest the handler reports is the one a
    // consumer would compute over the SKILL.md the agent-skills handler serves.
    // We do not call the agent-skills handler here (that requires a proxy mock);
    // we just confirm both producers agree on what bytes the digest covers.
    const config = makeConfig();
    const bodyForDigest = buildFrontmatter(config) + buildSkillBody(config);
    const expectedDigest = `sha256:${sha256Hex(bodyForDigest)}`;
    const res = agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), config, expectedDigest);
    const body = await res.json() as { skills: Array<{ digest: string }> };
    expect(body.skills[0]!.digest).toBe(expectedDigest);
    expect(body.skills[0]!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("emits cache-control honouring agent_skills_index_* TTLs", async () => {
    const res = agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), makeConfig(), FAKE_DIGEST);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=300");
    expect(cc).toContain("s-maxage=21600");
    expect(cc).toContain("stale-while-revalidate=86400");
  });

  it("sets x-robots-tag: noindex on the success response", async () => {
    const res = agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), makeConfig(), FAKE_DIGEST);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("respects an explicit agent_skills.name override for the skill entry name", async () => {
    const config = makeConfig({
      agent_skills: { ...makeConfig().agent_skills, name: "Custom Name With Spaces" },
    });
    const body = await (await agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), config, FAKE_DIGEST)).json() as { skills: Array<{ name: string }> };
    expect(body.skills[0]!.name).toBe("custom-name-with-spaces");
  });

  it("digest matches the actual served SKILL.md body end-to-end (synthesize)", async () => {
    // Defends against future refactors of agentSkillsResponse drifting from
    // buildFrontmatter+buildSkillBody. The build pipeline hashes the latter;
    // the runtime serves whatever agentSkillsResponse produces; the two
    // must remain byte-identical or the digest claim is broken.
    const config = makeConfig();
    const proxy404 = async () => new Response("", { status: 404 });
    const servedBody = await (
      await agentSkillsResponse(
        new Request("https://example.com" + config.agent_skills.path),
        config,
        proxy404,
      )
    ).text();
    const servedDigest = `sha256:${sha256Hex(servedBody)}`;
    const buildDigest = `sha256:${sha256Hex(buildFrontmatter(config) + buildSkillBody(config))}`;
    expect(servedDigest).toBe(buildDigest);
  });

  it("emits a stable byte-exact JSON output (trailing newline, 2-space indent)", async () => {
    const res = agentSkillsIndexResponse(new Request("https://example.com/.well-known/agent-skills/index.json"), makeConfig(), FAKE_DIGEST);
    const text = await res.text();
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('"$schema": "https://schemas.agentskills.io/discovery/0.2.0/schema.json"');
  });
});
