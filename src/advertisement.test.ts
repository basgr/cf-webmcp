/**
 * A feature that is off removes its advertisement, and the landing is described as what it
 * is. Every surface that names the WebMCP manifest or the landing page is checked here:
 *
 *   manifest   Link header, <link> tag, llms.txt, agents.md, SKILL.md, API catalog
 *   landing    llms.txt, agents.md, SKILL.md (the manifest's links.landing is checked in
 *              scripts/build-config.test.ts, where the manifest is built)
 *
 * The widget wording: "pair" and "pairing page" only when the desktop-bridge widget is on
 * (features.fallback_widget and a build that has a usable widget pin, WIDGET_ASSET not null).
 * With the widget off the landing is "WebMCP page" and nothing says a desktop client can pair.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Env } from "./handler";
import { buildLinkHeader } from "./link-header";
import { configLinkOptions, injectIntoHtml } from "./injection/html-rewriter";
import { llmsTxtResponse } from "./routes/llms-txt";
import { agentsMdResponse } from "./routes/agents-md";
import { agentSkillsResponse, buildFrontmatter, buildSkillBody } from "./routes/agent-skills";
import { makeConfig, makeDeps, type ConfigOverrides } from "./test-support/config";

const notFound = async () => new Response("not found", { status: 404 });
const MANIFEST_URL = "https://example.com/.well-known/webmcp";
const LANDING_URL = "https://example.com/mcp";

const MANIFEST_OFF: ConfigOverrides = { features: { manifest: false } };
const LANDING_OFF: ConfigOverrides = { features: { webmcp_landing: false } };

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const llms = async (overrides: ConfigOverrides = {}, widget?: boolean, hints = { manifest: 700, landing: 400 }) =>
  (
    await llmsTxtResponse(
      new Request("https://example.com/llms.txt"),
      makeConfig({ llms_txt: { mode: "synthesize" }, ...overrides }),
      notFound,
      hints,
      widget,
    )
  ).text();

const agents = async (overrides: ConfigOverrides = {}, widget?: boolean) =>
  (
    await agentsMdResponse(
      new Request("https://example.com/.well-known/agents.md"),
      makeConfig({ agents_md: { mode: "synthesize" }, ...overrides }),
      notFound,
      widget,
    )
  ).text();

const skill = async (overrides: ConfigOverrides = {}, widget?: boolean) =>
  (
    await agentSkillsResponse(
      new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"),
      makeConfig({ agent_skills: { mode: "synthesize" }, ...overrides }),
      notFound,
      widget,
    )
  ).text();

describe("features.manifest = false removes every rel=webmcp advertisement", () => {
  it("the Link header carries no rel=webmcp and keeps the other entries", () => {
    const on = buildLinkHeader(makeConfig());
    expect(on).toContain(`<${MANIFEST_URL}>; rel="webmcp"`);

    const off = buildLinkHeader(makeConfig(MANIFEST_OFF));
    expect(off).not.toContain("webmcp");
    // The API catalog's only entry of ours is the link to the manifest, so it goes too (served.test.ts).
    expect(off).not.toContain('rel="api-catalog"');
    expect(off).toContain('rel="agent-skills"');
    expect(off).toContain('rel="describedby"');
  });

  it("the Link header is empty, not a stray separator, when nothing is left to advertise", () => {
    const nothing: ConfigOverrides = {
      features: { manifest: false, api_catalog: false, ai_catalog: false, agent_skills: false, llms_txt: false },
    };
    expect(buildLinkHeader(makeConfig(nothing))).toBe("");
    // passthrough modes take their entries out the same way
    expect(
      buildLinkHeader(
        makeConfig({
          features: { manifest: false, ai_catalog: true },
          api_catalog: { mode: "passthrough" },
          ai_catalog: { mode: "passthrough" },
          agent_skills: { mode: "passthrough" },
          llms_txt: { mode: "passthrough" },
        }),
      ),
    ).toBe("");
  });

  it("the <link> tag options carry no manifest URL, and the injected page has no <link rel=webmcp>", async () => {
    expect(configLinkOptions(makeConfig()).manifestUrl).toBe(MANIFEST_URL);
    const options = configLinkOptions(makeConfig(MANIFEST_OFF));
    expect(options.manifestUrl).toBeUndefined();

    const html = "<html><head><title>t</title></head><body>hi</body></html>";
    const out = await injectIntoHtml(new Response(html, { headers: { "content-type": "text/html" } }), {
      ...options,
      bootstrapUrl: "https://example.com/_webmcp/bootstrap.x.js",
      forms: [],
    }).text();
    expect(out).not.toContain('rel="webmcp"');
    expect(out).not.toContain('rel="api-catalog"');
    expect(out).toContain('<link rel="agent-skills"');
    expect(out).toContain("/_webmcp/bootstrap.x.js");
  });

  it("an injected page gets no link tags at all when the manifest and every other document are off", async () => {
    const options = configLinkOptions(
      makeConfig({ features: { manifest: false, api_catalog: false, ai_catalog: false, agent_skills: false, llms_txt: false } }),
    );
    const html = "<html><head><title>t</title></head><body>hi</body></html>";
    const out = await injectIntoHtml(new Response(html, { headers: { "content-type": "text/html" } }), {
      ...options,
      bootstrapUrl: "https://example.com/_webmcp/bootstrap.x.js",
      forms: [],
    }).text();
    expect(out).not.toContain("<link");
    expect(out).toContain("<head><title>t</title></head>");
    expect(out).toContain("/_webmcp/bootstrap.x.js");
  });

  it("llms.txt has no tool catalogue line, no manifest URL and no token hint for it", async () => {
    const on = await llms();
    expect(on).toContain(`- Tool catalogue: [${MANIFEST_URL}](${MANIFEST_URL}) (~700 tokens)`);

    const off = await llms(MANIFEST_OFF);
    expect(off).not.toContain("Tool catalogue");
    expect(off).not.toContain(".well-known/webmcp");
    expect(off).not.toContain("~700 tokens");
    // the landing line is still there, with its own hint
    expect(off).toContain(`](${LANDING_URL})`);
    expect(off).toContain("~400 tokens");
  });

  it("agents.md has no 'Full tool schema' line and no manifest URL", async () => {
    expect(await agents()).toContain(`Full tool schema: [${MANIFEST_URL}](${MANIFEST_URL})`);

    const off = await agents(MANIFEST_OFF);
    expect(off).not.toContain("Full tool schema");
    expect(off).not.toContain(".well-known/webmcp");
    expect(off).toContain("search_pages");
  });

  it("SKILL.md has no 'Full machine-readable tool schema' section and no manifest URL", async () => {
    expect(await skill()).toContain(`## Full machine-readable tool schema\n\n<${MANIFEST_URL}>`);

    const off = await skill(MANIFEST_OFF);
    expect(off).not.toContain("Full machine-readable tool schema");
    expect(off).not.toContain(".well-known/webmcp");
    expect(off).toContain("search_pages");
  });
});

describe("features.webmcp_landing = false removes the landing advertisement", () => {
  it("llms.txt has no landing line (pairing page or WebMCP page) and no landing URL, with the widget on or off", async () => {
    for (const widget of [true, false]) {
      const off = await llms({ ...LANDING_OFF, features: { webmcp_landing: false, fallback_widget: true } }, widget);
      expect(off).not.toContain(LANDING_URL);
      expect(off).not.toMatch(/Pairing page|WebMCP page/);
      expect(off).not.toContain("~400 tokens");
      // the manifest line is still there
      expect(off).toContain("Tool catalogue");
    }
  });

  it("agents.md names no landing URL and no 'pair at' bullet, with the widget on or off", async () => {
    for (const widget of [true, false]) {
      const off = await agents({ features: { webmcp_landing: false, fallback_widget: true } }, widget);
      expect(off).not.toContain(LANDING_URL);
      expect(off).not.toMatch(/pair/i);
      expect(off).not.toMatch(/widget/i);
      // browser-native agents are still told how to connect
      expect(off).toContain("Browser-native agents");
    }
  });

  it("SKILL.md names no landing URL and no pairing sentence, with the widget on or off", async () => {
    for (const widget of [true, false]) {
      const off = await skill({ features: { webmcp_landing: false, fallback_widget: true } }, widget);
      expect(off).not.toContain(LANDING_URL);
      expect(off).not.toMatch(/pair/i);
      expect(off).not.toContain("bridge");
      expect(off).toContain("On pages that load this site's cf-webmcp script, the tools register on `document.modelContext`");
    }
  });

  it("buildSkillBody (the text the skills index digest covers) drops the landing the same way", () => {
    const config = makeConfig(LANDING_OFF);
    expect(buildSkillBody(config, true)).not.toContain(LANDING_URL);
    expect(buildSkillBody(config, false)).not.toContain(LANDING_URL);
    expect(buildSkillBody(makeConfig(), true)).toContain(LANDING_URL);
  });
});

describe("the widget wording follows whether the widget is on", () => {
  const WIDGET_ON: ConfigOverrides = { features: { fallback_widget: true } };

  it("llms.txt: 'Pairing page' with the widget on, 'WebMCP page' with it off", async () => {
    const on = await llms(WIDGET_ON, true);
    expect(on).toContain(`- Pairing page: [${LANDING_URL}](${LANDING_URL}) (~400 tokens)`);

    const off = await llms(WIDGET_ON, false);
    expect(off).toContain(`- WebMCP page: [${LANDING_URL}](${LANDING_URL}) (~400 tokens)`);
    expect(off).not.toMatch(/pair/i);
  });

  it("agents.md: the desktop-client bullet and the widget note exist only with the widget on", async () => {
    const on = await agents(WIDGET_ON, true);
    expect(on).toContain(`- **Desktop MCP clients** (Claude Desktop, Cursor, Claude Code, Windsurf): pair at [${LANDING_URL}](${LANDING_URL}). The pairing page hosts the localhost-bridge widget.`);
    expect(on).toContain("- The fallback widget only initialises on the pairing page above.");

    const off = await agents(WIDGET_ON, false);
    expect(off).not.toMatch(/pair|bridge|widget|Desktop MCP clients/i);
    // The landing is still linked, as what it is.
    expect(off).toContain(`[${LANDING_URL}](${LANDING_URL})`);
    expect(off).toContain("WebMCP page");
    // The rest of the block is unchanged.
    expect(off).toContain("### How agents connect");
    expect(off).toContain("Browser-native agents");
    expect(off).toContain("### What to avoid");
  });

  it("SKILL.md: 'Desktop MCP clients can pair at' only with the widget on", async () => {
    const on = await skill(WIDGET_ON, true);
    expect(on).toContain(`Desktop MCP clients can pair at <${LANDING_URL}> and call the tools through the localhost bridge.`);

    const off = await skill(WIDGET_ON, false);
    expect(off).not.toMatch(/pair|bridge|Desktop MCP clients/i);
    expect(off).toContain(`<${LANDING_URL}>`);
    expect(off).toContain("On pages that load this site's cf-webmcp script, the tools register on `document.modelContext`");
  });

  it("the body the skills index digest is taken over carries the same wording as the served one", async () => {
    for (const widget of [true, false]) {
      const config = makeConfig({ ...WIDGET_ON, agent_skills: { mode: "synthesize" } });
      const served = await skill(WIDGET_ON, widget);
      expect(served).toBe(buildFrontmatter(config) + buildSkillBody(config, widget));
    }
  });

  it("without an explicit answer the routes follow features.fallback_widget", async () => {
    expect(await llms({ features: { fallback_widget: true } })).toContain("Pairing page");
    expect(await llms({ features: { fallback_widget: false } })).toContain("WebMCP page");
    expect(await agents({ features: { fallback_widget: true } })).toContain("pair at");
    expect(await agents({ features: { fallback_widget: false } })).not.toMatch(/pair/i);
    expect(await skill({ features: { fallback_widget: true } })).toContain("can pair at");
    expect(await skill({ features: { fallback_widget: false } })).not.toMatch(/pair/i);
  });
});

// The handler decides "widget on" from the config and the build: features.fallback_widget
// and a WIDGET_ASSET that is not null (the build ships no widget without a usable pin).
describe("through the handler", () => {
  const env: Env = { CF_WEBMCP_ASSETS: { get: vi.fn(async () => null) } as unknown as R2Bucket };
  const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }) as unknown as ExecutionContext;

  function stubOrigin(routes: Record<string, () => Response> = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        return routes[url]?.() ?? new Response("not found", { status: 404 });
      }),
    );
  }

  const get = (overrides: ConfigOverrides, widgetAsset: string | null, url: string, init?: RequestInit) =>
    createHandler(makeDeps(overrides, { meta: { WIDGET_ASSET: widgetAsset } })).fetch(
      new Request(url, init) as Request<unknown, IncomingRequestCfProperties>,
      env,
      ctx(),
    );

  const synth: ConfigOverrides = {
    llms_txt: { mode: "synthesize" },
    agents_md: { mode: "synthesize" },
    agent_skills: { mode: "synthesize" },
  };
  const urls = {
    llms: "https://example.com/llms.txt",
    agents: "https://example.com/.well-known/agents.md",
    skill: "https://example.com/.well-known/agent-skills/site/SKILL.md",
  };

  it.each([
    ["feature on, widget in the build", true, "widget.test.js", true],
    ["feature on, no widget in the build (no usable pin)", true, null, false],
    ["feature off, widget in the build", false, "widget.test.js", false],
    ["feature off, no widget in the build", false, null, false],
  ])("%s: pairing wording is %s", async (_label, feature, asset, pairing) => {
    stubOrigin();
    const overrides: ConfigOverrides = { ...synth, features: { fallback_widget: feature } };

    const llmsText = await (await get(overrides, asset, urls.llms)).text();
    const agentsText = await (await get(overrides, asset, urls.agents)).text();
    const skillText = await (await get(overrides, asset, urls.skill)).text();

    for (const text of [llmsText, agentsText, skillText]) {
      expect(/pair/i.test(text), text).toBe(pairing);
      // The landing is advertised either way.
      expect(text).toContain(LANDING_URL);
    }
    expect(llmsText).toContain(pairing ? "Pairing page:" : "WebMCP page:");
  });

  it("agents.md links /_webmcp/health only when it answers without a token, the CF_WEBMCP_HEALTH_TOKEN secret included", async () => {
    stubOrigin();
    const health = "- Operational health: [https://example.com/_webmcp/health](https://example.com/_webmcp/health).";
    const fetchAgents = (e: Env) =>
      createHandler(makeDeps(synth, { meta: { WIDGET_ASSET: null } })).fetch(
        new Request(urls.agents) as Request<unknown, IncomingRequestCfProperties>,
        e,
        ctx(),
      );
    expect(await (await fetchAgents(env)).text()).toContain(health);
    expect(await (await fetchAgents({ ...env, CF_WEBMCP_HEALTH_TOKEN: "s3cret" })).text()).not.toContain("Operational health");
    // An empty secret counts as unset, as in the health route.
    expect(await (await fetchAgents({ ...env, CF_WEBMCP_HEALTH_TOKEN: "" })).text()).toContain(health);
  });

  it("with features.manifest = false the proxied page and its Link header carry no rel=webmcp", async () => {
    stubOrigin({
      "https://example.com/page": () =>
        new Response("<html><head></head><body>hi</body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    const res = await get(MANIFEST_OFF, "widget.test.js", "https://example.com/page");
    const body = await res.text();

    expect(body).not.toContain('rel="webmcp"');
    expect(body).not.toContain('rel="api-catalog"');
    expect(body).toContain('<link rel="agent-skills"');
    expect(res.headers.get("link")).not.toContain("webmcp");
    expect(res.headers.get("link")).not.toContain("api-catalog");
    expect(res.headers.get("link")).toContain('rel="agent-skills"');
  });

  it("with nothing left to advertise there is no Link header, and origin's own is left exactly as it was", async () => {
    const nothing: ConfigOverrides = {
      features: { manifest: false, api_catalog: false, ai_catalog: false, agent_skills: false, llms_txt: false },
    };
    stubOrigin({
      "https://example.com/plain": () =>
        new Response("body", { headers: { "content-type": "text/plain" } }),
      "https://example.com/styled": () =>
        new Response("body", { headers: { "content-type": "text/plain", link: "</s.css>; rel=preload; as=style" } }),
    });

    const plain = await get(nothing, null, "https://example.com/plain");
    expect(plain.headers.has("link")).toBe(false);

    const styled = await get(nothing, null, "https://example.com/styled");
    expect(styled.headers.get("link")).toBe("</s.css>; rel=preload; as=style");
  });

  it("with features.manifest = false the manifest route is not served and llms.txt does not mention it", async () => {
    stubOrigin();
    const res = await get(MANIFEST_OFF, null, "https://example.com/.well-known/webmcp");
    // Not ours any more: it goes to origin, which here answers 404.
    expect(res.status).toBe(404);
    expect(await (await get({ ...MANIFEST_OFF, ...synth }, null, urls.llms)).text()).not.toContain(".well-known/webmcp");
  });
});
