import { describe, it, expect, vi, afterEach } from "vitest";
import { runRssFeed, parseFeed } from "./rss";

const ctx = {
  allowedOrigins: ["https://example.com"],
  deployToken: "t",
  timeoutMs: 1000,
};

const rss20 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Site</title>
  <item>
    <title>Hello World</title>
    <link>https://example.com/hello-world</link>
    <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    <description><![CDATA[A first post.]]></description>
  </item>
  <item>
    <title>Second</title>
    <link>https://example.com/second</link>
    <description>plain description</description>
  </item>
</channel></rss>`;

const atom = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Atom Post</title>
    <link href="https://example.com/atom-post"/>
    <updated>2026-02-01T00:00:00Z</updated>
    <summary>Atom summary</summary>
  </entry>
</feed>`;

afterEach(() => vi.unstubAllGlobals());

describe("parseFeed", () => {
  it("parses RSS 2.0 items", () => {
    const items = parseFeed(rss20);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe("Hello World");
    expect(items[0]?.url).toBe("https://example.com/hello-world");
    expect(items[0]?.summary).toBe("A first post.");
    expect(items[0]?.published).toMatch(/2026/);
  });

  it("parses Atom entries", () => {
    const items = parseFeed(atom);
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe("https://example.com/atom-post");
    expect(items[0]?.published).toBe("2026-02-01T00:00:00Z");
  });
});

describe("runRssFeed", () => {
  it("returns items capped by max_items", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(rss20, { status: 200, headers: { "content-type": "application/rss+xml" } })),
    );
    const r = await runRssFeed(ctx, { feed_url: "https://example.com/feed", max_items: 1 }, {});
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect((r.data as { items: unknown[] }).items).toHaveLength(1);
  });

  it("rejects feed_url outside allowed_origins", async () => {
    const r = await runRssFeed(ctx, { feed_url: "https://other.example.com/feed", max_items: 5 }, {});
    expect(r.ok).toBe(false);
  });

  it("maps 5xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
    const r = await runRssFeed(ctx, { feed_url: "https://example.com/feed", max_items: 5 }, {});
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("origin_5xx");
  });
});
