import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildConfig } from "./build-config";

/**
 * Build-config tests work in a sandbox temp dir per test:
 *   - write input TOML to fixtures/in.toml
 *   - run buildConfig({ tomlPath, outDir })
 *   - assert on emitted files
 */

const MINIMAL = `
schema_version = 1

[site]
domain = "example.com"
name   = "Example Co."

[origin]
base_url        = "https://example.com"
allowed_origins = ["https://example.com"]

[[tools]]
name        = "search_pages"
description = "Search the site."

  [tools.input_schema]
  type     = "object"
  required = ["query"]

    [tools.input_schema.properties.query]
    type = "string"

  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"
`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-build-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeToml(name: string, contents: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, contents);
  return p;
}

async function runBuild(tomlPath: string): Promise<{ outDir: string; files: Record<string, string> }> {
  const outDir = path.join(tmpDir, "out");
  await buildConfig({ tomlPath, outDir });
  const names = await fs.readdir(outDir);
  const files: Record<string, string> = {};
  for (const n of names) {
    files[n] = await fs.readFile(path.join(outDir, n), "utf8");
  }
  return { outDir, files };
}

describe("buildConfig", () => {
  it("compiles a minimal valid TOML and emits all artefacts", async () => {
    const toml = await writeToml("a.toml", MINIMAL);
    const { files } = await runBuild(toml);
    expect(files).toHaveProperty("manifest.json");
    expect(files).toHaveProperty("bootstrap.js");
    expect(files).toHaveProperty("landing.html");
    expect(files).toHaveProperty("config.ts");
    expect(files).toHaveProperty("hash.ts");

    const manifest = JSON.parse(files["manifest.json"]!);
    expect(manifest.schema_version).toBe(1);
    expect(manifest.site.domain).toBe("example.com");
    expect(manifest.tools).toHaveLength(1);
    expect(manifest.tools[0].name).toBe("search_pages");
    expect(manifest.tools[0].endpoint).toBe("https://example.com/_webmcp/exec/search_pages");
    expect(typeof manifest.config_hash).toBe("string");
    expect(manifest.config_hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it("produces stable config hash for stable input", async () => {
    const toml = await writeToml("a.toml", MINIMAL);
    const first = await runBuild(toml);
    await fs.rm(first.outDir, { recursive: true });
    const second = await runBuild(toml);
    const h1 = JSON.parse(first.files["manifest.json"]!).config_hash;
    const h2 = JSON.parse(second.files["manifest.json"]!).config_hash;
    expect(h1).toBe(h2);
  });

  it("rejects a TOML missing required fields", async () => {
    const toml = await writeToml("bad.toml", `schema_version = 1\n[site]\nname="x"\n`);
    await expect(runBuild(toml)).rejects.toThrow(/validation failed/i);
  });

  it("rejects a path with characters unsafe in HTTP headers", async () => {
    // One representative from every class blocked by PATH_BAD_CHARS:
    //   - HTML / Link bracket delimiters: < > "
    //   - whitespace and C0 controls (response-splitting in Location): space, TAB, CR, LF, NUL
    //   - RFC 3986 excluded literals: \ ^ ` { | }
    //   - C1 control (high-byte parser confusion): \x80
    const cases = [
      "/foo<bar",
      "/foo>bar",
      '/foo"bar',
      "/foo bar",
      "/foo\tbar",
      "/foo\rbar",
      "/foo\nbar",
      "/foo\x00bar",
      "/foo\\bar",
      "/foo^bar",
      "/foo`bar",
      "/foo{bar",
      "/foo|bar",
      "/foo}bar",
      "/foo\x80bar",
      "/foo\u2028bar",
      "/foo\u2029bar",
    ];
    for (const bad of cases) {
      const toml = `${MINIMAL}\n\n[manifest]\npath = ${JSON.stringify(bad)}\n`;
      const f = await writeToml(`bad-${Buffer.from(bad).toString("hex")}.toml`, toml);
      await expect(runBuild(f), `path ${JSON.stringify(bad)} should be rejected`).rejects.toThrow(/unsafe in HTTP headers|validation failed/i);
    }
  });

  it("accepts RFC 3986 unreserved and sub-delim characters in paths", async () => {
    // Sanity: chars that look unusual but are legal per RFC 3986 must still pass.
    // Catches a regression where the bad-char set accidentally over-blocks.
    const good = [
      "/foo~bar",
      "/foo%20bar",
      "/foo@bar",
      "/foo+bar",
      "/foo,bar",
      "/foo:bar",
      "/foo;bar",
      "/foo=bar",
      "/foo!bar",
    ];
    for (const ok of good) {
      const toml = `${MINIMAL}\n\n[manifest]\npath = ${JSON.stringify(ok)}\n`;
      const f = await writeToml(`ok-${Buffer.from(ok).toString("hex")}.toml`, toml);
      const result = await runBuild(f);
      expect(result.files, `path ${JSON.stringify(ok)} should be accepted`).toHaveProperty("manifest.json");
    }
  });

  it("rejects a tool whose url_template can escape allowed_origins", async () => {
    const evil = `${MINIMAL}

[[tools]]
name        = "leak"
description = "leaks"

  [tools.input_schema]
  type = "object"

  [tools.executor]
  type         = "http_json"
  url_template = "https://other.example.com/{{anything|default:x}}"
`;
    const toml = await writeToml("evil.toml", evil);
    await expect(runBuild(toml)).rejects.toThrow(/allowed_origins/i);
  });

  it("accepts a url_template that stays within allowed_origins", async () => {
    const good = `${MINIMAL}

[[tools]]
name        = "search_site"
description = "Search."

  [tools.input_schema]
  type     = "object"
  required = ["q"]

    [tools.input_schema.properties.q]
    type = "string"

  [tools.executor]
  type         = "http_json"
  url_template = "https://example.com/wp-json/wp/v2/search?search={{q}}"
`;
    const toml = await writeToml("good.toml", good);
    const { files } = await runBuild(toml);
    const manifest = JSON.parse(files["manifest.json"]!);
    expect(manifest.tools).toHaveLength(2);
  });

  it("merges via inherits and child overrides parent tool of same name", async () => {
    const parent = `
schema_version = 1
[site]
domain = "example.com"
name   = "Example"
[origin]
base_url        = "https://example.com"
allowed_origins = ["https://example.com"]

[[tools]]
name        = "search_pages"
description = "parent description"
  [tools.input_schema]
  type = "object"
  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"

[[tools]]
name        = "list_posts"
description = "from parent"
  [tools.input_schema]
  type = "object"
  [tools.executor]
  type     = "rss_feed"
  feed_url = "https://example.com/feed/"
`;
    const child = `
inherits = "parent.toml"
schema_version = 1
[site]
domain = "example.com"
name   = "Example"
[origin]
base_url        = "https://example.com"
allowed_origins = ["https://example.com"]

[[tools]]
name        = "search_pages"
description = "child description"
  [tools.input_schema]
  type = "object"
  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"
`;
    await writeToml("parent.toml", parent);
    const childPath = await writeToml("child.toml", child);
    const { files } = await runBuild(childPath);
    const manifest = JSON.parse(files["manifest.json"]!);
    const names = manifest.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["list_posts", "search_pages"]);
    const search = manifest.tools.find((t: { name: string }) => t.name === "search_pages");
    expect(search.description).toBe("child description");
  });

  it("rejects chained inheritance", async () => {
    const grand = `schema_version = 1\n[site]\ndomain="x"\nname="x"\n[origin]\nbase_url="https://x.example"\nallowed_origins=["https://x.example"]\n`;
    const mid = `inherits="grand.toml"\nschema_version = 1\n[site]\ndomain="x"\nname="x"\n[origin]\nbase_url="https://x.example"\nallowed_origins=["https://x.example"]\n`;
    const child = `inherits="mid.toml"\nschema_version = 1\n[site]\ndomain="x"\nname="x"\n[origin]\nbase_url="https://x.example"\nallowed_origins=["https://x.example"]\n`;
    await writeToml("grand.toml", grand);
    await writeToml("mid.toml", mid);
    const childPath = await writeToml("child.toml", child);
    await expect(runBuild(childPath)).rejects.toThrow(/chained inheritance/);
  });

  it("bootstrap.js contains every tool name", async () => {
    const toml = await writeToml("a.toml", MINIMAL);
    const { files } = await runBuild(toml);
    expect(files["bootstrap.js"]).toContain("search_pages");
    expect(files["bootstrap.js"]).toContain("navigator.modelContext");
    expect(files["bootstrap.js"]).toContain("registerTool");
  });

  it("bootstrap.js emits WebMCP ToolAnnotations defaults per executor type", async () => {
    // MINIMAL uses sitemap_filter -> readOnlyHint:true, untrustedContentHint:false
    const toml = await writeToml("annot-sitemap.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const js = files["bootstrap.js"]!;
    expect(js).toContain('"name":"search_pages"');
    expect(js).toContain('"annotations":{"readOnlyHint":true,"untrustedContentHint":false}');
  });

  it("bootstrap.js sets untrustedContentHint:true for content-fetching executors", async () => {
    const withDom = `${MINIMAL}

[[tools]]
name        = "get_page"
description = "Fetch a page"

  [tools.input_schema]
  type     = "object"
  required = ["path"]

    [tools.input_schema.properties.path]
    type = "string"

  [tools.executor]
  type         = "dom_extract"
  url_template = "https://example.com{{path}}"
`;
    const toml = await writeToml("annot-dom.toml", withDom);
    const { files } = await runBuild(toml);
    const js = files["bootstrap.js"]!;
    expect(js).toContain('"name":"get_page"');
    expect(js).toContain('"annotations":{"readOnlyHint":true,"untrustedContentHint":true}');
  });

  it("bootstrap.js honors per-tool [tools.annotations] overrides", async () => {
    const withOverride = `${MINIMAL}

  [tools.annotations]
  read_only_hint = false
  untrusted_content_hint = true
`;
    const toml = await writeToml("annot-override.toml", withOverride);
    const { files } = await runBuild(toml);
    const js = files["bootstrap.js"]!;
    // Default for sitemap_filter would be readOnlyHint:true, untrustedContentHint:false.
    // Override should flip both.
    expect(js).toContain('"name":"search_pages"');
    expect(js).toContain('"annotations":{"readOnlyHint":false,"untrustedContentHint":true}');
  });

  it("bootstrap.js emits title only when set on the tool", async () => {
    const withTitle = `${MINIMAL.replace(
      'description = "Search the site."',
      'title       = "Page Search"\ndescription = "Search the site."',
    )}`;
    const toml = await writeToml("title-set.toml", withTitle);
    const { files } = await runBuild(toml);
    const js = files["bootstrap.js"]!;
    expect(js).toContain('"title":"Page Search"');
    // And the no-title case should not emit a title field.
    const tomlNoTitle = await writeToml("title-absent.toml", MINIMAL);
    const { files: filesNoTitle } = await runBuild(tomlNoTitle);
    expect(filesNoTitle["bootstrap.js"]!).not.toContain('"title"');
  });

  it("landing.html escapes site description HTML", async () => {
    const toml = await writeToml(
      "evil-site.toml",
      MINIMAL.replace(`name   = "Example Co."`, `name   = "<script>alert(1)</script>"`),
    );
    const { files } = await runBuild(toml);
    expect(files["landing.html"]).not.toContain("<script>alert(1)</script>");
    expect(files["landing.html"]).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
