import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildConfig } from "./build-config";
import { LICENSE_PREAMBLE } from "../src/widget-preamble";
import { expiryInDays, makeOriginTrialToken, type TokenPayload } from "../src/test-support/origin-trial";

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
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeToml(name: string, contents: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, contents);
  return p;
}

async function runBuild(
  tomlPath: string,
  opts: { widgetPinPath?: string; now?: Date } = {},
): Promise<{ outDir: string; files: Record<string, string> }> {
  const outDir = path.join(tmpDir, "out");
  await buildConfig({ tomlPath, outDir, ...opts });
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

// ---------------------------------------------------------------------------
// Content-addressed bootstrap and widget (SRI and immutable caching must agree).
// ---------------------------------------------------------------------------

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Read `export const NAME ... = <json>;` out of the emitted config.ts / hash.ts. */
function exportedConst(source: string, name: string): unknown {
  const m = source.match(new RegExp(`export const ${name}\\b[^=\\n]*=\\s*(.+);\\n`));
  if (!m) throw new Error(`export const ${name} not found in generated source`);
  return JSON.parse(m[1]!);
}

/** A pin for a fake widget, computed straight from node:crypto (not from the code under test). */
function fakePin(widgetBody: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const raw = Buffer.from(widgetBody, "utf8");
  const composed = Buffer.concat([Buffer.from(LICENSE_PREAMBLE, "utf8"), raw]);
  return {
    version: "v0.0.1",
    sha256: sha256(raw),
    served_sha256: sha256(composed),
    served_sri: `sha384-${createHash("sha384").update(composed).digest("base64")}`,
    preamble_sha256: sha256(LICENSE_PREAMBLE),
    ...overrides,
  };
}

async function writePin(name: string, pin: Record<string, unknown>): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, JSON.stringify(pin, null, 2) + "\n");
  return p;
}

const widgetScriptTag = (landing: string): string | undefined => landing.match(/<script[^>]*widget\.[^>]*><\/script>/)?.[0];

describe("content-addressed bootstrap", () => {
  it("names the bootstrap after the sha256 of its exact bytes (first 16 hex)", async () => {
    const toml = await writeToml("bs-hash.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const expected = `bootstrap.${sha256(files["bootstrap.js"]!).slice(0, 16)}.js`;

    expect(exportedConst(files["config.ts"]!, "BOOTSTRAP_ASSET")).toBe(expected);
    expect(exportedConst(files["hash.ts"]!, "BOOTSTRAP_ASSET")).toBe(expected);
    // The string the Worker serves is the one that was hashed.
    expect(exportedConst(files["assets.ts"]!, "BOOTSTRAP_JS")).toBe(files["bootstrap.js"]);
  });

  it("advertises the same file name in manifest links.bootstrap", async () => {
    const toml = await writeToml("bs-manifest.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const asset = exportedConst(files["config.ts"]!, "BOOTSTRAP_ASSET") as string;
    const manifest = JSON.parse(files["manifest.json"]!);
    expect(manifest.links.bootstrap).toBe(`https://example.com/_webmcp/${asset}`);
  });

  it("gives the same name for the same bytes and a different name when the bytes change", async () => {
    const a1 = await runBuild(await writeToml("bs-a.toml", MINIMAL));
    const a2 = await runBuild(await writeToml("bs-a2.toml", MINIMAL));
    const b = await runBuild(await writeToml("bs-b.toml", MINIMAL.replace("Search the site.", "Search the whole site.")));
    const name = (r: { files: Record<string, string> }) => exportedConst(r.files["config.ts"]!, "BOOTSTRAP_ASSET");
    expect(name(a1)).toBe(name(a2));
    expect(name(b)).not.toBe(name(a1));
  });

  it("keeps the URL and the SRI hash tied to the same bytes", async () => {
    const toml = await writeToml("bs-sri.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const sri = exportedConst(files["config.ts"]!, "BOOTSTRAP_SRI") as string;
    expect(sri).toBe(`sha384-${createHash("sha384").update(files["bootstrap.js"]!, "utf8").digest("base64")}`);
    expect(exportedConst(files["config.ts"]!, "BOOTSTRAP_ASSET")).toBe(
      `bootstrap.${sha256(files["bootstrap.js"]!).slice(0, 16)}.js`,
    );
  });

  it("leaves CONFIG_HASH as the 8-hex hash of the config alone (preflight recomputes it from TOML)", async () => {
    const toml = await writeToml("bs-config-hash.toml", MINIMAL);
    const pinA = await writePin("pin-a.json", fakePin("widget A"));
    const pinB = await writePin("pin-b.json", fakePin("widget B"));
    const a = await runBuild(toml, { widgetPinPath: pinA });
    const b = await runBuild(toml, { widgetPinPath: pinB });
    const hashA = exportedConst(a.files["config.ts"]!, "CONFIG_HASH");
    expect(hashA).toMatch(/^[0-9a-f]{8}$/);
    expect(exportedConst(b.files["config.ts"]!, "CONFIG_HASH")).toBe(hashA);
    expect(JSON.parse(a.files["manifest.json"]!).config_hash).toBe(hashA);
  });
});

describe("content-addressed widget", () => {
  it("names the widget from the pin: widget.<first 16 hex of served_sha256>.js", async () => {
    const pin = fakePin("widget A");
    const pinPath = await writePin("pin.json", pin);
    const { files } = await runBuild(await writeToml("w-name.toml", MINIMAL), { widgetPinPath: pinPath });
    const expected = `widget.${(pin["served_sha256"] as string).slice(0, 16)}.js`;

    expect(exportedConst(files["config.ts"]!, "WIDGET_ASSET")).toBe(expected);
    expect(exportedConst(files["hash.ts"]!, "WIDGET_ASSET")).toBe(expected);
    expect(widgetScriptTag(files["landing.html"]!)).toContain(`src="/_webmcp/${expected}"`);
  });

  it("keeps WIDGET_ASSET when only the TOML changes (the pin is unchanged)", async () => {
    const pinPath = await writePin("pin.json", fakePin("widget A"));
    const a = await runBuild(await writeToml("w-a.toml", MINIMAL), { widgetPinPath: pinPath });
    const b = await runBuild(await writeToml("w-b.toml", MINIMAL.replace("Search the site.", "Search the whole site.")), {
      widgetPinPath: pinPath,
    });
    // The TOML edit really changed the config and the bootstrap ...
    expect(exportedConst(b.files["config.ts"]!, "CONFIG_HASH")).not.toBe(exportedConst(a.files["config.ts"]!, "CONFIG_HASH"));
    expect(exportedConst(b.files["config.ts"]!, "BOOTSTRAP_ASSET")).not.toBe(
      exportedConst(a.files["config.ts"]!, "BOOTSTRAP_ASSET"),
    );
    // ... but not the widget object, so no R2 re-upload is needed.
    expect(exportedConst(b.files["config.ts"]!, "WIDGET_ASSET")).toBe(exportedConst(a.files["config.ts"]!, "WIDGET_ASSET"));
    expect(exportedConst(b.files["config.ts"]!, "WIDGET_SRI")).toBe(exportedConst(a.files["config.ts"]!, "WIDGET_SRI"));
  });

  it("changes WIDGET_ASSET and WIDGET_SRI when the widget pin changes (same TOML)", async () => {
    const toml = await writeToml("w-pin-change.toml", MINIMAL);
    const a = await runBuild(toml, { widgetPinPath: await writePin("pin-a.json", fakePin("widget A")) });
    const b = await runBuild(toml, { widgetPinPath: await writePin("pin-b.json", fakePin("widget B")) });
    expect(exportedConst(b.files["config.ts"]!, "WIDGET_ASSET")).not.toBe(exportedConst(a.files["config.ts"]!, "WIDGET_ASSET"));
    expect(exportedConst(b.files["config.ts"]!, "WIDGET_SRI")).not.toBe(exportedConst(a.files["config.ts"]!, "WIDGET_SRI"));
  });

  it("exports WIDGET_SRI as the complete sha384 SRI string from the pin", async () => {
    const pin = fakePin("widget A");
    const { files } = await runBuild(await writeToml("w-sri.toml", MINIMAL), {
      widgetPinPath: await writePin("pin.json", pin),
    });
    const sri = exportedConst(files["config.ts"]!, "WIDGET_SRI");
    expect(sri).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(sri).toBe(pin["served_sri"]);
  });

  it("puts integrity and crossorigin on the widget script tag when SRI is on", async () => {
    const pin = fakePin("widget A");
    const { files } = await runBuild(await writeToml("w-tag.toml", MINIMAL), {
      widgetPinPath: await writePin("pin.json", pin),
    });
    const tag = widgetScriptTag(files["landing.html"]!)!;
    expect(tag).toContain(`integrity="${pin["served_sri"]}"`);
    expect(tag).toContain('crossorigin="anonymous"');
    expect(tag).toContain("defer");
  });

  it("omits integrity from the widget tag and exports WIDGET_SRI null when subresource_integrity is off", async () => {
    const off = `${MINIMAL}\n\n[features]\nsubresource_integrity = false\n`;
    const pin = fakePin("widget A");
    const { files } = await runBuild(await writeToml("w-sri-off.toml", off), {
      widgetPinPath: await writePin("pin.json", pin),
    });
    expect(exportedConst(files["config.ts"]!, "WIDGET_SRI")).toBeNull();
    const tag = widgetScriptTag(files["landing.html"]!)!;
    expect(tag).not.toContain("integrity=");
    expect(tag).not.toContain("crossorigin");
    // The widget is still served, content-addressed.
    expect(exportedConst(files["config.ts"]!, "WIDGET_ASSET")).toBe(`widget.${(pin["served_sha256"] as string).slice(0, 16)}.js`);
  });

  it("matches the committed vendor/webmcp/current.json when no pin path is given", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const committed = JSON.parse(await fs.readFile(path.join(repoRoot, "vendor", "webmcp", "current.json"), "utf8"));
    const { files } = await runBuild(await writeToml("w-default.toml", MINIMAL));
    expect(exportedConst(files["config.ts"]!, "WIDGET_ASSET")).toBe(`widget.${committed.served_sha256.slice(0, 16)}.js`);
    expect(exportedConst(files["config.ts"]!, "WIDGET_SRI")).toBe(committed.served_sri);
  });

  describe("without a usable pin the widget is disabled everywhere, and the build still succeeds", () => {
    const cases: Array<[string, Record<string, unknown> | null]> = [
      ["an unpinned pin", { version: "unpinned", sha256: "" }],
      ["an unpinned pin with no sha256 key", { version: "unpinned" }],
      ["a legacy pin without the served fields", { version: "v0.1.13", sha256: "0".repeat(64) }],
      ["a pin whose served_sha256 is malformed", fakePin("widget A", { served_sha256: "NOT-HEX" })],
      ["a pin whose served_sri is malformed", fakePin("widget A", { served_sri: "sha384-short" })],
      ["a missing pin file", null],
    ];

    for (const [label, pin] of cases) {
      it(`handles ${label}`, async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pinPath = pin ? await writePin("pin.json", pin) : path.join(tmpDir, "does-not-exist.json");

        const { files } = await runBuild(await writeToml("w-unpinned.toml", MINIMAL), { widgetPinPath: pinPath });

        expect(exportedConst(files["config.ts"]!, "WIDGET_ASSET")).toBeNull();
        expect(exportedConst(files["config.ts"]!, "WIDGET_SRI")).toBeNull();
        expect(exportedConst(files["hash.ts"]!, "WIDGET_ASSET")).toBeNull();
        // Empty {{widget_block}}, {{widget_enabled_js}} = false in both template uses.
        expect(files["landing.html"]).not.toContain("webmcp-widget-mount");
        expect(widgetScriptTag(files["landing.html"]!)).toBeUndefined();
        expect(files["landing.html"]).toContain("var widgetEnabled = false;");
        expect(files["landing.html"]).toContain("'fallback widget configured': false");
        // And the operator is told why.
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => /widget/i.test(m) && /update-widget/.test(m))).toBe(true);
      });
    }

    it("stays quiet about a missing pin when fallback_widget is off", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const off = `${MINIMAL}\n\n[features]\nfallback_widget = false\n`;
      const pinPath = await writePin("pin.json", { version: "unpinned", sha256: "" });

      const { files } = await runBuild(await writeToml("w-off.toml", off), { widgetPinPath: pinPath });

      expect(files["landing.html"]).not.toContain("webmcp-widget-mount");
      expect(files["landing.html"]).toContain("var widgetEnabled = false;");
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /widget/i.test(m))).toEqual([]);
    });

    it("fails the build on a pin file that is not valid JSON", async () => {
      const bad = path.join(tmpDir, "bad-pin.json");
      await fs.writeFile(bad, "{ not json");
      await expect(runBuild(await writeToml("w-bad.toml", MINIMAL), { widgetPinPath: bad })).rejects.toThrow(/current\.json|pin/i);
    });
  });

  it("warns, but still enables the widget, when the preamble no longer matches the pin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pin = fakePin("widget A", { preamble_sha256: sha256("an older preamble") });

    const { files } = await runBuild(await writeToml("w-preamble.toml", MINIMAL), {
      widgetPinPath: await writePin("pin.json", pin),
    });

    expect(exportedConst(files["config.ts"]!, "WIDGET_ASSET")).toBe(`widget.${(pin["served_sha256"] as string).slice(0, 16)}.js`);
    expect(files["landing.html"]).toContain("webmcp-widget-mount");
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /preamble/i.test(m) && /update-widget/.test(m))).toBe(true);
  });

  it("does not warn when the preamble matches the pin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runBuild(await writeToml("w-ok.toml", MINIMAL), {
      widgetPinPath: await writePin("pin.json", fakePin("widget A")),
    });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /widget|preamble/i.test(m))).toEqual([]);
  });
});

describe("buildConfig: [origin_trial]", () => {
  const DAY_MS = 86_400_000;

  /** MINIMAL with `[site].public_url` set, and the given [origin_trial] tokens. */
  function otToml(tokens: string[], publicUrl?: string): string {
    const site = publicUrl
      ? MINIMAL.replace('name   = "Example Co."', `name   = "Example Co."\npublic_url = ${JSON.stringify(publicUrl)}`)
      : MINIMAL;
    return `${site}\n\n[origin_trial]\ntokens = ${JSON.stringify(tokens)}\n`;
  }

  function tokenFor(payload: TokenPayload = {}): string {
    return makeOriginTrialToken(payload);
  }

  function originTrialWarnings(warn: { mock: { calls: unknown[][] } }): string[] {
    return warn.mock.calls.map((c) => String(c[0])).filter((m) => /origin_trial/.test(m));
  }

  it("builds with no [origin_trial] block, silently, and emits no token export", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { files } = await runBuild(await writeToml("ot-none.toml", MINIMAL));
    expect(originTrialWarnings(warn)).toEqual([]);
    expect(files["config.ts"]).not.toMatch(/export const \w*(ORIGIN_TRIAL|TOKENS)\w*/i);
  });

  it("accepts a token issued for the site origin, with its explicit :443", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = tokenFor({ origin: "https://example.com:443" });
    const { files } = await runBuild(await writeToml("ot-ok.toml", otToml([token])));
    expect(files["config.ts"]).toContain(token);
    expect(originTrialWarnings(warn)).toEqual([]);
  });

  it("accepts a token for a site on a non-default port, and rejects another port", async () => {
    const ok = tokenFor({ origin: "http://localhost:8787" });
    await expect(runBuild(await writeToml("ot-port-ok.toml", otToml([ok], "http://localhost:8787")))).resolves.toBeDefined();

    const other = tokenFor({ origin: "http://localhost:8788" });
    await expect(runBuild(await writeToml("ot-port-bad.toml", otToml([other], "http://localhost:8787")))).rejects.toThrow(
      /origin_trial\.tokens\[0\].*http:\/\/localhost:8788.*http:\/\/localhost:8787/s,
    );
  });

  it("rejects a token issued for another origin and names the token, its origin, the feature and the expiry", async () => {
    const expiry = expiryInDays(200);
    const token = tokenFor({ origin: "https://other.example:443", feature: "SomeFeature", expiry });
    const err = await runBuild(await writeToml("ot-mismatch.toml", otToml([token]))).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(/origin_trial\.tokens\[0\]/);
    expect(message).toContain("https://other.example:443");
    expect(message).toContain("https://example.com");
    expect(message).toContain("SomeFeature");
    expect(message).toContain(new Date(expiry * 1000).toISOString());
    expect(message).not.toContain(token);
  });

  it("numbers the offending token by its index", async () => {
    const good = tokenFor();
    const bad = tokenFor({ origin: "https://other.example:443" });
    await expect(runBuild(await writeToml("ot-index.toml", otToml([good, bad])))).rejects.toThrow(/origin_trial\.tokens\[1\]/);
  });

  it("rejects a token for http:// when the site is https://", async () => {
    const token = tokenFor({ origin: "http://example.com:80" });
    await expect(runBuild(await writeToml("ot-scheme.toml", otToml([token])))).rejects.toThrow(/origin_trial\.tokens\[0\]/);
  });

  describe("isSubdomain", () => {
    it("lets a token for example.com cover www.example.com", async () => {
      const token = tokenFor({ origin: "https://example.com:443", isSubdomain: true });
      await expect(
        runBuild(await writeToml("ot-sub-ok.toml", otToml([token], "https://www.example.com"))),
      ).resolves.toBeDefined();
    });

    it("lets a token for example.com cover the apex itself", async () => {
      const token = tokenFor({ origin: "https://example.com:443", isSubdomain: true });
      await expect(runBuild(await writeToml("ot-sub-apex.toml", otToml([token])))).resolves.toBeDefined();
    });

    it("does not cover www.example.com without isSubdomain", async () => {
      const token = tokenFor({ origin: "https://example.com:443" });
      await expect(runBuild(await writeToml("ot-sub-off.toml", otToml([token], "https://www.example.com")))).rejects.toThrow(
        /origin_trial\.tokens\[0\]/,
      );
    });

    it("does not cover badexample.com", async () => {
      const token = tokenFor({ origin: "https://example.com:443", isSubdomain: true });
      await expect(runBuild(await writeToml("ot-sub-bad.toml", otToml([token], "https://badexample.com")))).rejects.toThrow(
        /origin_trial\.tokens\[0\]/,
      );
    });

    it("does not cover a different scheme or port", async () => {
      const token = tokenFor({ origin: "https://example.com:443", isSubdomain: true });
      await expect(runBuild(await writeToml("ot-sub-scheme.toml", otToml([token], "http://www.example.com")))).rejects.toThrow(
        /origin_trial\.tokens\[0\]/,
      );
      await expect(
        runBuild(await writeToml("ot-sub-port.toml", otToml([token], "https://www.example.com:8443"))),
      ).rejects.toThrow(/origin_trial\.tokens\[0\]/);
    });
  });

  it("rejects an expired token and says when it expired", async () => {
    const expiry = expiryInDays(-3);
    const token = tokenFor({ expiry });
    const err = await runBuild(await writeToml("ot-expired.toml", otToml([token]))).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/origin_trial\.tokens\[0\].*expired/s);
    expect((err as Error).message).toContain(new Date(expiry * 1000).toISOString());
    expect((err as Error).message).toContain("WebMCP");
  });

  it("treats a token as expired at the very second of its expiry", async () => {
    const expiry = 1_900_000_000;
    const token = tokenFor({ expiry });
    const toml = await writeToml("ot-boundary.toml", otToml([token]));
    await expect(runBuild(toml, { now: new Date(expiry * 1000) })).rejects.toThrow(/expired/);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(runBuild(toml, { now: new Date(expiry * 1000 - 1) })).resolves.toBeDefined();
  });

  it("warns, and still builds, when a token expires within 30 days", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const expiry = expiryInDays(10);
    const token = tokenFor({ expiry });
    await runBuild(await writeToml("ot-near.toml", otToml([token])));
    const messages = originTrialWarnings(warn);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/origin_trial\.tokens\[0\]/);
    expect(messages[0]).toContain("WebMCP");
    expect(messages[0]).toContain(new Date(expiry * 1000).toISOString());
    expect(messages[0]).not.toContain(token);
  });

  it("warns at exactly 30 days and not a second later", async () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const nowSeconds = now.getTime() / 1000;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const edge = tokenFor({ expiry: nowSeconds + 30 * 86_400 });
    await runBuild(await writeToml("ot-30.toml", otToml([edge])), { now });
    expect(originTrialWarnings(warn)).toHaveLength(1);

    warn.mockClear();
    const beyond = tokenFor({ expiry: nowSeconds + 30 * 86_400 + 1 });
    await runBuild(await writeToml("ot-30b.toml", otToml([beyond])), { now });
    expect(originTrialWarnings(warn)).toEqual([]);
  });

  it("does not warn about a token with a long validity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runBuild(await writeToml("ot-far.toml", otToml([tokenFor({ expiry: expiryInDays(120) })])));
    expect(originTrialWarnings(warn)).toEqual([]);
  });

  it("rejects a third-party token", async () => {
    const token = tokenFor({ isThirdParty: true });
    await expect(runBuild(await writeToml("ot-third.toml", otToml([token])))).rejects.toThrow(
      /origin_trial\.tokens\[0\].*third-party/is,
    );
  });

  it("rejects a token that cannot be decoded, without echoing it", async () => {
    const garbage = "QUJDREVGR0hJSktMTU5PUA==";
    const err = await runBuild(await writeToml("ot-garbage.toml", otToml([garbage]))).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/origin_trial\.tokens\[0\]/);
    expect((err as Error).message).not.toContain(garbage);
  });

  it("rejects a token outside the base64 alphabet at schema validation", async () => {
    await expect(runBuild(await writeToml("ot-charset.toml", otToml(["not base64!"])))).rejects.toThrow(
      /validation failed[\s\S]*origin_trial\.tokens\.0/,
    );
  });

  it("rejects the same token listed twice", async () => {
    const token = tokenFor();
    await expect(runBuild(await writeToml("ot-dup.toml", otToml([token, tokenFor({ feature: "Other" }), token])))).rejects.toThrow(
      /origin_trial\.tokens\[2\].*origin_trial\.tokens\[0\]/s,
    );
  });

  it("reports every bad token in one error", async () => {
    const wrongOrigin = tokenFor({ origin: "https://other.example:443" });
    const expired = tokenFor({ expiry: expiryInDays(-1) });
    const err = await runBuild(await writeToml("ot-many.toml", otToml([wrongOrigin, tokenFor(), expired]))).catch(
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/origin_trial\.tokens\[0\]/);
    expect((err as Error).message).toMatch(/origin_trial\.tokens\[2\]/);
    expect((err as Error).message).not.toMatch(/origin_trial\.tokens\[1\]/);
  });

  it("does not warn about expiry for a token it already rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = tokenFor({ origin: "https://other.example:443", expiry: expiryInDays(5) });
    await expect(runBuild(await writeToml("ot-reject-nowarn.toml", otToml([token])))).rejects.toThrow();
    expect(originTrialWarnings(warn)).toEqual([]);
  });

  it("names the site URL when [site].public_url is not a URL and tokens are present", async () => {
    await expect(runBuild(await writeToml("ot-badurl.toml", otToml([tokenFor()], "not a url")))).rejects.toThrow(/public_url/);
  });

  it("leaves a malformed [site].public_url alone when there are no tokens", async () => {
    const toml = MINIMAL.replace('name   = "Example Co."', 'name   = "Example Co."\npublic_url = "not a url"');
    await expect(runBuild(await writeToml("ot-badurl-none.toml", toml))).resolves.toBeDefined();
  });

  it("never prints a token in a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = tokenFor({ expiry: expiryInDays(3) });
    await runBuild(await writeToml("ot-noecho.toml", otToml([token])));
    expect(warn.mock.calls.flat().map(String).join("\n")).not.toContain(token);
  });

  it("changes the config hash when a token is added", async () => {
    const without = await runBuild(await writeToml("ot-h1.toml", MINIMAL));
    const withToken = await runBuild(await writeToml("ot-h2.toml", otToml([tokenFor()])));
    expect(JSON.parse(withToken.files["manifest.json"]!).config_hash).not.toBe(
      JSON.parse(without.files["manifest.json"]!).config_hash,
    );
  });

  it("uses the injected clock, not the wall clock", async () => {
    // Valid for a year from now: fine today, expired 400 days from now.
    const token = tokenFor({ expiry: expiryInDays(365) });
    const toml = await writeToml("ot-clock.toml", otToml([token]));
    await expect(runBuild(toml, { now: new Date(Date.now() + 400 * DAY_MS) })).rejects.toThrow(/expired/);
  });
});
