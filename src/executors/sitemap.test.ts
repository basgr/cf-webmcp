import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runSitemapFilter, parseSitemap, MAX_SITEMAP_BYTES } from "./sitemap";
import type { ExecutorContext } from "./common";

const ctx: ExecutorContext = {
  allowedOrigins: ["https://example.com"],
  deployToken: "test-token",
  timeoutMs: 1000,
  version: "0.0.0-test",
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

/**
 * The regex parser before v0.6.0's linear one, kept as the oracle: a lazy match per <url> block,
 * then a lazy match per tag, CDATA unwrapped. Quadratic on a body of unclosed tags.
 */
function referenceParse(xml: string): Array<{ url: string; lastmod?: string }> {
  const extract = (block: string, tag: string): string | undefined => {
    const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (!m || !m[1]) return undefined;
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  };
  const out: Array<{ url: string; lastmod?: string }> = [];
  for (const m of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    const block = m[1];
    if (!block) continue;
    const loc = extract(block, "loc");
    if (!loc) continue;
    const lastmod = extract(block, "lastmod");
    out.push(lastmod !== undefined ? { url: loc, lastmod } : { url: loc });
  }
  return out;
}

describe("parseSitemap reads a body in linear time", () => {
  // The body is origin's, up to MAX_SITEMAP_BYTES. Every tag that never closes used to make the
  // parser scan to the end of the body again: 400 KB of <url> took 4.8 s.
  const FIVE_MIB = MAX_SITEMAP_BYTES;
  const fill = (unit: string) => unit.repeat(Math.floor(FIVE_MIB / unit.length));

  it.each([
    ["unclosed <url>", () => fill("<url>")],
    ["unclosed <url ...", () => fill("<url ")],
    ["<url><loc> pairs, never closed", () => fill("<url><loc>")],
    ["one block of unclosed <loc>", () => `<url>${fill("<loc>")}</url>`],
    ["one <loc> of unclosed CDATA", () => `<url><loc>${fill("<![CDATA[")}</loc></url>`],
    ["unclosed <url> after a real entry", () => `<url><loc>https://example.com/a</loc></url>${fill("<url>")}`],
  ])("parses 5 MiB of %s in under 500 ms", (_label, make) => {
    const xml = make();
    expect(xml.length).toBeGreaterThan(FIVE_MIB - 16);
    const start = performance.now();
    parseSitemap(xml);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("gives the same entries as the regex parser for well-formed and odd sitemaps", () => {
    const samples = [
      fakeSitemap,
      `<urlset><url><loc>x</loc></url><url>broken`,
      `<URLSET><URL><LOC>https://example.com/UPPER</LOC><LASTMOD>2026-02-02</LASTMOD></URL></URLSET>`,
      `<urlset><url priority="0.5"><loc type="x"> https://example.com/attr </loc></url></urlset>`,
      `<urlset><url><loc><![CDATA[https://example.com/cdata?a=1&b=2]]></loc><lastmod><![CDATA[2026]]></lastmod></url></urlset>`,
      `<urlset><url><loc></loc></url><url><loc>  </loc></url><url><lastmod>2026</lastmod></url></urlset>`,
      `<urlset><url-x><loc>https://example.com/hyphen</loc></url-x></urlset>`,
      `<urlset><urlx><loc>https://example.com/word</loc></urlx></urlset>`,
      `<url><loc>a</loc><loc>b</loc></url><url><location>c</location><loc>d</loc></url>`,
      `<url><loc>a<loc>b</loc></url>`,
      `<url><loc>a</loc>`,
      `<url\n  xmlns:image="x"\n><loc>https://example.com/newline</loc></url>`,
      `<url><loc>https://example.com/a</loc></url ><url><loc>b</loc></url>`,
      ``,
    ];
    for (const xml of samples) expect(parseSitemap(xml), xml).toEqual(referenceParse(xml));
  });

  it("gives the same entries as the regex parser on 20,000 random token strings", () => {
    let a = 0x51735eed;
    const next = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // The structural tokens are listed several times, so that enough strings form entries.
    const tokens = [
      ...Array<string>(4).fill("<url>"), ...Array<string>(4).fill("</url>"), "<URL>", "</URL>", "<url a='1'>", "<url ", "<url-x>", "<urlset>",
      ...Array<string>(4).fill("<loc>"), ...Array<string>(4).fill("</loc>"), "<LOC>", "<loc x>", "<lastmod>", "</lastmod>",
      "<![CDATA[", "]]>", "a", "a", "b", " ", ">", "<", "/", "\n",
    ];
    const mismatches: string[] = [];
    let withEntries = 0;
    for (let i = 0; i < 20_000; i++) {
      let xml = "";
      const n = Math.floor(next() * 16);
      for (let k = 0; k < n; k++) xml += tokens[Math.floor(next() * tokens.length)];
      const want = referenceParse(xml);
      if (want.length > 0) withEntries++;
      const got = parseSitemap(xml);
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${JSON.stringify(xml)}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(withEntries).toBeGreaterThan(200);
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

  it("reads the sitemap through a size cap of 5 MiB", async () => {
    expect(MAX_SITEMAP_BYTES).toBe(5 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("a".repeat(MAX_SITEMAP_BYTES + 1), {
            status: 200,
            headers: { "content-type": "application/xml" },
          }),
      ),
    );
    const result = await runSitemapFilter(
      ctx,
      { sitemap_url: "https://example.com/sitemap.xml", max_results: 10 },
      {},
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("response_too_large");
  });

  it("accepts a sitemap of exactly the cap", async () => {
    const padded = fakeSitemap + " ".repeat(MAX_SITEMAP_BYTES - fakeSitemap.length);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(padded, { status: 200, headers: { "content-type": "application/xml" } })),
    );
    const result = await runSitemapFilter(
      ctx,
      { sitemap_url: "https://example.com/sitemap.xml", max_results: 10 },
      {},
    );
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect((result.data as { entries: unknown[] }).entries).toHaveLength(3);
  });
});
