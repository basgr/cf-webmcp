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
    // Host detection covers both the navigator.modelContext (Chrome Canary)
    // and document.modelContext (Apr 2026 WebMCP draft) bindings.
    expect(files["bootstrap.js"]).toContain("navigator.modelContext");
    expect(files["bootstrap.js"]).toContain("document.modelContext");
    expect(files["bootstrap.js"]).toContain("registerTool");
    // execute returns the MCP tool-result shape (content array), not the raw
    // cf-webmcp envelope.
    expect(files["bootstrap.js"]).toContain("content");
    expect(files["bootstrap.js"]).toContain("isError");
    // The stale provideContext fallback must be gone (not in current API).
    expect(files["bootstrap.js"]).not.toContain("provideContext");
  });

  it("bootstrap.js prefers document.modelContext over navigator.modelContext", async () => {
    // document.modelContext is the current binding (Chrome 150+); navigator is
    // the deprecated 146-149 one and touching it logs a console deprecation
    // warning. Probe document first.
    const toml = await writeToml("host-order.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const js = files["bootstrap.js"]!;
    const docIdx = js.indexOf("document.modelContext");
    const navIdx = js.indexOf("navigator.modelContext");
    expect(docIdx).toBeGreaterThan(-1);
    expect(navIdx).toBeGreaterThan(-1);
    expect(docIdx).toBeLessThan(navIdx);
  });

  it("bootstrap.js skips tool names already stamped on the page as [toolname]", async () => {
    // Runtime de-dupe against declarative form attributes: registering the same
    // WebMCP tool name from both the bootstrap (registerTool) and a stamped
    // <form toolname> crashes the renderer (Chrome bad_message 345). The
    // bootstrap must scan existing [toolname] elements and skip those names.
    const toml = await writeToml("dedupe.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const js = files["bootstrap.js"]!;
    expect(js).toContain("querySelectorAll('[toolname]')");
  });

  it("rejects a [[forms]] name that collides with a [[tools]] name", async () => {
    const collide = `${MINIMAL}

[[forms]]
name        = "search_pages"
description = "Contact us."
selector    = "form#contact"
`;
    const toml = await writeToml("collide.toml", collide);
    await expect(runBuild(toml)).rejects.toThrow(/name collision/i);
  });

  it("rejects duplicate names within [[tools]]", async () => {
    const dup = `${MINIMAL}

[[tools]]
name        = "search_pages"
description = "A second tool with the same name."

  [tools.input_schema]
  type     = "object"
  required = []

  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"
`;
    const toml = await writeToml("dup-tool.toml", dup);
    await expect(runBuild(toml)).rejects.toThrow(/duplicate tool name/i);
  });

  it("rejects duplicate names within [[forms]]", async () => {
    const dup = `${MINIMAL}

[[forms]]
name        = "contact"
description = "Contact us."
selector    = "form#contact"

[[forms]]
name        = "contact"
description = "Contact us again."
selector    = "form#contact2"
`;
    const toml = await writeToml("dup-form.toml", dup);
    await expect(runBuild(toml)).rejects.toThrow(/duplicate \[\[forms\]\] name/i);
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

  it("manifest.json includes links.agent_skills_index when feature on and stable", async () => {
    const toml = await writeToml("links-on.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const manifest = JSON.parse(files["manifest.json"]!);
    expect(manifest.links.agent_skills_index).toMatch(/^https?:\/\/.+\/\.well-known\/agent-skills\/index\.json$/);
  });

  it("manifest.json omits links.agent_skills_index when feature off", async () => {
    const off = `${MINIMAL}\n\n[features]\nagent_skills_index = false\n`;
    const toml = await writeToml("links-off.toml", off);
    const { files } = await runBuild(toml);
    const manifest = JSON.parse(files["manifest.json"]!);
    expect(manifest.links.agent_skills_index).toBeUndefined();
  });

  it("manifest.json omits links.agent_skills_index when agent_skills.mode is merge", async () => {
    // Index URL is not advertised when the digest would be unstable.
    const merge = `${MINIMAL}\n\n[agent_skills]\nmode = "merge"\n`;
    const toml = await writeToml("links-merge.toml", merge);
    const { files } = await runBuild(toml);
    const manifest = JSON.parse(files["manifest.json"]!);
    expect(manifest.links.agent_skills_index).toBeUndefined();
  });

  it("AGENT_SKILLS_DIGEST is a sha256:hex64 string when synthesise mode", async () => {
    const toml = await writeToml("digest-on.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const configTs = files["config.ts"]!;
    expect(configTs).toMatch(/AGENT_SKILLS_DIGEST[^=]+=\s*"sha256:[0-9a-f]{64}"/);
  });

  it("AGENT_SKILLS_DIGEST is null when agent_skills.mode is merge", async () => {
    const merge = `${MINIMAL}\n\n[agent_skills]\nmode = "merge"\n`;
    const toml = await writeToml("digest-merge.toml", merge);
    const { files } = await runBuild(toml);
    const configTs = files["config.ts"]!;
    expect(configTs).toMatch(/AGENT_SKILLS_DIGEST[^=]+=\s*null/);
  });

  it("LLMS_TXT_TOKEN_HINTS emits positive integer estimates for manifest and landing", async () => {
    const toml = await writeToml("token-hints.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const configTs = files["config.ts"]!;
    const m = configTs.match(/LLMS_TXT_TOKEN_HINTS[^=]+=\s*(\{[^}]*\})/);
    expect(m).not.toBeNull();
    const hints = JSON.parse(m![1]!);
    expect(hints.manifest).toBeGreaterThan(0);
    expect(hints.landing).toBeGreaterThan(0);
    expect(Number.isInteger(hints.manifest)).toBe(true);
    expect(Number.isInteger(hints.landing)).toBe(true);
  });

  it("BOOTSTRAP_SRI is a sha384-base64 string when feature on", async () => {
    const toml = await writeToml("sri-on.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const configTs = files["config.ts"]!;
    // Match sha384- followed by 64-char base64 (output of digest('base64') for 48 bytes).
    expect(configTs).toMatch(/BOOTSTRAP_SRI[^=]+=\s*"sha384-[A-Za-z0-9+/]+=*"/);
  });

  it("BOOTSTRAP_SRI matches sha384(bootstrap.js bytes) byte-for-byte", async () => {
    const { createHash } = await import("node:crypto");
    const toml = await writeToml("sri-match.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const configTs = files["config.ts"]!;
    const sriMatch = configTs.match(/BOOTSTRAP_SRI[^=]+=\s*"(sha384-[^"]+)"/);
    expect(sriMatch).not.toBeNull();
    const expected = `sha384-${createHash("sha384").update(files["bootstrap.js"]!, "utf8").digest("base64")}`;
    expect(sriMatch![1]).toBe(expected);
  });

  it("BOOTSTRAP_SRI is null when [features].subresource_integrity = false", async () => {
    const off = `${MINIMAL}\n\n[features]\nsubresource_integrity = false\n`;
    const toml = await writeToml("sri-off.toml", off);
    const { files } = await runBuild(toml);
    expect(files["config.ts"]!).toMatch(/BOOTSTRAP_SRI[^=]+=\s*null/);
  });

  it("refuses path collisions between any two Worker-owned surfaces", async () => {
    // Pointing agent_skills_index at the same path as agent_skills would
    // cause the index to silently never serve (router first-match wins).
    const collision = `${MINIMAL}

[agent_skills_index]
path = "/.well-known/agent-skills/site/SKILL.md"
mode = "synthesize"
`;
    const toml = await writeToml("collision.toml", collision);
    await expect(runBuild(toml)).rejects.toThrow(/path collision/i);
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

const WITH_AI_CATALOG = `${MINIMAL}

[features]
ai_catalog = true

[ai_catalog]
representative_queries = ["find a page about X"]
tags = ["docs"]
`;

describe("ai_catalog generation", () => {
  it("emits a spec-conformant catalog with one skill entry", async () => {
    const toml = await writeToml("ai-catalog.toml", WITH_AI_CATALOG);
    const { files } = await runBuild(toml);
    expect(files).toHaveProperty("ai-catalog.json");
    const cat = JSON.parse(files["ai-catalog.json"]!);
    expect(cat.specVersion).toBe("1.0");
    expect(cat.host.displayName).toBe("Example Co.");
    expect(cat.host.identifier).toBe("did:web:example.com");
    expect(cat.entries).toHaveLength(1);
    const e = cat.entries[0];
    expect(e.identifier).toMatch(/^urn:air:example\.com:skill:/);
    expect(e.type).toBe("application/ai-skill+md");
    expect(e.url).toBe("https://example.com/.well-known/agent-skills/site/SKILL.md");
    expect(e.capabilities).toContain("search_pages");
    expect(e.representativeQueries).toEqual(["find a page about X"]);
    expect(e.tags).toEqual(["docs"]);
  });

  it("omits representativeQueries and tags when not configured", async () => {
    const bare = `${MINIMAL}\n\n[features]\nai_catalog = true\n`;
    const toml = await writeToml("ai-catalog-bare.toml", bare);
    const { files } = await runBuild(toml);
    const e = JSON.parse(files["ai-catalog.json"]!).entries[0];
    expect(e).not.toHaveProperty("representativeQueries");
    expect(e).not.toHaveProperty("tags");
  });

  it("honors host_identifier override", async () => {
    const ov = `${MINIMAL}\n\n[features]\nai_catalog = true\n\n[ai_catalog]\nhost_identifier = "did:web:acme.com"\n`;
    const toml = await writeToml("ai-catalog-host.toml", ov);
    const { files } = await runBuild(toml);
    expect(JSON.parse(files["ai-catalog.json"]!).host.identifier).toBe("did:web:acme.com");
  });

  it("emits empty entries when agent_skills is off", async () => {
    const noSkill = `${MINIMAL}\n\n[features]\nai_catalog = true\nagent_skills = false\n`;
    const toml = await writeToml("ai-catalog-noskill.toml", noSkill);
    const { files } = await runBuild(toml);
    expect(JSON.parse(files["ai-catalog.json"]!).entries).toEqual([]);
  });

  it("fails the build when ai_catalog.path collides with another surface", async () => {
    const collide = `${MINIMAL}\n\n[features]\nai_catalog = true\n\n[ai_catalog]\npath = "/.well-known/api-catalog"\n`;
    const toml = await writeToml("ai-catalog-collide.toml", collide);
    await expect(runBuild(toml)).rejects.toThrow(/path collision/i);
  });
});
