import { describe, it, expect, vi, afterEach } from "vitest";
import { runRssFeed, parseFeed, MAX_FEED_BYTES, type FeedItem } from "./rss";

const ctx = {
  allowedOrigins: ["https://example.com"],
  deployToken: "t",
  timeoutMs: 1000,
  version: "0.0.0-test",
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

/**
 * The regex parser before v0.6.0's linear one, kept as the oracle, verbatim: a lazy match per
 * <item> or <entry> block (the back-reference ties a block to its own close tag), a lazy match per
 * field, one more for the link, CDATA unwrapped. Quadratic on a body of tags that never close: 240 KB
 * of <item> took 0.94 s.
 */
function referenceParseFeed(xml: string): FeedItem[] {
  const itemRe = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  const tagRe = (tag: string) => new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const extract = (block: string, re: RegExp): string | undefined => {
    const m = block.match(re);
    return m?.[1]?.trim();
  };
  const extractLink = (block: string): string | undefined => {
    const rss = block.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i);
    if (rss?.[1]?.trim()) return rss[1].trim();
    const atomLink = block.match(/<link\b[^>]*\bhref=("|')([^"']+)\1/i);
    return atomLink?.[2]?.trim();
  };
  const stripCdata = (s: string | undefined): string | undefined => {
    if (!s) return s;
    return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
  };
  const out: FeedItem[] = [];
  for (const m of xml.matchAll(itemRe)) {
    const block = m[2];
    if (!block) continue;
    const title = stripCdata(extract(block, tagRe("title"))) ?? "";
    const link = extractLink(block);
    const pub = stripCdata(
      extract(block, tagRe("pubDate")) ?? extract(block, tagRe("updated")) ?? extract(block, tagRe("published")),
    );
    const summary = stripCdata(
      extract(block, tagRe("description")) ?? extract(block, tagRe("summary")) ?? extract(block, tagRe("content")),
    ) ?? "";
    out.push({ title, url: link ?? "", published: pub ?? null, summary });
  }
  return out;
}

/** Bodies of tags that never close, and large well-formed feeds, each of `bytes` characters at most. */
const fillTo = (unit: string, bytes: number) => unit.repeat(Math.floor(bytes / unit.length));
const ALL_FIELD_TAGS = "<title><link><pubDate><updated><published><description><summary><content>";
const REAL_RSS_ITEM =
  "<item><title>Hello</title><link>https://example.com/hello</link><pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate><description><![CDATA[Body]]></description></item>";
const REAL_ATOM_ENTRY =
  '<entry><title>Hello</title><link href="https://example.com/hello"/><updated>2026-01-01T00:00:00Z</updated><summary>Body</summary></entry>';

/** [label, a function that makes the body, number of items it holds]. */
const adversarial = (bytes: number): Array<[string, () => string, number]> => [
  ["rss: unclosed <item>", () => fillTo("<item>", bytes), 0],
  ["rss: unclosed <item ...", () => fillTo("<item ", bytes), 0],
  ["rss: <item><title> pairs, never closed", () => fillTo("<item><title>", bytes), 0],
  ["rss: one item of unclosed <title>", () => `<item>${fillTo("<title>", bytes - 13)}</item>`, 1],
  ["rss: one item of unclosed <link>", () => `<item>${fillTo("<link>", bytes - 13)}</item>`, 1],
  ["rss: one item of every field tag, unclosed", () => `<item>${fillTo(ALL_FIELD_TAGS, bytes - 13)}</item>`, 1],
  ["rss: one item of unclosed CDATA", () => `<item><title>${fillTo("<![CDATA[", bytes - 34)}</title></item>`, 1],
  ["rss: nested <item>, closed once", () => `${fillTo("<item>", bytes - 7)}</item>`, 1],
  ["rss: <item> closed by </entry>", () => fillTo("<item></entry>", bytes), 0],
  ["rss: unclosed <item> after a real one", () => REAL_RSS_ITEM + fillTo("<item>", bytes - REAL_RSS_ITEM.length), 1],
  ["rss: one item of <link href=\"' and no >", () => `<item>${fillTo("<link href=\"'", bytes - 13)}</item>`, 1],
  ["atom: unclosed <entry>", () => fillTo("<entry>", bytes), 0],
  ["atom: <entry><link href= pairs, never closed", () => fillTo("<entry><link href=", bytes), 0],
  ["atom: one entry of <link href=\"' and no >", () => `<entry>${fillTo("<link href=\"'", bytes - 15)}</entry>`, 1],
  ["atom: one entry of <link ... and no >", () => `<entry>${fillTo("<link ", bytes - 15)}</entry>`, 1],
  ["atom: one entry of unclosed <link>", () => `<entry>${fillTo("<link>", bytes - 15)}</entry>`, 1],
  ["atom: one entry of mismatched quotes and no >", () => `<entry>${fillTo("<link href='x\" ", bytes - 15)}</entry>`, 1],
  ["atom: <entry> closed by </item>", () => fillTo("<entry></item>", bytes), 0],
  ["atom: one entry of every field tag, unclosed", () => `<entry>${fillTo(ALL_FIELD_TAGS, bytes - 15)}</entry>`, 1],
  ["atom: unclosed <entry> after a real one", () => REAL_ATOM_ENTRY + fillTo("<entry>", bytes - REAL_ATOM_ENTRY.length), 1],
];

describe("parseFeed reads a body in linear time", () => {
  // The body is origin's, up to MAX_FEED_BYTES. Every tag that never closes used to make the parser
  // scan to the end of the body again, and 2 MiB of it took minutes.
  const BYTES = MAX_FEED_BYTES;

  it.each(adversarial(BYTES))("parses 2 MiB of %s in under 500 ms", (_label, make, count) => {
    const xml = make();
    expect(xml.length).toBeGreaterThan(BYTES - 128);
    expect(xml.length).toBeLessThanOrEqual(BYTES);
    const start = performance.now();
    const items = parseFeed(xml);
    expect(performance.now() - start).toBeLessThan(500);
    expect(items).toHaveLength(count);
  });

  it.each([
    ["many small closed <item>", () => fillTo("<item>a</item>", BYTES), Math.floor(BYTES / 14)],
    ["many empty <item>", () => fillTo("<item></item>", BYTES), 0],
    ["many realistic RSS items", () => fillTo(REAL_RSS_ITEM, BYTES), Math.floor(BYTES / REAL_RSS_ITEM.length)],
    ["many realistic Atom entries", () => fillTo(REAL_ATOM_ENTRY, BYTES), Math.floor(BYTES / REAL_ATOM_ENTRY.length)],
  ])("parses 2 MiB of %s in under 500 ms", (_label, make, count) => {
    const xml = make();
    const start = performance.now();
    const items = parseFeed(xml);
    expect(performance.now() - start).toBeLessThan(500);
    expect(items).toHaveLength(count);
  });

  it.each([
    ["rss: unclosed <item>", () => fillTo("<item>", BYTES)],
    ["atom: one entry of <link ... and no >", () => `<entry>${fillTo("<link ", BYTES - 15)}</entry>`],
  ])("runRssFeed answers 2 MiB of %s in under 500 ms", async (_label, make) => {
    const xml = make();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(xml, { status: 200, headers: { "content-type": "application/rss+xml" } })),
    );
    const start = performance.now();
    const r = await runRssFeed(ctx, { feed_url: "https://example.com/feed", max_items: 20 }, {});
    expect(performance.now() - start).toBeLessThan(500);
    expect(r.ok).toBe(true);
  });

  it("gives the same items as the regex parser on every adversarial body, scaled down to 6 KB", () => {
    for (const [label, make] of adversarial(6000)) {
      const xml = make();
      expect(JSON.stringify(parseFeed(xml)), label).toBe(JSON.stringify(referenceParseFeed(xml)));
    }
  });
});

describe("parseFeed matches the regex parser", () => {
  // One entry per behaviour. Where the regex parser does something a reader would not expect, it is
  // kept, and the entry says so: the linear parser changes how the body is read, not what it returns.
  const samples: Array<[string, string]> = [
    ["fixture: RSS 2.0", rss20],
    ["fixture: Atom", atom],
    ["empty body", ``],
    ["no items", `<rss><channel><title>t</title><link>https://example.com/</link></channel></rss>`],
    [
      "tag names in any case",
      `<RSS><CHANNEL><ITEM><TITLE>Up</TITLE><LINK>https://example.com/up</LINK><PUBDATE>d</PUBDATE><DESCRIPTION>x</DESCRIPTION></ITEM></CHANNEL></RSS>`,
    ],
    ["close tag in another case than the open tag", `<item><title>a</title></ITEM><Entry><title>b</title></entry>`],
    // The back-reference: an <item> is closed by </item> only, an <entry> by </entry> only.
    ["<item> closed by </entry>", `<item><title>a</title></entry>`],
    ["<entry> closed by </item>", `<entry><title>a</title></item>`],
    ["<item> closed by </entry>, then a real <entry>", `<item><title>a</title></entry><entry><title>b</title></entry>`],
    ["<entry> around an <item>", `<entry>x<item>y</item>z</entry>`],
    ["<item> that swallows the </entry> and <item> after it", `<item>one</entry><entry>two</entry><item>three</item>`],
    ["<item> without any </item>, then an <entry>", `<item>no close <entry><title>e</title></entry>`],
    ["<entry> without any </entry>, then an <item>", `<entry>open<item><title>i</title></item>`],
    ["two <item> without a close, then an <entry>", `<item>u1<item>u2<entry><title>e</title></entry>`],
    ["<item start tag without >, then an <entry>", `<item <entry><title>e</title></entry>`],
    ["<item<entry> as one start tag", `<item<entry><title>x</title></entry></item>`],
    ["<entry> before <item> before </entry>", `<entry><title>a</title><item><title>b</title></entry></item>`],
    ["nested <item>", `<item><item><title>t</title></item></item>`],
    ["<entry> inside <item>", `<item><entry><title>in</title></entry></item>`],
    ["start tag with attributes over lines", `<item rdf:about="x"\n  xml:lang="en"><title>t</title></item>`],
    ["self-closing <item/>", `<item/>x</item>`],
    ["<items> and <entryx> and <item_x> are not items", `<items><title>no</title></items><entryx><title>no</title></entryx><item_x><title>no</title></item_x>`],
    ["<item-x> is an item", `<item-x><title>hy</title></item>`],
    ["empty and blank blocks", `<item></item><item> </item><item>\n</item>`],
    ["a block without fields", `<item>just text</item>`],
    ["a block of only unknown tags", `<item><guid>g</guid><author>a</author></item>`],
    ["unclosed last item", `<item><title>a</title></item><item><title>b</title>`],
    // Fields: the first element of a name wins, CDATA is unwrapped, entities are left as written.
    ["two titles, the first wins", `<item><title>one</title><title>two</title></item>`],
    ["title with attributes", `<item><title type="html">typed</title></item>`],
    ["title in CDATA", `<item><title><![CDATA[Tom & Jerry <3]]></title></item>`],
    ["title of empty CDATA", `<item><title><![CDATA[]]></title></item>`],
    ["title of two CDATA sections", `<item><title>a<![CDATA[b]]>c<![CDATA[d]]>e</title></item>`],
    ["title with an unclosed CDATA", `<item><title>a<![CDATA[b</title><description>d</description></item>`],
    ["title with a CDATA that closes after the title", `<item><title><![CDATA[a</title><description>d]]></description></item>`],
    ["title with entities", `<item><title>Tom &amp; Jerry &lt;3</title></item>`],
    ["description with escaped markup", `<item><description>&lt;p&gt;x&lt;/p&gt;</description></item>`],
    ["description in CDATA with markup", `<item><description><![CDATA[<p>x</p><b>y</b>]]></description></item>`],
    ["title with a dollar sign and a replacement pattern", `<item><title><![CDATA[$1 $& $$]]></title></item>`],
    ["empty title", `<item><title></title><link>https://example.com/e</link></item>`],
    ["blank title", `<item><title>   </title></item>`],
    ["<title/> then text then </title>", `<item><title/>x</title></item>`],
    ["</title > with a space does not close", `<item><title >spaced</title ></item>`],
    ["<titlex> and <media:title> are not <title>", `<item><titlex>no</titlex><media:title>no</media:title><title>yes</title></item>`],
    ["<content:encoded> reads as <content>", `<item><title>t</title><content:encoded><![CDATA[<p>full</p>]]></content:encoded><description>d</description></item>`],
    ["<content:encoded> alone", `<item><content:encoded>x</content:encoded><content>y</content></item>`],
    ["date from pubDate, updated and published", `<item><published>P</published><updated>U</updated><pubDate>D</pubDate></item>`],
    ["date from updated", `<entry><updated>U</updated><published>P</published></entry>`],
    ["date from published", `<entry><published>P</published></entry>`],
    // Kept: an element that is there but empty counts as present, so the next name is not tried.
    ["empty pubDate hides updated", `<item><pubDate></pubDate><updated>U</updated></item>`],
    ["blank pubDate hides updated", `<item><pubDate>  </pubDate><updated>U</updated></item>`],
    ["pubDate of empty CDATA hides updated", `<item><pubDate><![CDATA[]]></pubDate><updated>U</updated></item>`],
    ["pubDate in CDATA", `<item><pubDate><![CDATA[Mon, 01 Jan 2026]]></pubDate></item>`],
    ["summary from description, summary and content", `<entry><content type="html">K</content><summary>S</summary><description>D</description></entry>`],
    ["summary from summary", `<entry><content>K</content><summary>S</summary></entry>`],
    ["summary from content", `<entry><content type="html">K</content></entry>`],
    ["empty description hides summary", `<item><description></description><summary>S</summary></item>`],
    ["channel title and link outside an item are ignored", `<channel><title>c</title><link>https://example.com/</link><item><description>d</description></item></channel>`],
    // The link: RSS <link>text</link> first, then an Atom href.
    ["RSS link", `<item><link>https://example.com/a</link></item>`],
    ["RSS link with blanks", `<item><link>\n  https://example.com/a\n</link></item>`],
    ["RSS link with attributes", `<item><link rel="x">https://example.com/a</link></item>`],
    ["two RSS links, the first wins", `<item><link>https://example.com/1</link><link>https://example.com/2</link></item>`],
    // Kept: a link in CDATA is not unwrapped, so its url is the CDATA text as written.
    ["RSS link in CDATA", `<item><link><![CDATA[https://example.com/c]]></link></item>`],
    // Kept: only the first <link>...</link> is read as RSS; when it is empty the Atom form is tried.
    ["empty RSS link, then an Atom href", `<item><link></link><link href="https://example.com/after-empty"/></item>`],
    ["blank RSS link, then a second RSS link", `<item><link> </link><link>https://example.com/second</link></item>`],
    ["empty RSS link and nothing else", `<item><link></link></item>`],
    ["Atom href with double quotes", `<entry><link href="https://example.com/d"/></entry>`],
    ["Atom href with single quotes", `<entry><link href='https://example.com/s'/></entry>`],
    ["Atom href with a quote of the other kind inside", `<entry><link href="it's"/></entry>`],
    ["Atom href with other attributes around it", `<entry><link rel="alternate" type="text/html" href="https://example.com/h" title="t"/></entry>`],
    // Kept: rel is not looked at. The first <link> with an href wins, whatever its rel.
    ["rel=self before rel=alternate", `<entry><link rel="self" href="https://example.com/self"/><link rel="alternate" href="https://example.com/alt"/></entry>`],
    // Kept: with two hrefs in one start tag the last valid one wins.
    ["two href attributes in one tag", `<entry><link href="https://example.com/a" href="https://example.com/b"/></entry>`],
    ["two hrefs, the last empty", `<entry><link href="https://example.com/a" href=""/></entry>`],
    ["two hrefs, the last unclosed", `<entry><link href="https://example.com/a" href="b/></entry>`],
    ["uppercase HREF", `<entry><LINK HREF="https://example.com/up"/></entry>`],
    ["data-href counts, xhref does not", `<entry><link xhref="no"/><link data-href="https://example.com/data"/></entry>`],
    ["xhref only", `<entry><link xhref="no"/></entry>`],
    ["space around =", `<entry><link href = "https://example.com/x"/></entry>`],
    ["unquoted href", `<entry><link href=https://example.com/x/></entry>`],
    ["empty href", `<entry><link href=""/></entry>`],
    ["empty href, then a second link", `<entry><link href=""/><link href="https://example.com/second"/></entry>`],
    ["blank href", `<entry><link href=" "/></entry>`],
    ["blank href, then a second link", `<entry><link href=" "/><link href="https://example.com/second"/></entry>`],
    ["href padded with blanks", `<entry><link href="  https://example.com/pad  "/></entry>`],
    ["first link without href, second with", `<entry><link rel="x"/><link href="https://example.com/second"/></entry>`],
    // Kept: the value may run past the end of the start tag, up to the next quote.
    ["href value with a > in it", `<entry><link href="https://example.com/a>b"/></entry>`],
    ["href value that runs past the tag end", `<entry><link href="https://example.com/a>text<b/>more"/></entry>`],
    ["mismatched quotes, then a good href", `<entry><link href="a' href='https://example.com/good'/></entry>`],
    ["mismatched quotes only", `<entry><link href="a'/></entry>`],
    ["unclosed quote", `<entry><link href="https://example.com/open/></entry>`],
    ["href in the last start tag, which has no >", `<entry><link href="https://example.com/nogt"</entry>`],
    ["link start tag without > and no href", `<entry><link rel="x"</entry>`],
    ["<link <link href=...> nested start", `<entry><link <link href="https://example.com/in"/></entry>`],
    ["<link> of RSS first, then an Atom href", `<entry><link>https://example.com/rss</link><link href="https://example.com/atom"/></entry>`],
    // Kept: an Atom <link .../> before a later </link> reads as an RSS link: everything up to </link>.
    ["Atom href, then an RSS link", `<entry><link href="https://example.com/atom"/><link>https://example.com/rss</link></entry>`],
    ["Atom href, </link> far away", `<entry><link href="https://example.com/atom"/><title>t</title></link></entry>`],
    ["<linkx href> is not a link", `<entry><linkx href="https://example.com/no"/></entry>`],
    ["<link-x href> is a link", `<entry><link-x href="https://example.com/yes"/></entry>`],
    ["href inside a title is not looked for", `<entry><title>href="https://example.com/no"</title></entry>`],
    ["href in a later tag than the first link", `<entry><link/><link/><link href="https://example.com/third"/></entry>`],
    ["one block of every kind", `${rss20}${atom}`],
  ];

  it("gives the same items for the samples, in the same field order", () => {
    for (const [label, xml] of samples) {
      expect(JSON.stringify(parseFeed(xml)), label).toBe(JSON.stringify(referenceParseFeed(xml)));
    }
  });

  it("compares samples that hold items with links, dates, summaries and titles, not just empty ones", () => {
    const outputs = samples.map(([, xml]) => referenceParseFeed(xml));
    expect(outputs.filter((o) => o.length > 0).length).toBeGreaterThan(samples.length * 0.8);
    expect(outputs.filter((o) => o.some((i) => i.url !== "")).length).toBeGreaterThan(25);
    expect(outputs.filter((o) => o.some((i) => i.published !== null)).length).toBeGreaterThan(8);
    expect(outputs.filter((o) => o.some((i) => i.summary !== "")).length).toBeGreaterThan(10);
    expect(outputs.filter((o) => o.some((i) => i.title !== "")).length).toBeGreaterThan(24);
  });

  /** A seeded generator, so that a failure can be reproduced. */
  const seeded = (seed: number) => {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const pick = <T>(next: () => number, from: readonly T[]): T => from[Math.floor(next() * from.length)] as T;

  it("gives the same items as the regex parser on 20,000 random token strings", () => {
    const next = seeded(0x2f5eed01);
    // The structural tokens are listed several times, so that enough strings form items.
    const tokens = [
      ...Array<string>(3).fill("<item>"), ...Array<string>(3).fill("</item>"),
      ...Array<string>(3).fill("<entry>"), ...Array<string>(3).fill("</entry>"),
      "<ITEM>", "</Item>", "<Entry>", "</ENTRY>", "<item a='1'>", "<item ", "<entry ", "<items>", "<entry-x>",
      "<title>", "<title>", "</title>", "</title>", "<title ", "<link>", "</link>", "<link ",
      '<link href="u"/>', "<link href='v'/>", '<link rel="r" href="w">', 'href="a"', "href='b'", 'HREF="x"', "data-href='d'", 'xhref="z"',
      "href=", '"', "'",
      "<pubDate>", "</pubDate>", "<updated>", "</updated>", "<published>", "</published>",
      "<description>", "</description>", "<summary>", "</summary>", "<content>", "</content>",
      "<![CDATA[", "]]>", "a", "b", " ", ">", "<", "/", "\n", "&amp;", "$&",
    ];
    const mismatches: string[] = [];
    let withItems = 0;
    for (let i = 0; i < 20_000; i++) {
      let xml = "";
      const n = Math.floor(next() * 24);
      for (let k = 0; k < n; k++) xml += pick(next, tokens);
      const want = referenceParseFeed(xml);
      if (want.length > 0) withItems++;
      const got = parseFeed(xml);
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${JSON.stringify(xml)}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(withItems).toBeGreaterThan(1500);
  });

  it("gives the same items as the regex parser on 20,000 random feeds of whole elements and broken ones", () => {
    const next = seeded(0x51a7f00d);
    const opens = ["<item>", "<item>", "<item>", "<entry>", "<entry>", "<entry>", "<ITEM>", "<Entry>", "<item a='1'>", "<item\n>", "<items>", "<item "];
    const closes = ["</item>", "</item>", "</item>", "</entry>", "</entry>", "</entry>", "</Item>", "</ENTRY>", "", "</items>"];
    const fields = [
      "<title>A</title>", "<TITLE>B</TITLE>", "<title><![CDATA[C]]></title>", "<title></title>", "<title>", "<title>x<![CDATA[y</title>",
      "<link>https://e.com/1</link>", "<link></link>", "<link> </link>", "<link><![CDATA[https://e.com/c]]></link>", "<link>",
      '<link href="u"/>', "<link href='v' rel=\"alt\"/>", '<link rel="self" href="w"></link>', '<link href="a" href="b"/>', '<link HREF="x"/>',
      '<link data-href="d"/>', '<link xhref="z"/>', '<link href=""/>', '<link href=" "/>', '<link href="p>q"/>', "<link href=\"r'", "<link href='s\"/>",
      "<link ", "<link rel='x'", '<link href="t"',
      "<pubDate>D1</pubDate>", "<pubDate></pubDate>", "<updated>U</updated>", "<published>P</published>", "<published><![CDATA[Q]]></published>",
      "<description>x &amp; y</description>", "<description><![CDATA[<b>z</b>]]></description>", "<description><![CDATA[unclosed</description>",
      "<description></description>", "<summary>S</summary>", '<content type="html">K</content>', "<content:encoded>E</content:encoded>",
      "<media:content url='m'/>", "<![CDATA[", "]]>", "t", "\n", " ", "<", ">", "/>",
    ];
    const mismatches: string[] = [];
    const seen = { items: 0, urls: 0, hrefUrls: 0, dates: 0, summaries: 0, titles: 0 };
    const hrefValues = new Set(["u", "v", "w", "b", "x", "d", "p>q", "r", "s", "t"]);
    for (let i = 0; i < 20_000; i++) {
      let xml = next() < 0.3 ? "<channel><title>c</title><link>https://e.com/</link>" : "";
      const blocks = 1 + Math.floor(next() * 3);
      for (let b = 0; b < blocks; b++) {
        xml += pick(next, opens);
        const k = Math.floor(next() * 7);
        for (let f = 0; f < k; f++) xml += pick(next, fields);
        xml += pick(next, closes);
      }
      const want = referenceParseFeed(xml);
      if (want.length > 0) seen.items++;
      for (const item of want) {
        if (item.url !== "") seen.urls++;
        if (hrefValues.has(item.url)) seen.hrefUrls++;
        if (item.published !== null) seen.dates++;
        if (item.summary !== "") seen.summaries++;
        if (item.title !== "") seen.titles++;
      }
      const got = parseFeed(xml);
      if (JSON.stringify(got) !== JSON.stringify(want)) mismatches.push(`${JSON.stringify(xml)}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(seen.items).toBeGreaterThan(9_000);
    expect(seen.urls).toBeGreaterThan(5_000);
    expect(seen.hrefUrls).toBeGreaterThan(1_500);
    expect(seen.dates).toBeGreaterThan(3_000);
    expect(seen.summaries).toBeGreaterThan(3_000);
    expect(seen.titles).toBeGreaterThan(3_000);
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

  it("reads the feed through a size cap of 2 MiB", async () => {
    expect(MAX_FEED_BYTES).toBe(2 * 1024 * 1024);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("a".repeat(MAX_FEED_BYTES + 1), { status: 200, headers: { "content-type": "application/rss+xml" } }),
      ),
    );
    const r = await runRssFeed(ctx, { feed_url: "https://example.com/feed", max_items: 5 }, {});
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("response_too_large");
  });

  it("accepts a feed of exactly the cap", async () => {
    const padded = rss20 + " ".repeat(MAX_FEED_BYTES - rss20.length);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(padded, { status: 200, headers: { "content-type": "application/rss+xml" } })),
    );
    const r = await runRssFeed(ctx, { feed_url: "https://example.com/feed", max_items: 5 }, {});
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect((r.data as { items: unknown[] }).items).toHaveLength(2);
  });
});
