import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSitemapFilter, parseSitemap } from "./sitemap";
import type { ExecutorContext } from "./common";

const ctx: ExecutorContext = {
  allowedOrigins: ["https://example.com"],
  deployToken: "test-token",
  timeoutMs: 1000,
};

const fakeSitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/about</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://example.com/blog/hello-world</loc></url>
  <url><loc>https://example.com/pricing</loc></url>
</urlset>`;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/sitemap.xml")) {
        return new Response(fakeSitemap, {
          status: 200,
          headers: { "content-type": "application/xml" },
        });
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSitemap", () => {
  it("extracts loc entries", () => {
    const entries = parseSitemap(fakeSitemap);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ url: "https://example.com/about", lastmod: "2026-01-01" });
    expect(entries[1]?.url).toBe("https://example.com/blog/hello-world");
  });

  it("ignores malformed sections gracefully", () => {
    const broken = `<urlset><url><loc>x</loc></url><url>broken`;
    const entries = parseSitemap(broken);
    expect(entries).toEqual([{ url: "x" }]);
  });
});

describe("runSitemapFilter", () => {
  it("returns all entries when no query is given", async () => {
    const result = await runSitemapFilter(
      ctx,
      { sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      {},
    );
    if (!result.ok) throw new Error("expected success");
    expect((result.data as { entries: unknown[] }).entries).toHaveLength(3);
  });

  it("filters by substring match (case-insensitive)", async () => {
    const result = await runSitemapFilter(
      ctx,
      { sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      { query: "BLOG" },
    );
    if (!result.ok) throw new Error("expected success");
    const entries = (result.data as { entries: Array<{ url: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toContain("/blog/");
  });

  it("respects max_results", async () => {
    const result = await runSitemapFilter(
      ctx,
      { sitemap_url: "https://example.com/sitemap.xml", max_results: 2 },
      {},
    );
    if (!result.ok) throw new Error("expected success");
    expect((result.data as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it("rejects a sitemap_url outside allowed_origins", async () => {
    const result = await runSitemapFilter(
      ctx,
      { sitemap_url: "https://other.example.com/sitemap.xml", max_results: 10 },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("internal");
  });

  it("maps origin 5xx into envelope error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 503 })),
    );
    const result = await runSitemapFilter(
      ctx,
      { sitemap_url: "https://example.com/sitemap.xml", max_results: 10 },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("origin_5xx");
  });
});
