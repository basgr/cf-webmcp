/**
 * Two documents are served and advertised only when they can say something true:
 *
 *   - the API catalog (RFC 9727 section 4.1: "MUST include hyperlinks to API endpoints") has
 *     exactly one entry of ours, the link to the manifest, so with [features].manifest off it is
 *     not served in any mode: no route, no Link header, no <link> tag, no llms.txt line;
 *   - the skills index lists the SKILL.md with a digest the build computes over the bytes the
 *     Worker serves, so it exists only with [features].agent_skills on and a mode whose body the
 *     build can hash (synthesize, replace). In merge mode the body holds origin's file and there
 *     is no digest; in passthrough the SKILL.md is origin's. The path then stays with origin.
 */

import { describe, expect, it } from "vitest";
import { matchRoute } from "./router";
import { buildLinkHeader } from "./link-header";
import { configLinkOptions } from "./injection/html-rewriter";
import { llmsTxtResponse } from "./routes/llms-txt";
import { apiCatalogServed, skillsIndexServed } from "./served";
import { makeConfig, type ConfigOverrides } from "./test-support/config";

const API_PATH = "/.well-known/api-catalog";
const INDEX_PATH = "/.well-known/agent-skills/index.json";
const route = (config: ReturnType<typeof makeConfig>, path: string) =>
  matchRoute(config, new Request(`https://example.com${path}`), "bootstrap.test.js", null).kind;

const API_MODES = ["synthesize", "replace", "merge", "passthrough"] as const;
const SKILL_MODES = ["synthesize", "replace", "merge", "passthrough"] as const;

describe("apiCatalogServed", () => {
  it.each(API_MODES)("mode %s: served only with the feature on and the manifest on", (mode) => {
    const expected = mode !== "passthrough";
    const base: ConfigOverrides = { api_catalog: { mode } };
    expect(apiCatalogServed(makeConfig(base))).toBe(expected);
    expect(apiCatalogServed(makeConfig({ ...base, features: { manifest: false } }))).toBe(false);
    expect(apiCatalogServed(makeConfig({ ...base, features: { api_catalog: false } }))).toBe(false);
    expect(apiCatalogServed(makeConfig({ ...base, features: { api_catalog: false, manifest: false } }))).toBe(false);
  });
});

describe("skillsIndexServed", () => {
  it.each(SKILL_MODES)("agent_skills mode %s: served only when the build can hash the body", (mode) => {
    const expected = mode === "synthesize" || mode === "replace";
    expect(skillsIndexServed(makeConfig({ agent_skills: { mode } }))).toBe(expected);
  });

  it("is not served with [features].agent_skills off, whatever the mode", () => {
    for (const mode of SKILL_MODES) {
      expect(skillsIndexServed(makeConfig({ features: { agent_skills: false }, agent_skills: { mode } })), mode).toBe(false);
    }
  });

  it("is not served with its own feature off or in its own passthrough mode", () => {
    expect(skillsIndexServed(makeConfig({ features: { agent_skills_index: false } }))).toBe(false);
    expect(skillsIndexServed(makeConfig({ agent_skills_index: { mode: "passthrough" } }))).toBe(false);
  });

  it("is served by default", () => {
    expect(skillsIndexServed(makeConfig())).toBe(true);
  });
});

describe("with the manifest off the API catalog is not served in any mode", () => {
  it.each(API_MODES)("api_catalog mode %s: the route is left to origin, and nothing advertises it", async (mode) => {
    const on = makeConfig({ api_catalog: { mode } });
    const off = makeConfig({ api_catalog: { mode }, features: { manifest: false } });

    // The route: ours with the manifest on (not in passthrough), origin's with it off.
    expect(route(on, API_PATH)).toBe(mode === "passthrough" ? "proxy" : "api_catalog");
    expect(route(off, API_PATH)).toBe("proxy");

    // The Link header and the <link> tag.
    expect(buildLinkHeader(off)).not.toContain("api-catalog");
    expect(configLinkOptions(off).apiCatalogUrl).toBeUndefined();
    if (mode !== "passthrough") {
      expect(buildLinkHeader(on)).toContain('rel="api-catalog"');
      expect(configLinkOptions(on).apiCatalogUrl).toBe(`https://example.com${API_PATH}`);
    }

    // The llms.txt line.
    const llms = async (config: ReturnType<typeof makeConfig>) =>
      (
        await llmsTxtResponse(
          new Request("https://example.com/llms.txt"),
          { ...config, llms_txt: { ...config.llms_txt, mode: "synthesize" } },
          async () => new Response("", { status: 404 }),
        )
      ).text();
    expect(await llms(off)).not.toContain("API catalog");
    expect(await llms(off)).not.toContain(API_PATH);
    if (mode !== "passthrough") expect(await llms(on)).toContain(`API catalog (RFC 9727): [https://example.com${API_PATH}]`);
  });
});

describe("the skills index path stays with origin when no index can be served", () => {
  it("is ours with agent_skills in synthesize or replace mode", () => {
    expect(route(makeConfig({ agent_skills: { mode: "synthesize" } }), INDEX_PATH)).toBe("agent_skills_index");
    expect(route(makeConfig({ agent_skills: { mode: "replace" } }), INDEX_PATH)).toBe("agent_skills_index");
  });

  it.each([
    ["agent_skills off", { features: { agent_skills: false } }],
    ["agent_skills in merge mode", { agent_skills: { mode: "merge" } }],
    ["agent_skills in passthrough mode", { agent_skills: { mode: "passthrough" } }],
    ["the index feature off", { features: { agent_skills_index: false } }],
    ["the index in passthrough mode", { agent_skills_index: { mode: "passthrough" } }],
  ] as Array<[string, ConfigOverrides]>)("is origin's with %s", (_label, overrides) => {
    expect(route(makeConfig(overrides), INDEX_PATH)).toBe("proxy");
  });
});

describe("the <link> tag options follow the same rule as apiCatalogServed", () => {
  it("agree for every combination of feature, mode and manifest", () => {
    for (const feature of [true, false]) {
      for (const manifest of [true, false]) {
        for (const mode of API_MODES) {
          const config = makeConfig({ api_catalog: { mode }, features: { api_catalog: feature, manifest } });
          const label = `feature=${feature} manifest=${manifest} mode=${mode}`;
          expect(configLinkOptions(config).apiCatalogUrl !== undefined, label).toBe(apiCatalogServed(config));
          expect(buildLinkHeader(config).includes('rel="api-catalog"'), label).toBe(apiCatalogServed(config));
        }
      }
    }
  });
});
