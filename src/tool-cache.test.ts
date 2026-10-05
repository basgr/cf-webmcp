import { describe, expect, it } from "vitest";
import { cachesResults } from "./tool-cache";
import { makeConfig, type ConfigOverrides } from "./test-support/config";

const tool = (executor: Record<string, unknown>, cache?: Record<string, number>) =>
  makeConfig({ tools: [{ name: "t", description: "d", executor, ...(cache ? { cache } : {}) }] } as ConfigOverrides).tools[0]!;

const POST = { type: "http_json", url_template: "https://example.com/x", method: "POST" };
const GET = { type: "http_json", url_template: "https://example.com/x", method: "GET" };

describe("cachesResults", () => {
  it("is true for every executor that is not a POST http_json, with or without [tools.cache]", () => {
    const others = [
      { type: "sitemap_filter", sitemap_url: "https://example.com/s.xml" },
      { type: "rss_feed", feed_url: "https://example.com/f.xml" },
      { type: "dom_extract", url_template: "https://example.com/p" },
      { type: "http_get", url_template: "https://example.com/t" },
      GET,
      { type: "http_json", url_template: "https://example.com/x" },
    ];
    for (const executor of others) {
      expect(cachesResults(tool(executor)), JSON.stringify(executor)).toBe(true);
      expect(cachesResults(tool(executor, { max_age: 0, s_maxage: 0 })), JSON.stringify(executor)).toBe(true);
    }
  });

  it("is false for a POST http_json without [tools.cache]", () => {
    expect(cachesResults(tool(POST))).toBe(false);
  });

  it("is true for a POST http_json only with an s_maxage greater than 0", () => {
    expect(cachesResults(tool(POST, { s_maxage: 1 }))).toBe(true);
    expect(cachesResults(tool(POST, { s_maxage: 3600, max_age: 0 }))).toBe(true);
  });

  it.each([
    ["an empty table", {}],
    ["max_age alone", { max_age: 300 }],
    ["swr and sie alone", { swr: 10, sie: 10 }],
    ["s_maxage = 0", { s_maxage: 0 }],
    ["s_maxage = 0 next to a positive max_age", { s_maxage: 0, max_age: 300 }],
  ])("is false for a POST http_json with %s", (_label, cache) => {
    expect(cachesResults(tool(POST, cache))).toBe(false);
  });
});
