import { describe, it, expect } from "vitest";
import { agentsMdResponse, agentsMdRedirect, mergeBlock } from "./agents-md";
import type { Config } from "../config-types";
import { makeConfig as configWith, type ConfigOverrides } from "../test-support/config";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: { domain: "example.com", name: "Example", description: "desc", locale: "en" },
    origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"], forward_cookies: false },
    features: {
      inject_html: true, webmcp_landing: true, manifest: true, link_header: true,
      link_tag: true, llms_txt: true, robots_txt: true, agents_md: true, api_catalog: true, ai_catalog: false, agent_skills: true, agent_skills_index: true, subresource_integrity: true, fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] }, api_catalog: { path: "/.well-known/api-catalog", mode: "merge" }, ai_catalog: { path: "/.well-known/ard.json", aliases: ["/.well-known/ai-catalog.json"], mode: "synthesize", skill_type: "application/ai-skill+md", host_identifier: "", representative_queries: [], tags: [] }, agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] }, agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
    origin_trial: { tokens: [] },
    paths: { namespace: "/_webmcp" },
    injection: { exclude_paths: [] },
    cache: {
      manifest_max_age: 300, manifest_s_maxage: 86400, manifest_swr: 604800, manifest_sie: 86400,
      landing_max_age: 300, landing_s_maxage: 86400, landing_swr: 86400, landing_sie: 86400,
      llms_txt_max_age: 300, llms_txt_s_maxage: 21600, llms_txt_swr: 86400, llms_txt_sie: 86400,
      robots_txt_max_age: 300, robots_txt_s_maxage: 21600, robots_txt_swr: 86400, robots_txt_sie: 86400,
      agents_md_max_age: 300, agents_md_s_maxage: 21600, agents_md_swr: 86400, agents_md_sie: 86400,
      agents_md_redirect_max_age: 86400, agents_md_redirect_s_maxage: 604800, api_catalog_max_age: 300, api_catalog_s_maxage: 21600, api_catalog_swr: 86400, api_catalog_sie: 86400, ai_catalog_max_age: 300, ai_catalog_s_maxage: 21600, ai_catalog_swr: 86400, ai_catalog_sie: 86400, agent_skills_max_age: 300, agent_skills_s_maxage: 21600, agent_skills_swr: 86400, agent_skills_sie: 86400, agent_skills_redirect_max_age: 86400, agent_skills_redirect_s_maxage: 604800, agent_skills_index_max_age: 300, agent_skills_index_s_maxage: 21600, agent_skills_index_swr: 86400, agent_skills_index_sie: 86400,
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
        description: "Search.",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      },
    ],
    forms: [],
    ...overrides,
  };
}

describe("mergeBlock", () => {
  it("appends when marker absent", () => {
    const merged = mergeBlock("# repo\n", "BLOCK");
    expect(merged).toContain("BLOCK");
    expect(merged).toContain("<!-- cf-webmcp:begin -->");
    expect(merged).toContain("<!-- cf-webmcp:end -->");
  });

  it("is idempotent on re-run", () => {
    const first = mergeBlock("# repo\n", "BLOCK_V1");
    const second = mergeBlock(first, "BLOCK_V2");
    expect(second).toContain("BLOCK_V2");
    expect(second).not.toContain("BLOCK_V1");
    expect((second.match(/cf-webmcp:begin/g) ?? []).length).toBe(1);
  });
});

describe("agentsMdResponse", () => {
  it("synthesizes from TOML on origin 404", async () => {
    const proxy = async () => new Response("", { status: 404 });
    const res = await agentsMdResponse(new Request("https://example.com/.well-known/agents.md"), makeConfig(), proxy);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("## WebMCP on this site");
    expect(text).toContain("search_pages");
    expect(text).toContain("/.well-known/webmcp.json");
    expect(text).toContain("/mcp");
  });

  it("merges into origin's content when present (text/markdown)", async () => {
    const origin = "# Example\n\nThis project is great.\n";
    const proxy = async () => new Response(origin, { status: 200, headers: { "content-type": "text/markdown" } });
    const res = await agentsMdResponse(new Request("https://example.com/.well-known/agents.md"), makeConfig(), proxy);
    const text = await res.text();
    expect(text).toContain("This project is great.");
    expect(text).toContain("cf-webmcp:begin");
    expect(text).toContain("search_pages");
  });

  it("synthesize mode ignores origin entirely", async () => {
    const proxy = async () => new Response("origin content", { status: 200, headers: { "content-type": "text/markdown" } });
    const config = makeConfig({ agents_md: { path: "/.well-known/agents.md", mode: "synthesize", aliases: [] } });
    const res = await agentsMdResponse(new Request("https://example.com/.well-known/agents.md"), config, proxy);
    const text = await res.text();
    expect(text).not.toContain("origin content");
    expect(text).toContain("search_pages");
  });

  it("passes origin through on non-text content-type", async () => {
    const proxy = async () => new Response("<html>nope</html>", { status: 200, headers: { "content-type": "text/html" } });
    const res = await agentsMdResponse(new Request("https://example.com/.well-known/agents.md"), makeConfig(), proxy);
    expect(await res.text()).toContain("<html>");
  });

  it("includes form-injected tools in the block when forms are configured", async () => {
    const config = makeConfig({
      forms: [
        {
          name: "contact",
          description: "Send a contact message.",
          selector: "form#contact",
          paths: ["/contact"],
          autosubmit: false,
          params: [],
        },
      ],
    });
    const proxy = async () => new Response("", { status: 404 });
    const res = await agentsMdResponse(new Request("https://example.com/.well-known/agents.md"), config, proxy);
    const text = await res.text();
    expect(text).toContain("`contact` (form): Send a contact message.");
  });

});

describe("agents.md says only what this config does", () => {
  const LANDING = "https://example.com/mcp";
  const RUNTIME = "`document.modelContext` (Chrome 146 to 149: the deprecated `navigator.modelContext`)";
  const FORMS: ConfigOverrides = { forms: [{ name: "contact", description: "Send a contact message.", selector: "form#contact" }] };
  const notFound = async () => new Response("", { status: 404 });
  const block = async (overrides: ConfigOverrides = {}, widget = false, healthOpen?: boolean) =>
    (
      await agentsMdResponse(
        new Request("https://example.com/.well-known/agents.md"),
        configWith({ agents_md: { mode: "synthesize" }, ...overrides }),
        notFound,
        widget,
        healthOpen,
      )
    ).text();
  const lineStarting = (text: string, prefix: string) => text.split("\n").find((l) => l.startsWith(prefix));
  const browserLine = (text: string) => lineStarting(text, "- **Browser-native agents**");

  describe("the browser-native line", () => {
    it("HTML injection on, no forms: the tools register on the pages that load the script", async () => {
      expect(browserLine(await block())).toBe(
        `- **Browser-native agents**: On pages that load this site's cf-webmcp script, the tools register on ${RUNTIME} when the page loads. No setup.`,
      );
    });

    it("HTML injection on, with forms: the tools that are not forms, and a form tool only where its form is", async () => {
      expect(browserLine(await block(FORMS))).toBe(
        `- **Browser-native agents**: On pages that load this site's cf-webmcp script, the tools that are not forms register on ${RUNTIME} when the page loads. A form tool exists only on pages that carry its form. No setup.`,
      );
    });

    it("names no flag and no browser product, and not navigator.modelContext as the place to look", async () => {
      const line = browserLine(await block(FORMS))!;
      expect(line).not.toMatch(/flag/i);
      expect(line).not.toMatch(/Browser Run|Kitesurf|Chrome with/);
      expect(line.indexOf("`document.modelContext`")).toBeLessThan(line.indexOf("`navigator.modelContext`"));
    });

    it("HTML injection off, default landing template: the tools register when the WebMCP page loads", async () => {
      expect(browserLine(await block({ features: { inject_html: false } }))).toBe(
        `- **Browser-native agents**: The tools register on ${RUNTIME} when the WebMCP page, [${LANDING}](${LANDING}), loads. No setup.`,
      );
    });

    it("HTML injection off, custom landing template: no browser-native line, the WebMCP page is named", async () => {
      const text = await block({ features: { inject_html: false }, webmcp_landing: { template: "custom.html" } });
      expect(browserLine(text)).toBeUndefined();
      expect(text).toContain(`- **WebMCP page**: [${LANDING}](${LANDING}).`);
    });

    it("HTML injection and the landing off: no connect section at all", async () => {
      const text = await block({ features: { inject_html: false, webmcp_landing: false } });
      expect(text).not.toContain("### How agents connect");
      expect(browserLine(text)).toBeUndefined();
    });
  });

  describe("form tools", () => {
    it("are listed only while HTML injection is on, because only then does the Worker stamp them", async () => {
      expect(await block(FORMS)).toContain("- `contact` (form): Send a contact message.");
      expect(await block({ ...FORMS, features: { inject_html: false } })).not.toContain("(form)");
    });

    it("are left out of the exec line, the schema line and the WebMCP page line when they exist", async () => {
      const text = await block(FORMS);
      expect(text).toContain("- Calls to the tools that are not forms go to `POST /_webmcp/exec/<tool_name>` with a JSON body.");
      expect(text).toContain("Full tool schema (the tools that are not forms): [https://example.com/.well-known/webmcp](https://example.com/.well-known/webmcp)");
      expect(text).toContain(`- **WebMCP page**: [${LANDING}](${LANDING}) lists the tools that are not forms and shows whether your browser exposes WebMCP.`);
    });

    it("keep the plain wording when there are none", async () => {
      const text = await block();
      expect(text).toContain("- Tool calls go to `POST /_webmcp/exec/<tool_name>` with a JSON body.");
      expect(text).toContain("Full tool schema: [https://example.com/.well-known/webmcp](https://example.com/.well-known/webmcp)");
      expect(text).toContain(`- **WebMCP page**: [${LANDING}](${LANDING}) lists the tools and shows whether your browser exposes WebMCP.`);
    });

    it("the pairing bullet says the bridge reaches the tools that are not forms", async () => {
      expect(lineStarting(await block(FORMS, true), "- **Desktop MCP clients**")).toBe(
        `- **Desktop MCP clients** (Claude Desktop, Cursor, Claude Code, Windsurf): pair at [${LANDING}](${LANDING}). The pairing page hosts the localhost-bridge widget. The bridge reaches the tools that are not forms.`,
      );
    });
  });

  it("Retry-After: promised for this site's own rate limit only", async () => {
    const text = await block();
    expect(text).toContain(
      "- A `rate_limited` error (HTTP 429) from this site's own rate limit carries a `Retry-After` header; honour it. One that origin's rate limit caused has none.",
    );
    expect(text).toContain("- Do not retry a `rate_limited` error sooner than its `Retry-After` says; without one, back off before retrying.");
  });

  describe("the health line", () => {
    const HEALTH = "- Operational health: [https://example.com/_webmcp/health](https://example.com/_webmcp/health).";

    it("is there when the endpoint answers without a token", async () => {
      expect(await block()).toContain(HEALTH);
    });

    it.each([
      ["a [health].token is set", { health: { token: "secret" } } as ConfigOverrides],
      ["[health].public is false", { health: { public: false } } as ConfigOverrides],
    ])("is left out when %s", async (_label, overrides) => {
      expect(await block(overrides)).not.toContain("Operational health");
    });

    it("is left out when the caller says the endpoint needs a token (the CF_WEBMCP_HEALTH_TOKEN secret)", async () => {
      expect(await block({}, false, false)).not.toContain("Operational health");
    });
  });
});

describe("agentsMdRedirect", () => {
  it("returns 301 to the canonical path", () => {
    const res = agentsMdRedirect(makeConfig());
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/.well-known/agents.md");
  });

  it("includes cache headers so the redirect itself is cacheable", () => {
    const res = agentsMdRedirect(makeConfig());
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=86400");
    expect(cc).toContain("s-maxage=604800");
  });

  it("respects a custom canonical path", () => {
    const config = makeConfig({ agents_md: { path: "/agents.md", mode: "merge", aliases: ["/AGENTS.md"] } });
    expect(agentsMdRedirect(config).headers.get("location")).toBe("/agents.md");
  });
});
