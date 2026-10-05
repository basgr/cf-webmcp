import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { buildConfig, CLOUDFLARE_WEBMCP_LABS_TOOL_NAMES, defaultAnnotationsFor } from "./build-config";
import { ConfigSchema } from "../src/config-types";
import { buildFrontmatter } from "../src/routes/agent-skills";
import { agentSkillsIndexResponse } from "../src/routes/agent-skills-index";
import { LICENSE_PREAMBLE } from "../src/widget-preamble";
import { es5Violations, inlineScripts } from "../src/test-support/es5";
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
    // MINIMAL uses sitemap_filter -> readOnlyHint:true, untrustedContentHint:false, consequentialHint:false
    const toml = await writeToml("annot-sitemap.toml", MINIMAL);
    const { files } = await runBuild(toml);
    const js = files["bootstrap.js"]!;
    expect(js).toContain('"name":"search_pages"');
    expect(js).toContain('"annotations":{"readOnlyHint":true,"untrustedContentHint":false,"consequentialHint":false}');
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
    expect(js).toContain('"annotations":{"readOnlyHint":true,"untrustedContentHint":true,"consequentialHint":false}');
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
    // Override should flip both, and leave consequentialHint at its default.
    expect(js).toContain('"name":"search_pages"');
    expect(js).toContain('"annotations":{"readOnlyHint":false,"untrustedContentHint":true,"consequentialHint":false}');
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

describe("ai_catalog generation (ARD v0.91 ard.json)", () => {
  /** MINIMAL with extra [site] lines (after name) and the ARD feature on, plus any trailing TOML. */
  function ardToml(siteLines: string[] = [], rest = ""): string {
    const site = siteLines.length
      ? MINIMAL.replace('name   = "Example Co."', ['name   = "Example Co."', ...siteLines].join("\n"))
      : MINIMAL;
    return `${site}\n\n[features]\nai_catalog = true\n${rest}`;
  }
  const ard = (files: Record<string, string>) => JSON.parse(files["ard.json"]!);

  it("emits { host, entries } with one skill entry, no specVersion", async () => {
    const toml = await writeToml("ard.toml", WITH_AI_CATALOG);
    const { files } = await runBuild(toml);
    expect(files).toHaveProperty("ard.json");
    expect(files).not.toHaveProperty("ai-catalog.json");
    const doc = ard(files);
    expect(Object.keys(doc).sort()).toEqual(["entries", "host"]);
    expect(doc).not.toHaveProperty("specVersion");
    expect(doc.host).toEqual({ displayName: "Example Co.", identifier: "did:web:example.com" });
    expect(doc.entries).toHaveLength(1);
    const e = doc.entries[0];
    expect(e.identifier).toBe("urn:air:example.com:skill:example-co");
    expect(e.displayName).toBe("Example Co.");
    expect(e.type).toBe("application/ai-skill+md");
    expect(e.url).toBe("https://example.com/.well-known/agent-skills/site/SKILL.md");
    expect(e.capabilities).toContain("search_pages");
    expect(e.representativeQueries).toEqual(["find a page about X"]);
    expect(e.tags).toEqual(["docs"]);
    // The v0.91 entry schema's identifier pattern.
    expect(e.identifier).toMatch(/^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/);
  });

  it("omits representativeQueries and tags when not configured", async () => {
    const toml = await writeToml("ard-bare.toml", ardToml());
    const { files } = await runBuild(toml);
    const e = ard(files).entries[0];
    expect(e).not.toHaveProperty("representativeQueries");
    expect(e).not.toHaveProperty("tags");
  });

  it("honors host_identifier override", async () => {
    const toml = await writeToml("ard-host.toml", ardToml([], `\n[ai_catalog]\nhost_identifier = "did:web:acme.com"\n`));
    const { files } = await runBuild(toml);
    expect(ard(files).host.identifier).toBe("did:web:acme.com");
  });

  it("percent-encodes a port in did:web and drops it from the urn, for a domain with a port", async () => {
    const toml = await writeToml(
      "ard-port.toml",
      ardToml().replace('domain = "example.com"', 'domain = "example.com:8787"'),
    );
    const { files } = await runBuild(toml);
    const doc = ard(files);
    expect(doc.host.identifier).toBe("did:web:example.com%3A8787");
    expect(doc.entries[0].identifier).toBe("urn:air:example.com:skill:example-co");
    expect(doc.entries[0].url).toBe("https://example.com:8787/.well-known/agent-skills/site/SKILL.md");
  });

  it("takes the did:web host from public_url when it is set, but keeps the urn on [site].domain", async () => {
    // The ARD URN naming guide: the publisher segment stays the real domain in local
    // development too, so the identifier does not change between dev and production.
    const toml = await writeToml("ard-public.toml", ardToml(['public_url = "http://localhost:8787"']));
    const { files } = await runBuild(toml);
    const doc = ard(files);
    expect(doc.host.identifier).toBe("did:web:localhost%3A8787");
    expect(doc.entries[0].identifier).toBe("urn:air:example.com:skill:example-co");
    expect(doc.entries[0].url).toBe("http://localhost:8787/.well-known/agent-skills/site/SKILL.md");
  });

  it("emits empty entries when agent_skills is off", async () => {
    const toml = await writeToml("ard-noskill.toml", ardToml().replace("ai_catalog = true", "ai_catalog = true\nagent_skills = false"));
    const { files } = await runBuild(toml);
    expect(ard(files).entries).toEqual([]);
  });

  it("fails the build when ai_catalog.path collides with another surface", async () => {
    const toml = await writeToml("ard-collide.toml", ardToml([], `\n[ai_catalog]\npath = "/.well-known/api-catalog"\n`));
    await expect(runBuild(toml)).rejects.toThrow(/path collision/i);
  });

  it("fails the build when an ai_catalog alias collides with another surface", async () => {
    const toml = await writeToml("ard-alias-collide.toml", ardToml([], `\n[ai_catalog]\naliases = ["/.well-known/api-catalog"]\n`));
    await expect(runBuild(toml)).rejects.toThrow(/path collision.*ai_catalog\.alias/i);
  });

  it("ignores an alias equal to the canonical path", async () => {
    const toml = await writeToml("ard-alias-self.toml", ardToml([], `\n[ai_catalog]\naliases = ["/.well-known/ard.json", "/.well-known/ai-catalog.json"]\n`));
    await expect(runBuild(toml)).resolves.toBeDefined();
  });

  it("uses [site].name as the entry's displayName, also when [agent_skills].name is set (M10)", async () => {
    const toml = await writeToml("ard-display.toml", ardToml([], `\n[agent_skills]\nname = "my-shop"\n`));
    const e = ard((await runBuild(toml)).files).entries[0];
    expect(e.displayName).toBe("Example Co.");
    expect(e.identifier).toBe("urn:air:example.com:skill:my-shop");
  });

  it("types the skill entry with [ai_catalog].skill_type", async () => {
    const toml = await writeToml("ard-type.toml", ardToml([], `\n[ai_catalog]\nskill_type = "application/agent-skills+md"\n`));
    expect(ard((await runBuild(toml)).files).entries[0].type).toBe("application/agent-skills+md");
  });

  it("names the duplicate alias by its index in a path collision", async () => {
    const toml = await writeToml("ard-dup.toml", ardToml([], `\n[ai_catalog]\naliases = ["/.well-known/x.json", "/.well-known/x.json"]\n`));
    await expect(runBuild(toml)).rejects.toThrow(
      /both "ai_catalog\.aliases\[0\]" and "ai_catalog\.aliases\[1\]" are configured to claim \/\.well-known\/x\.json/,
    );
  });

  it("strips one trailing dot of [site].domain from the urn and the did:web", async () => {
    const toml = await writeToml("ard-dot.toml", ardToml().replace('domain = "example.com"', 'domain = "example.com."'));
    const doc = ard((await runBuild(toml)).files);
    expect(doc.entries[0].identifier).toBe("urn:air:example.com:skill:example-co");
    expect(doc.host.identifier).toBe("did:web:example.com");
  });

  describe("a [site] value no identifier can be made from is a build error naming the field", () => {
    it.each([
      ['public_url = "localhost:8787"', /\[build-config\] \[site\]\.public_url "localhost:8787"/],
      ['public_url = "example.com"', /\[build-config\] \[site\]\.public_url "example\.com"/],
    ])("%s", async (line, message) => {
      const toml = await writeToml("ard-bad-url.toml", ardToml([line]));
      await expect(runBuild(toml)).rejects.toThrow(message);
    });

    it('domain = "example.com:99999"', async () => {
      const toml = await writeToml("ard-bad-port.toml", ardToml().replace('domain = "example.com"', 'domain = "example.com:99999"'));
      await expect(runBuild(toml)).rejects.toThrow(/\[build-config\] \[site\]\.domain "example\.com:99999"/);
    });
  });

  describe("warnings", () => {
    const warningsFor = async (text: string): Promise<string[]> => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await runBuild(await writeToml("ard-warn.toml", text));
      const out = warn.mock.calls.map((c) => String(c[0])).filter((m) => !m.includes("fallback_widget is not set"));
      warn.mockRestore();
      return out;
    };

    it("none for the defaults", async () => {
      expect(await warningsFor(ardToml())).toEqual([]);
    });

    it("an explicit path at the predecessor ai-catalog.json (I2)", async () => {
      const w = await warningsFor(ardToml([], `\n[ai_catalog]\npath = "/.well-known/ai-catalog.json"\naliases = []\n`));
      expect(w).toEqual([expect.stringMatching(/consumers of ARD v0\.91 MUST fetch \/\.well-known\/ard\.json; move \[ai_catalog\]\.path to the default/)]);
    });

    it("a custom path while ard.json is not among the aliases, and none once it is (I2)", async () => {
      const custom = await warningsFor(ardToml([], `\n[ai_catalog]\npath = "/.well-known/agents/ard.json"\n`));
      expect(custom).toEqual([expect.stringMatching(/\/\.well-known\/ard\.json is not served/)]);
      const aliased = await warningsFor(
        ardToml([], `\n[ai_catalog]\npath = "/.well-known/agents/ard.json"\naliases = ["/.well-known/ard.json"]\n`),
      );
      expect(aliased).toEqual([]);
    });

    it("no path warning when the feature is off or in passthrough", async () => {
      expect(await warningsFor(`${MINIMAL}\n\n[ai_catalog]\npath = "/.well-known/ai-catalog.json"\n`)).toEqual([]);
      expect(await warningsFor(ardToml([], `\n[ai_catalog]\nmode = "passthrough"\npath = "/.well-known/ai-catalog.json"\n`))).toEqual([]);
    });

    it.each([
      ["localhost:8787", "localhost", /is localhost/],
      ["127.0.0.1", "127.0.0.1", /is an IP address/],
      ["intranet", "intranet", /has no dot/],
      ["a..b", "a..b", /has an empty label/],
    ])("a urn publisher that is not an FQDN: domain %s (M5)", async (domain, publisher, reason) => {
      const w = await warningsFor(ardToml().replace('domain = "example.com"', `domain = "${domain}"`));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(`urn:air publisher "${publisher}"`);
      expect(w[0]).toMatch(reason);
      expect(w[0]).toMatch(/fully qualified domain name/);
    });

    it("no FQDN warning when ARD is off, in passthrough, or the name is under .localhost", async () => {
      const local = (rest: string) => MINIMAL.replace('domain = "example.com"', 'domain = "localhost:8787"') + rest;
      expect(await warningsFor(local(""))).toEqual([]);
      expect(await warningsFor(local(`\n\n[features]\nai_catalog = true\n\n[ai_catalog]\nmode = "passthrough"\n`))).toEqual([]);
      expect(await warningsFor(ardToml().replace('domain = "example.com"', 'domain = "agent.localhost:8787"'))).toEqual([]);
    });
  });

  it("does not claim the alias, so no collision, when the feature is off or in passthrough", async () => {
    const off = `${MINIMAL}\n\n[ai_catalog]\naliases = ["/.well-known/api-catalog"]\n`;
    await expect(runBuild(await writeToml("ard-off.toml", off))).resolves.toBeDefined();
    const pt = ardToml([], `\n[ai_catalog]\nmode = "passthrough"\naliases = ["/.well-known/api-catalog"]\n`);
    await expect(runBuild(await writeToml("ard-pt.toml", pt))).resolves.toBeDefined();
  });
});

describe("one skill name for SKILL.md, the skills index and the ARD entry (M10)", () => {
  async function namesFor(siteName: string, skillsBlock = ""): Promise<{ frontmatter: string; index: string; ard: string }> {
    const text = `${MINIMAL.replace('name   = "Example Co."', `name   = ${JSON.stringify(siteName)}`)}\n\n[features]\nai_catalog = true\n${skillsBlock}`;
    const toml = await writeToml("names.toml", text);
    const { files } = await runBuild(toml);
    const config = ConfigSchema.parse(TOML.parse(text));
    const frontmatter = /^---\nname: "([^"]*)"/.exec(buildFrontmatter(config))![1]!;
    const index = (
      (await agentSkillsIndexResponse(new Request("https://example.com/"), config, `sha256:${"a".repeat(64)}`).json()) as {
        skills: Array<{ name: string }>;
      }
    ).skills[0]!.name;
    const identifier = JSON.parse(files["ard.json"]!).entries[0].identifier as string;
    return { frontmatter, index, ard: identifier.slice(identifier.lastIndexOf(":") + 1) };
  }

  it("derives the same NFKD and transliterated slug in all three from [site].name", async () => {
    expect(await namesFor("Café")).toEqual({ frontmatter: "cafe", index: "cafe", ard: "cafe" });
    expect(await namesFor("Grüße Welt")).toEqual({ frontmatter: "grusse-welt", index: "grusse-welt", ard: "grusse-welt" });
  });

  it("cuts a derived name to 64 characters and trims a hyphen left at the end, the same in all three", async () => {
    // 63 letters, then a space: the slug is 63 letters, a hyphen, more letters; cut at 64 it ends in the hyphen.
    const cut = "a".repeat(63);
    expect(await namesFor(`${cut} bcdef`)).toEqual({ frontmatter: cut, index: cut, ard: cut });
    const exact = "b".repeat(64);
    expect(await namesFor(`${exact}cc`)).toEqual({ frontmatter: exact, index: exact, ard: exact });
  });

  it("rejects an [agent_skills].name over 64 characters, even with the skill surfaces off", async () => {
    const text = `${MINIMAL}\n\n[features]\nagent_skills = false\nagent_skills_index = false\n\n[agent_skills]\nname = "${"a".repeat(65)}"\n`;
    await expect(runBuild(await writeToml("long.toml", text))).rejects.toThrow(/agent_skills\.name/);
  });

  it("uses an explicit [agent_skills].name verbatim in all three", async () => {
    expect(await namesFor("Example Co.", `\n[agent_skills]\nname = "my-shop"\n`)).toEqual({
      frontmatter: "my-shop",
      index: "my-shop",
      ard: "my-shop",
    });
  });

  it("refuses a [site].name with nothing to slug when the skill name is derived", async () => {
    const text = MINIMAL.replace('name   = "Example Co."', 'name   = "日本語"');
    await expect(runBuild(await writeToml("noslug.toml", text))).rejects.toThrow(/\[agent_skills\]\.name/);
  });

  it("accepts such a [site].name with an explicit [agent_skills].name, or with both skill surfaces off", async () => {
    const base = MINIMAL.replace('name   = "Example Co."', 'name   = "日本語"');
    await expect(runBuild(await writeToml("named.toml", `${base}\n\n[agent_skills]\nname = "nihongo"\n`))).resolves.toBeDefined();
    const off = `${base}\n\n[features]\nagent_skills = false\nagent_skills_index = false\n`;
    await expect(runBuild(await writeToml("off.toml", off))).resolves.toBeDefined();
    // Both skill surfaces left to origin and no ARD manifest: the name is used nowhere.
    const passthrough = `${base}\n\n[agent_skills]\nmode = "passthrough"\n\n[agent_skills_index]\nmode = "passthrough"\n`;
    await expect(runBuild(await writeToml("pt.toml", passthrough))).resolves.toBeDefined();
  });

  it("still refuses it when only the ARD entry needs the name (skill surfaces in passthrough, ai_catalog on)", async () => {
    const base = MINIMAL.replace('name   = "Example Co."', 'name   = "日本語"');
    const text = `${base}\n\n[features]\nai_catalog = true\n\n[agent_skills]\nmode = "passthrough"\n\n[agent_skills_index]\nmode = "passthrough"\n`;
    await expect(runBuild(await writeToml("ard-only.toml", text))).rejects.toThrow(/\[agent_skills\]\.name/);
  });

  it("rejects an [agent_skills].name that is not a skill name", async () => {
    const text = `${MINIMAL}\n\n[agent_skills]\nname = "My Shop"\n`;
    await expect(runBuild(await writeToml("badname.toml", text))).rejects.toThrow(/agent_skills\.name/);
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

/** The widget is opt-in: appends the [features] table that switches it on (for a TOML without one). */
const widgetOn = (toml: string): string => `${toml}\n[features]\nfallback_widget = true\n`;

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
    const { files } = await runBuild(await writeToml("w-name.toml", widgetOn(MINIMAL)), { widgetPinPath: pinPath });
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
    const { files } = await runBuild(await writeToml("w-tag.toml", widgetOn(MINIMAL)), {
      widgetPinPath: await writePin("pin.json", pin),
    });
    const tag = widgetScriptTag(files["landing.html"]!)!;
    expect(tag).toContain(`integrity="${pin["served_sri"]}"`);
    expect(tag).toContain('crossorigin="anonymous"');
    expect(tag).toContain("defer");
  });

  it("omits integrity from the widget tag and exports WIDGET_SRI null when subresource_integrity is off", async () => {
    const off = `${MINIMAL}\n\n[features]\nsubresource_integrity = false\nfallback_widget = true\n`;
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

        const { files } = await runBuild(await writeToml("w-unpinned.toml", widgetOn(MINIMAL)), { widgetPinPath: pinPath });

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

    const { files } = await runBuild(await writeToml("w-preamble.toml", widgetOn(MINIMAL)), {
      widgetPinPath: await writePin("pin.json", pin),
    });

    expect(exportedConst(files["config.ts"]!, "WIDGET_ASSET")).toBe(`widget.${(pin["served_sha256"] as string).slice(0, 16)}.js`);
    expect(files["landing.html"]).toContain("new WebMCP(");
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => /preamble/i.test(m) && /update-widget/.test(m))).toBe(true);
  });

  it("does not warn when the preamble matches the pin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runBuild(await writeToml("w-ok.toml", widgetOn(MINIMAL)), {
      widgetPinPath: await writePin("pin.json", fakePin("widget A")),
    });
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /widget|preamble/i.test(m))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The fallback widget on the landing page: opt-in, started, given this site's tools, and
// paired through a bridge pinned to the vendored widget's version.
// ---------------------------------------------------------------------------

/** MINIMAL plus two more tools, so "once per tool" and the order are visible. */
const THREE_TOOLS = `${MINIMAL}
[[tools]]
name        = "list_pages"
description = "List the pages."

  [tools.input_schema]
  type = "object"

  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"

[[tools]]
name        = "find_pages"
description = "Find pages."

  [tools.input_schema]
  type = "object"

  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"
`;

/** The inline script that starts the widget, or undefined when the landing has none. */
const widgetInit = (landing: string): string | undefined => inlineScripts(landing).find((s) => s.includes("new WebMCP("));

/** From `var ORIGIN` to the end of run(): the exec client the bootstrap and the widget init share. */
function execClient(js: string): string {
  const start = js.indexOf("var ORIGIN = '';");
  const runAt = js.indexOf("function run(endpoint, input) {");
  const end = js.indexOf("\n  }\n", runAt);
  if (start < 0 || runAt < 0 || end < 0) throw new Error("no exec client (ORIGIN + run) in this script");
  return js.slice(start, end + 4);
}

/** Text with the five entities escapeHtml writes turned back into characters. */
function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The text of every <code> element, unescaped. */
const codeBlocks = (html: string): string[] =>
  [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unescapeHtml(m[1]!));

describe("landing: the fallback widget is started and registers this site's tools", () => {
  const pinFor = (version: string): Promise<string> =>
    writePin(`pin-${version.replace(/[^a-z0-9]/gi, "_")}.json`, fakePin("widget A", { version }));

  it("is off unless [features].fallback_widget = true, and then quiet about the pin", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { files } = await runBuild(await writeToml("wi-default.toml", MINIMAL), { widgetPinPath: await pinFor("v0.1.13") });
    const html = files["landing.html"]!;
    expect(widgetInit(html)).toBeUndefined();
    expect(html).not.toContain("@jason.today/webmcp");
    expect(html).toContain("var widgetEnabled = false;");
    // Only the opt-in notice for the unset key, nothing about the pin.
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => /widget/i.test(m))).toEqual([
      expect.stringContaining("fallback_widget is not set"),
    ]);
  });

  it("starts the widget only if its script ran: a typeof WebMCP guard, then new WebMCP(", async () => {
    const { files } = await runBuild(await writeToml("wi-guard.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    const init = widgetInit(files["landing.html"]!);
    expect(init).toBeDefined();
    expect(init!.split("new WebMCP(")).toHaveLength(2);
    expect(init).toContain("typeof WebMCP === 'undefined'");
    expect(init!.indexOf("typeof WebMCP === 'undefined'")).toBeLessThan(init!.indexOf("new WebMCP("));
  });

  it("gives the widget a 30 minute inactivity timeout, and says so on the page", async () => {
    const { files } = await runBuild(await writeToml("wi-timeout.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    const html = files["landing.html"]!;
    expect(widgetInit(html)).toContain("new WebMCP({ inactivityTimeout: 1800000 })");
    expect(html).toContain(
      "The widget disconnects after 30 minutes without mouse or keyboard activity on this page; to reconnect, get a new token and repeat this step.",
    );
  });

  it("registers each tool once, in config order, after the widget's own script tag", async () => {
    const { files } = await runBuild(await writeToml("wi-three.toml", widgetOn(THREE_TOOLS)), { widgetPinPath: await pinFor("v0.1.13") });
    const html = files["landing.html"]!;
    const init = widgetInit(html)!;
    expect(init.match(/registerTool\(/g)).toHaveLength(3);
    const at = ["search_pages", "list_pages", "find_pages"].map((n) => init.indexOf(`registerTool(${JSON.stringify(n)},`));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.indexOf(widgetScriptTag(html)!)).toBeLessThan(html.indexOf(init));
  });

  it("names the bridge pinned to the version in the pin in every command: foreground, client entry, Claude Code, --new", async () => {
    for (const [version, npm] of [
      ["v0.1.13", "0.1.13"],
      ["v2.3.4", "2.3.4"],
    ] as const) {
      const { files } = await runBuild(await writeToml(`wi-cli-${npm}.toml`, widgetOn(MINIMAL)), { widgetPinPath: await pinFor(version) });
      const html = files["landing.html"]!;
      const code = codeBlocks(html);
      expect(code).toContain(`npx -y @jason.today/webmcp@${npm} --foreground`);
      // User scope: Claude Code's default (local) scope loads a server only in the project it was added in.
      expect(code).toContain(`claude mcp add --scope user webmcp -- npx -y @jason.today/webmcp@${npm} --mcp`);
      expect(code).toContain(`npx -y @jason.today/webmcp@${npm} --new`);
      const specs = html.match(/@jason\.today\/webmcp@[^\s"&<]*/g) ?? [];
      expect(specs.length).toBeGreaterThanOrEqual(4);
      expect(new Set(specs)).toEqual(new Set([`@jason.today/webmcp@${npm}`]));
      expect(html).not.toContain("@latest");
      expect(html).not.toContain("--config");
    }
  });

  it("gives the Claude Desktop entry as HTML-escaped JSON that reads back as the entry", async () => {
    const { files } = await runBuild(await writeToml("wi-json.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    const html = files["landing.html"]!;
    expect(html).not.toMatch(/"mcpServers"/);
    expect(html).toContain("&quot;mcpServers&quot;");
    const json = codeBlocks(html).find((c) => c.includes('"mcpServers"'));
    expect(JSON.parse(json!)).toEqual({
      mcpServers: { webmcp: { command: "npx", args: ["-y", "@jason.today/webmcp@0.1.13", "--mcp"] } },
    });
    expect(html).toContain("<code>claude_desktop_config.json</code>");
    expect(html).toContain("<code>~/.cursor/mcp.json</code>");
    // A visitor who already has MCP servers merges one key; the snippet is the whole file for a new one.
    const text = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(text).toContain("add the webmcp entry inside mcpServers; if the file does not exist, create it with this content:");
    expect(text).toContain("Cursor: the same webmcp entry inside mcpServers in ~/.cursor/mcp.json.");
  });

  it("tells the visitor to keep the bridge running first, restart the client, and what to do when tools are missing", async () => {
    const { files } = await runBuild(await writeToml("wi-steps.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    const text = files["landing.html"]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
    expect(text).toContain("leave the terminal open while you use this site's tools");
    expect(text).toContain("Press Ctrl+C in that terminal to stop it.");
    // A first --foreground run writes the bridge's server token but does not load it, so the
    // client's side is refused until the bridge restarts (upstream src/websocket-server.js).
    expect(text).toContain(
      "The first time you run the bridge on a computer, stop it with Ctrl+C as soon as it has started and run the same command again: the first run creates the bridge's settings in ~/.webmcp but does not use them yet.",
    );
    expect(text).toContain("The bridge must already be running when the client starts.");
    expect(text).toContain(
      "If your client shows no tools from this site, check that the terminal from step 1 is still open, then restart the MCP client. After restarting your computer, repeat step 1 before you open the client.",
    );
    // The bridge's own words when a daemon is already up (src/websocket-server.js:1431), e.g. one the
    // client's side forked on macOS or Linux because the client started first.
    expect(text).toContain(
      "If step 1 says the server is already running, the bridge is running in the background; restart the MCP client.",
    );
  });

  it("hides the widget step until the widget mounts, next to an empty status line for a widget that failed", async () => {
    const { files } = await runBuild(await writeToml("wi-hidden.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    const html = files["landing.html"]!;
    expect(html).toMatch(/<li id="webmcp-widget-step" hidden>Click the blue square in the bottom right corner of this page/);
    expect(html).toContain('<p id="webmcp-widget-error" role="status" hidden></p>');
    // The failure text is written by the init script, never shipped as page text.
    expect(html.replace(/<script[\s\S]*?<\/script>/g, "")).not.toMatch(/could not be loaded/);
  });

  it("keeps the pairing copy and every bridge command inside the pairing state", async () => {
    const { files } = await runBuild(await writeToml("wi-state.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    const html = files["landing.html"]!;
    const start = html.indexOf('id="state-pair"');
    const end = html.indexOf('id="state-disabled"');
    const pair = html.slice(start, end);
    expect(pair).toContain("Pairing required");
    expect(pair).toContain("new WebMCP(");
    const outside = html.slice(0, start) + html.slice(end);
    expect(outside).not.toContain("@jason.today/webmcp");
    expect(outside).not.toContain("npx -y");
  });

  it("drops the unused widget mount", async () => {
    const { files } = await runBuild(await writeToml("wi-mount.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    expect(files["landing.html"]).not.toContain("webmcp-widget-mount");
  });

  it("calls exec on the page's own origin (root-relative under an opaque one), without credentials", async () => {
    const custom = MINIMAL.replace(
      'name   = "Example Co."',
      'name   = "Example Co."\npublic_url = "https://www.example.com"',
    ).concat('\n[paths]\nnamespace = "/_agents"\n');
    const { files } = await runBuild(await writeToml("wi-origin.toml", widgetOn(custom)), { widgetPinPath: await pinFor("v0.1.13") });
    const init = widgetInit(files["landing.html"]!)!;
    expect(init).toContain("location.origin !== 'null'");
    expect(init).toContain("location.protocol + '//' + location.host");
    expect(init).toContain("credentials: 'omit'");
    expect(init).toContain("'content-type': 'application/json'");
    expect(init).toContain('run("/_agents/exec/search_pages", input)');
    expect(init).not.toContain("example.com");
  });

  it("shares the bootstrap's exec client byte for byte, so the two cannot drift", async () => {
    const { files } = await runBuild(await writeToml("wi-shared.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("v0.1.13") });
    expect(execClient(widgetInit(files["landing.html"]!)!)).toBe(execClient(files["bootstrap.js"]!));
  });

  it("escapes a tool description that closes the script element", async () => {
    const hostile = "</script><script>alert(1)</script>";
    const toml = MINIMAL.replace('description = "Search the site."', `description = ${JSON.stringify(hostile)}`);
    const { files } = await runBuild(await writeToml("wi-close.toml", widgetOn(toml)), { widgetPinPath: await pinFor("v0.1.13") });
    const html = files["landing.html"]!;
    // Only the widget init and the state script: the description opened no script of its own.
    const scripts = inlineScripts(html);
    expect(scripts).toHaveLength(2);
    const init = widgetInit(html)!;
    expect(init).toContain("<\\/script><script>alert(1)<\\/script>");
    expect(init).not.toContain("</");
    expect(scripts.find((s) => s.includes("webmcp-diag"))).not.toContain("alert(1)");
  });

  it("escapes an HTML comment opener and the JavaScript line separators in a description", async () => {
    const hostile = `<!--<script> a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const toml = MINIMAL.replace('description = "Search the site."', `description = ${JSON.stringify(hostile)}`);
    const { files } = await runBuild(await writeToml("wi-comment.toml", widgetOn(toml)), { widgetPinPath: await pinFor("v0.1.13") });
    const init = widgetInit(files["landing.html"]!)!;
    expect(init).not.toContain("<!--");
    expect(init).not.toMatch(new RegExp("[" + String.fromCharCode(0x2028, 0x2029) + "]"));
    expect(init).toContain("\\u2028");
    expect(init).toContain("\\u2029");
    expect(es5Violations(init)).toEqual([]);
  });

  it("is ES5, every inline script of a landing with the widget", async () => {
    const { files } = await runBuild(await writeToml("wi-es5.toml", widgetOn(THREE_TOOLS)), { widgetPinPath: await pinFor("v0.1.13") });
    const scripts = inlineScripts(files["landing.html"]!);
    expect(scripts).toHaveLength(2);
    for (const s of scripts) expect(es5Violations(s)).toEqual([]);
  });

  describe("a landing without the widget has no pairing copy, no bridge command and no init", () => {
    // The last field: whether the pin itself is unusable, which also leaves WIDGET_ASSET null.
    // With the feature off, the build still names the asset; the router does not serve it.
    const cases: Array<[string, string, () => Promise<string>, boolean]> = [
      ["the default config (the widget is opt-in)", MINIMAL, () => pinFor("v0.1.13"), false],
      ["an unpinned pin", widgetOn(MINIMAL), () => writePin("pin.json", { version: "unpinned", sha256: "" }), true],
      ["fallback_widget = false with a usable pin", `${MINIMAL}\n[features]\nfallback_widget = false\n`, () => pinFor("v0.1.13"), false],
      ["a pin whose version is a branch name", widgetOn(MINIMAL), () => pinFor("main"), true],
      ["a pin whose version has no leading v", widgetOn(MINIMAL), () => pinFor("0.1.13"), true],
      ["a pin whose version is a pre-release", widgetOn(MINIMAL), () => pinFor("v0.1.13-beta.1"), true],
    ];
    for (const [label, toml, pin, unusablePin] of cases) {
      it(`with ${label}`, async () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        const { files } = await runBuild(await writeToml("wi-off.toml", toml), { widgetPinPath: await pin() });
        const html = files["landing.html"]!;
        for (const gone of [
          "new WebMCP(",
          "registerTool(",
          "@jason.today/webmcp",
          "npx -y",
          "--foreground",
          "claude mcp add",
          "mcpServers",
          "Pairing required",
          "webmcp-widget-mount",
          "webmcp-widget-step",
          "widget below",
        ]) {
          expect(html, gone).not.toContain(gone);
        }
        expect(widgetScriptTag(html)).toBeUndefined();
        expect(html).toContain("var widgetEnabled = false;");
        if (unusablePin) expect(exportedConst(files["config.ts"]!, "WIDGET_ASSET")).toBeNull();
      });
    }

    it("says why when the pin's version is not a release tag", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await runBuild(await writeToml("wi-badver.toml", widgetOn(MINIMAL)), { widgetPinPath: await pinFor("main") });
      const messages = warn.mock.calls.map((c) => String(c[0]));
      expect(messages.some((m) => /version/i.test(m) && m.includes('"main"') && /update-widget/.test(m))).toBe(true);
    });
  });
});

describe("a notice for a config that does not set fallback_widget (the v0.6.0 default flip)", () => {
  const NOTICE =
    "[build-config] fallback_widget is not set; since v0.6.0 it defaults to false (the desktop-bridge widget is opt-in). Set it explicitly to silence this notice.";
  const notices = (warn: { mock: { calls: unknown[][] } }): string[] =>
    warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("fallback_widget is not set"));

  it("prints it once when the TOML does not set the key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runBuild(await writeToml("n-absent.toml", MINIMAL));
    expect(notices(warn)).toEqual([NOTICE]);
  });

  it.each([true, false])("is quiet when the TOML sets fallback_widget = %s", async (value) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runBuild(await writeToml(`n-${value}.toml`, `${MINIMAL}\n[features]\nfallback_widget = ${value}\n`));
    expect(notices(warn)).toEqual([]);
  });

  it("is quiet when only the parent TOML sets the key (inherits)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeToml("n-parent.toml", `${MINIMAL}\n[features]\nfallback_widget = false\n`);
    const child = await writeToml("n-child.toml", `inherits = "n-parent.toml"\n\n[site]\ndomain = "example.com"\nname   = "Child Co."\n`);
    await runBuild(child);
    expect(notices(warn)).toEqual([]);
  });

  it("prints it when the child's own [features] table replaces the parent's without the key", async () => {
    // inherits replaces a whole top-level table, so the parent's key is not in the resolved config.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await writeToml("n-parent2.toml", `${MINIMAL}\n[features]\nfallback_widget = true\n`);
    const child = await writeToml("n-child2.toml", `inherits = "n-parent2.toml"\n\n[features]\nllms_txt = true\n`);
    await runBuild(child);
    expect(notices(warn)).toEqual([NOTICE]);
  });

  it("leaves CONFIG_HASH alone: no key and an explicit false build the same config", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const absent = await runBuild(await writeToml("n-hash-a.toml", MINIMAL));
    const hashAbsent = exportedConst(absent.files["config.ts"]!, "CONFIG_HASH");
    const explicit = await runBuild(await writeToml("n-hash-b.toml", `${MINIMAL}\n[features]\nfallback_widget = false\n`));
    expect(exportedConst(explicit.files["config.ts"]!, "CONFIG_HASH")).toBe(hashAbsent);
  });
});

describe("templates: the widget is opt-in, and switched on explicitly where a template wants it", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

  it.each([
    ["templates/default.toml", true],
    ["templates/wordpress.toml", true],
    ["templates/woocommerce.toml", true],
    ["templates/example-site/webmcp.toml", false],
  ] as const)("%s sets fallback_widget = %s itself, with a comment that says it is opt-in", async (rel, value) => {
    const text = await fs.readFile(path.join(repoRoot, rel), "utf8");
    const line = text.split(/\r?\n/).find((l) => /^fallback_widget\s*=/.test(l));
    expect(line, rel).toBeDefined();
    expect(line).toMatch(new RegExp(`^fallback_widget\\s*=\\s*${value}\\b`));
    if (value) expect(line).toMatch(/opt-in/i);
    if (value) expect(line).toMatch(/upload-widget/);
  });

  it("the committed JSON schema gives fallback_widget the default false (npm run build:schema)", async () => {
    const schema = JSON.parse(await fs.readFile(path.join(repoRoot, "schemas", "webmcp.schema.json"), "utf8"));
    const features = schema.definitions.WebMCPConfig.properties.features.properties;
    expect(features.fallback_widget).toEqual({ type: "boolean", default: false });
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

  describe("the near-expiry warning says when, and how long from the build", () => {
    const now = new Date("2026-10-05T12:00:00.000Z");
    const nowSeconds = now.getTime() / 1000;
    const HOUR = 3600;

    async function warningFor(remainingSeconds: number, name: string): Promise<{ message: string; expiry: number }> {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const expiry = nowSeconds + remainingSeconds;
      await runBuild(await writeToml(`${name}.toml`, otToml([tokenFor({ expiry })])), { now });
      const messages = originTrialWarnings(warn);
      expect(messages).toHaveLength(1);
      return { message: messages[0]!, expiry };
    }

    it("prints the ISO expiry date-time once, and the days left", async () => {
      const { message, expiry } = await warningFor(12 * 86_400 + 5 * HOUR, "ot-w-days");
      const iso = new Date(expiry * 1000).toISOString();
      expect(message.split(iso)).toHaveLength(2);
      expect(message).toContain(`expires ${iso}, in 12 days`);
    });

    it("counts whole days, rounding down, and says day in the singular", async () => {
      const { message } = await warningFor(86_400 + 23 * HOUR, "ot-w-oneday");
      expect(message).toMatch(/, in 1 day\b(?!s)/);
      expect(message).not.toMatch(/hour/);
    });

    it("switches to hours below one day", async () => {
      const { message, expiry } = await warningFor(5 * HOUR + 20 * 60, "ot-w-hours");
      expect(message).toContain(`expires ${new Date(expiry * 1000).toISOString()}, in 5 hours`);
      expect(message).not.toMatch(/\bday/);
    });

    it("says 1 hour, not 1 day, for a token that expires in an hour", async () => {
      const { message } = await warningFor(HOUR, "ot-w-onehour");
      expect(message).toMatch(/, in 1 hour\b(?!s)/);
      expect(message).not.toMatch(/\bday/);
    });

    it("says less than an hour when under an hour is left", async () => {
      const { message } = await warningFor(30 * 60, "ot-w-minutes");
      expect(message).toContain("in less than an hour");
      expect(message).not.toMatch(/\b0 hours/);
    });
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

  describe("a version 2 token", () => {
    // Chrome reads isThirdParty only from version 3 tokens, so on version 2 the flag means nothing.
    it("is not rejected for isThirdParty, which Chrome does not read on version 2", async () => {
      const token = makeOriginTrialToken({ isThirdParty: true }, { version: 2 });
      await expect(runBuild(await writeToml("ot-v2-third.toml", otToml([token])))).resolves.toBeDefined();
    });

    it("is still checked for the origin and the expiry", async () => {
      const wrongOrigin = makeOriginTrialToken({ isThirdParty: true, origin: "https://other.example:443" }, { version: 2 });
      await expect(runBuild(await writeToml("ot-v2-origin.toml", otToml([wrongOrigin])))).rejects.toThrow(
        /origin_trial\.tokens\[0\]/,
      );
      const expired = makeOriginTrialToken({ isThirdParty: true, expiry: expiryInDays(-1) }, { version: 2 });
      await expect(runBuild(await writeToml("ot-v2-expired.toml", otToml([expired])))).rejects.toThrow(/expired/);
    });

    it("does not make a version 3 third-party token acceptable", async () => {
      const token = makeOriginTrialToken({ isThirdParty: true }, { version: 3 });
      await expect(runBuild(await writeToml("ot-v3-third.toml", otToml([token])))).rejects.toThrow(/third-party/i);
    });
  });

  describe("tokens Chrome would drop as malformed", () => {
    it("rejects a padded token whose = was stripped", async () => {
      let token = "";
      for (let n = 0; n < 3 && !token.endsWith("="); n++) token = tokenFor({ usage: "x".repeat(n) });
      const stripped = token.replace(/=+$/, "");
      await expect(runBuild(await writeToml("ot-stripped.toml", otToml([stripped])))).rejects.toThrow(
        /origin_trial\.tokens\[0\].*padding/s,
      );
    });

    it("rejects two tokens pasted together", async () => {
      let one = "";
      for (let n = 0; n < 3 && (one === "" || one.endsWith("=")); n++) one = tokenFor({ usage: "x".repeat(n) });
      await expect(runBuild(await writeToml("ot-pasted.toml", otToml([one + tokenFor()])))).rejects.toThrow(
        /origin_trial\.tokens\[0\].*payload length/s,
      );
    });

    it("rejects a token with bytes after its payload", async () => {
      const token = makeOriginTrialToken({}, { trailing: new Uint8Array([1, 2, 3]) });
      await expect(runBuild(await writeToml("ot-trailing.toml", otToml([token])))).rejects.toThrow(/payload length/);
    });

    it("rejects a token longer than 6144 characters", async () => {
      const token = tokenFor({ usage: "x".repeat(5300) });
      expect(token.length).toBeGreaterThan(6144);
      await expect(runBuild(await writeToml("ot-long.toml", otToml([token])))).rejects.toThrow(/too long/);
    });

    it("rejects a fractional, zero or 32-bit-overflowing expiry", async () => {
      for (const expiry of [expiryInDays(30) + 0.5, 0, 3_000_000_000]) {
        await expect(
          runBuild(await writeToml(`ot-expiry-${expiry}.toml`, otToml([tokenFor({ expiry })]))),
          String(expiry),
        ).rejects.toThrow(/payload\.expiry/);
      }
    });
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

// ---------------------------------------------------------------------------
// The generated bootstrap and the landing page: getTools() de-dupe, abort signals,
// root-relative URLs, the reserved Cloudflare WebMCP Labs names. What the generated code
// does when it runs is in bootstrap.vm.test.ts; here it is what the build emits.
// ---------------------------------------------------------------------------

/** The TOOLS array the bootstrap carries, parsed back out of the generated text. */
function toolsIn(js: string): Array<{ name: string; endpoint: string; annotations: Record<string, unknown> }> {
  const m = js.match(/var TOOLS = (\[.*\]);/);
  if (!m) throw new Error("no TOOLS array in the bootstrap");
  return JSON.parse(m[1]!);
}

const FIVE_EXECUTORS = `${MINIMAL}

[[tools]]
name        = "list_posts"
description = "List posts."
  [tools.input_schema]
  type = "object"
  [tools.executor]
  type     = "rss_feed"
  feed_url = "https://example.com/feed/"

[[tools]]
name        = "get_page"
description = "Fetch a page."
  [tools.input_schema]
  type = "object"
  [tools.executor]
  type         = "dom_extract"
  url_template = "https://example.com/about"

[[tools]]
name        = "get_json"
description = "Fetch JSON."
  [tools.input_schema]
  type = "object"
  [tools.executor]
  type         = "http_json"
  url_template = "https://example.com/wp-json/wp/v2/posts"

[[tools]]
name        = "get_text"
description = "Fetch text."
  [tools.input_schema]
  type = "object"
  [tools.executor]
  type         = "http_get"
  url_template = "https://example.com/robots.txt"
`;

describe("bootstrap.js: getTools() de-dupe, abort signals, rejections", () => {
  it("asks getTools() for the registered names, passes a signal and catches registerTool rejections", async () => {
    const { files } = await runBuild(await writeToml("bs-gettools.toml", MINIMAL));
    const js = files["bootstrap.js"]!;
    expect(js).toContain("getTools");
    expect(js).toContain("typeof ctx.getTools === 'function'");
    expect(js).toContain("AbortController");
    expect(js).toContain("signal");
    expect(js).toContain(".catch(");
    // The [toolname] scan stays: it is the fallback, and whether getTools() lists declarative tools is unknown.
    expect(js).toContain("querySelectorAll('[toolname]')");
  });

  it("keeps the document-first host probe and the navigator fallback", async () => {
    const { files } = await runBuild(await writeToml("bs-host.toml", MINIMAL));
    const js = files["bootstrap.js"]!;
    expect(js.indexOf("document.modelContext")).toBeGreaterThan(-1);
    expect(js.indexOf("document.modelContext")).toBeLessThan(js.indexOf("navigator.modelContext"));
  });

  it("never aborts a controller (aborting would unregister the tool)", async () => {
    const { files } = await runBuild(await writeToml("bs-noabort.toml", MINIMAL));
    expect(files["bootstrap.js"]).not.toMatch(/\.abort\s*\(/);
  });

  it("looks for the Cloudflare WebMCP Labs bridge script", async () => {
    const { files } = await runBuild(await writeToml("bs-labs.toml", MINIMAL));
    const js = files["bootstrap.js"]!;
    // *= and not $=: the script is often cache-busted (/.webmcp/bridge.js?v=1).
    expect(js).toContain(`document.querySelector('script[src*="/.webmcp/bridge.js"]')`);
    expect(js).toContain("Cloudflare WebMCP Labs");
  });

  it("is ES5 for every template: bootstrap and landing script", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const tomls = [
      "templates/example-site/webmcp.toml",
      "templates/default.toml",
      "templates/wordpress.toml",
      "templates/woocommerce.toml",
    ];
    for (const rel of tomls) {
      const { files } = await runBuild(path.join(repoRoot, rel));
      expect(es5Violations(files["bootstrap.js"]!), `${rel} bootstrap`).toEqual([]);
      const scripts = inlineScripts(files["landing.html"]!);
      expect(scripts.length, `${rel} landing has an inline script`).toBeGreaterThan(0);
      for (const s of scripts) expect(es5Violations(s), `${rel} landing script`).toEqual([]);
      await fs.rm(path.join(tmpDir, "out"), { recursive: true, force: true });
    }
  });
});

describe("bootstrap.js: root-relative exec endpoints", () => {
  it("points every endpoint at the namespace, root-relative, with no host in the bootstrap", async () => {
    const { files } = await runBuild(await writeToml("rr-default.toml", MINIMAL));
    const js = files["bootstrap.js"]!;
    expect(toolsIn(js).map((t) => t.endpoint)).toEqual(["/_webmcp/exec/search_pages"]);
    expect(js).toContain("/_webmcp/exec/");
    expect(js).not.toContain("https://example.com/_webmcp/exec");
    expect(js).not.toMatch(/https?:\/\/[^"'\s]*\/exec\//);
    expect(js).not.toContain("example.com");
  });

  it("follows [paths].namespace and ignores [site].public_url", async () => {
    const custom = MINIMAL.replace(
      'name   = "Example Co."',
      'name   = "Example Co."\npublic_url = "https://www.example.com"',
    ).concat('\n[paths]\nnamespace = "/_agents"\n');
    const { files } = await runBuild(await writeToml("rr-ns.toml", custom));
    const js = files["bootstrap.js"]!;
    expect(toolsIn(js).map((t) => t.endpoint)).toEqual(["/_agents/exec/search_pages"]);
    expect(js).not.toContain("www.example.com");
  });

  it("leaves every discovery document absolute: manifest endpoints and links", async () => {
    const withPublicUrl = MINIMAL.replace(
      'name   = "Example Co."',
      'name   = "Example Co."\npublic_url = "https://www.example.com"',
    );
    const { files } = await runBuild(await writeToml("rr-manifest.toml", withPublicUrl));
    const manifest = JSON.parse(files["manifest.json"]!);
    const asset = exportedConst(files["config.ts"]!, "BOOTSTRAP_ASSET") as string;
    expect(manifest.tools[0].endpoint).toBe("https://www.example.com/_webmcp/exec/search_pages");
    expect(manifest.links.bootstrap).toBe(`https://www.example.com/_webmcp/${asset}`);
    expect(manifest.links.self).toMatch(/^https:\/\/www\.example\.com\//);
    expect(manifest.links.landing).toMatch(/^https:\/\/www\.example\.com\//);
  });
});

describe("bootstrap.js: consequentialHint", () => {
  it("is false by default for all five executor types", async () => {
    const { files } = await runBuild(await writeToml("ch-five.toml", FIVE_EXECUTORS));
    const tools = toolsIn(files["bootstrap.js"]!);
    expect(tools.map((t) => t.name)).toEqual(["search_pages", "list_posts", "get_page", "get_json", "get_text"]);
    for (const t of tools) expect(t.annotations["consequentialHint"], t.name).toBe(false);
  });

  it("follows [tools.annotations].consequential_hint", async () => {
    const on = `${MINIMAL}\n  [tools.annotations]\n  consequential_hint = true\n`;
    const { files } = await runBuild(await writeToml("ch-on.toml", on));
    expect(toolsIn(files["bootstrap.js"]!)[0]!.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: false,
      consequentialHint: true,
    });
  });

  it("does not emit the debugging annotation", async () => {
    const { files } = await runBuild(await writeToml("ch-nodebug.toml", MINIMAL));
    expect(files["bootstrap.js"]).not.toContain("debugging");
  });

  it("does not touch the manifest, which carries no annotations", async () => {
    const { files } = await runBuild(await writeToml("ch-manifest.toml", MINIMAL));
    expect(files["manifest.json"]).not.toContain("onsequential");
    expect(files["manifest.json"]).not.toContain("readOnlyHint");
  });

  it("adds no schema default: the field stays out of the config (and CONFIG_HASH) until it is set", async () => {
    const unset = await runBuild(await writeToml("ch-hash-a.toml", MINIMAL));
    const otherField = await runBuild(
      await writeToml("ch-hash-b.toml", `${MINIMAL}\n  [tools.annotations]\n  read_only_hint = true\n`),
    );
    expect(unset.files["config.ts"]).not.toContain("consequential_hint");
    expect(otherField.files["config.ts"]).not.toContain("consequential_hint");
    const set = await runBuild(
      await writeToml("ch-hash-c.toml", `${MINIMAL}\n  [tools.annotations]\n  consequential_hint = false\n`),
    );
    expect(set.files["config.ts"]).toContain("consequential_hint");
  });

  describe("defaultAnnotationsFor", () => {
    it.each(["sitemap_filter", "rss_feed", "dom_extract", "http_json", "http_get"])(
      "%s: read-only and not consequential",
      (type) => {
        expect(defaultAnnotationsFor(type)).toMatchObject({ readOnlyHint: true, consequentialHint: false });
      },
    );

    it("keeps the untrusted-content defaults", () => {
      expect(defaultAnnotationsFor("sitemap_filter").untrustedContentHint).toBe(false);
      for (const t of ["rss_feed", "dom_extract", "http_json", "http_get"]) {
        expect(defaultAnnotationsFor(t).untrustedContentHint, t).toBe(true);
      }
    });

    it("treats an unknown executor type as writable, untrusted and consequential", () => {
      expect(defaultAnnotationsFor("something_else")).toEqual({
        readOnlyHint: false,
        untrustedContentHint: true,
        consequentialHint: true,
      });
    });
  });
});

describe("tool and form names reserved by Cloudflare WebMCP Labs", () => {
  const FORM = (name: string): string => `${MINIMAL}

[[forms]]
name        = "${name}"
description = "A form."
selector    = "form#contact"
`;
  const TOOL = (name: string): string => MINIMAL.replace('name        = "search_pages"', `name        = "${name}"`);

  it("lists them in one exported constant", () => {
    expect([...CLOUDFLARE_WEBMCP_LABS_TOOL_NAMES]).toEqual(["scan_images_c2pa", "inspect_image_c2pa"]);
  });

  it.each(["scan_images_c2pa", "inspect_image_c2pa"])("rejects a [[tools]] named %s", async (name) => {
    const err = await runBuild(await writeToml(`res-tool-${name}.toml`, TOOL(name))).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(name);
    expect((err as Error).message).toContain("Cloudflare WebMCP Labs");
    expect((err as Error).message).toContain("[[tools]]");
  });

  it.each(["scan_images_c2pa", "inspect_image_c2pa"])("rejects a [[forms]] named %s", async (name) => {
    const err = await runBuild(await writeToml(`res-form-${name}.toml`, FORM(name))).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(name);
    expect((err as Error).message).toContain("Cloudflare WebMCP Labs");
    expect((err as Error).message).toContain("[[forms]]");
  });

  it("accepts names that only contain a reserved name", async () => {
    const { files } = await runBuild(await writeToml("res-near.toml", TOOL("scan_images_c2pa_report")));
    expect(toolsIn(files["bootstrap.js"]!)[0]!.name).toBe("scan_images_c2pa_report");
    await expect(runBuild(await writeToml("res-near-form.toml", FORM("my_scan_images_c2pa")))).resolves.toBeDefined();
  });
});

describe("landing: {{bootstrap_block}}", () => {
  const bootstrapTag = (landing: string): string | undefined =>
    landing.match(/<script[^>]*bootstrap\.[^>]*><\/script>/)?.[0];

  it("loads the bootstrap root-relative with the same integrity attributes the Worker injects", async () => {
    const { files } = await runBuild(await writeToml("lb-sri.toml", MINIMAL));
    const asset = exportedConst(files["config.ts"]!, "BOOTSTRAP_ASSET") as string;
    const sri = exportedConst(files["config.ts"]!, "BOOTSTRAP_SRI") as string;
    expect(sri).toMatch(/^sha384-/);
    expect(bootstrapTag(files["landing.html"]!)).toBe(
      `<script src="/_webmcp/${asset}" defer integrity="${sri}" crossorigin="anonymous"></script>`,
    );
    expect(files["landing.html"]!.split(asset)).toHaveLength(2);
  });

  it("omits integrity and crossorigin when [features].subresource_integrity is off", async () => {
    const off = `${MINIMAL}\n\n[features]\nsubresource_integrity = false\n`;
    const { files } = await runBuild(await writeToml("lb-nosri.toml", off));
    const asset = exportedConst(files["config.ts"]!, "BOOTSTRAP_ASSET") as string;
    expect(bootstrapTag(files["landing.html"]!)).toBe(`<script src="/_webmcp/${asset}" defer></script>`);
  });

  it("follows [paths].namespace and escapes it for the attribute", async () => {
    const { files } = await runBuild(await writeToml("lb-ns.toml", `${MINIMAL}\n[paths]\nnamespace = "/a&b"\n`));
    const asset = exportedConst(files["config.ts"]!, "BOOTSTRAP_ASSET") as string;
    expect(bootstrapTag(files["landing.html"]!)).toContain(`src="/a&amp;b/${asset}"`);
  });

  it("is the very asset the manifest advertises, with the SRI of the bytes served at it", async () => {
    const { files } = await runBuild(await writeToml("lb-same.toml", MINIMAL));
    const manifest = JSON.parse(files["manifest.json"]!);
    const tag = bootstrapTag(files["landing.html"]!)!;
    expect(manifest.links.bootstrap.endsWith(tag.match(/src="([^"]+)"/)![1]!)).toBe(true);
    const expected = `sha384-${createHash("sha384").update(files["bootstrap.js"]!, "utf8").digest("base64")}`;
    expect(tag).toContain(`integrity="${expected}"`);
  });

  it("builds a custom template that has no placeholder, and then loads no bootstrap", async () => {
    await writeToml("custom-plain.html", "<html><body>{{site_name}}</body></html>");
    const toml = `${MINIMAL}\n[webmcp_landing]\ntemplate = "custom-plain.html"\n`;
    const { files } = await runBuild(await writeToml("lb-custom.toml", toml));
    expect(files["landing.html"]).toBe("<html><body>Example Co.</body></html>");
  });

  it("fills the placeholder, written with or without inner spaces, in a custom template", async () => {
    for (const [i, spelling] of ["{{bootstrap_block}}", "{{ bootstrap_block }}"].entries()) {
      await writeToml(`custom-block-${i}.html`, `<body>${spelling}</body>`);
      const toml = `${MINIMAL}\n[webmcp_landing]\ntemplate = "custom-block-${i}.html"\n`;
      const { files } = await runBuild(await writeToml(`lb-custom2-${i}.toml`, toml));
      expect(files["landing.html"]!.split("<script src=")).toHaveLength(2);
      expect(files["landing.html"]).not.toContain("{{");
    }
  });

  it.each([
    ["twice, spelled the same", "{{bootstrap_block}}|{{bootstrap_block}}"],
    ["twice, spelled differently", "{{bootstrap_block}}|{{ bootstrap_block }}"],
    ["three times", "{{bootstrap_block}}{{bootstrap_block}}{{bootstrap_block}}"],
  ])("refuses a landing template that has {{bootstrap_block}} %s", async (_label, body) => {
    // A second tag would run the bootstrap twice on one page.
    await writeToml("custom-twice.html", `<body>${body}</body>`);
    const toml = `${MINIMAL}\n[webmcp_landing]\ntemplate = "custom-twice.html"\n`;
    const err = await runBuild(await writeToml("lb-twice.toml", toml)).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("{{bootstrap_block}}");
    expect((err as Error).message).toMatch(/once/);
  });

  it("is documented as a placeholder to include once", async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const md = await fs.readFile(path.join(repoRoot, "docs", "customisation.md"), "utf8");
    expect(md).toMatch(/\{\{bootstrap_block\}\}[^\n]*once|once[^\n]*\{\{bootstrap_block\}\}/);
  });

  it("still refuses an unknown placeholder", async () => {
    await writeToml("custom-typo.html", "<body>{{bootstrap_blok}}</body>");
    const toml = `${MINIMAL}\n[webmcp_landing]\ntemplate = "custom-typo.html"\n`;
    await expect(runBuild(await writeToml("lb-typo.toml", toml))).rejects.toThrow(/unknown placeholder/);
  });
});

describe("landing: diagnostic and copy", () => {
  it("probes document.modelContext getTools, executeTool and ontoolchange, and keeps the navigator probes", async () => {
    const { files } = await runBuild(await writeToml("ld-probes.toml", MINIMAL));
    const landing = files["landing.html"]!;
    expect(landing).toContain("typeof document.modelContext.getTools");
    expect(landing).toContain("typeof document.modelContext.executeTool");
    expect(landing).toContain("'ontoolchange' in document.modelContext");
    expect(landing).toContain("navigator.modelContext (deprecated alias)");
    expect(landing).toContain("navigator.modelContextTesting");
    expect(landing).toContain("typeof navigator.modelContextTesting.listTools");
    expect(landing).toContain("typeof navigator.modelContextTesting.executeTool");
  });

  it("lists the registered tool names with textContent, never innerHTML", async () => {
    const { files } = await runBuild(await writeToml("ld-textcontent.toml", MINIMAL));
    const script = inlineScripts(files["landing.html"]!).join("\n");
    expect(script).toContain("getTools()");
    expect(script).not.toContain("innerHTML");
  });

  it("says WebMCP reaches Chrome through the origin trial from Chrome 149, behind a flag otherwise, and names Kitesurf", async () => {
    const { files } = await runBuild(await writeToml("ld-copy.toml", MINIMAL));
    const text = files["landing.html"]!.replace(/<[^>]+>/g, "");
    expect(text).toMatch(/origin trial/i);
    expect(text).toContain("Chrome 149");
    expect(text).toContain("chrome://flags/#enable-webmcp-testing");
    expect(text).toContain("Kitesurf");
    // The old claim that WebMCP is flags-only must be gone.
    expect(text).not.toContain("As of mid-2026");
    expect(text).not.toMatch(/flags only|only behind|behind a flag in Chrome and Edge/i);
  });

  it("words the origin trial as shipping on sites that send a trial token", async () => {
    const { files } = await runBuild(await writeToml("ld-copy2.toml", MINIMAL));
    const text = files["landing.html"]!.replace(/<[^>]+>/g, "");
    expect(text).toContain(
      "Chrome ships WebMCP to users through an origin trial (from Chrome 149) on sites that send a trial token.",
    );
  });

  it("tells the Connected visitor that Chrome 149 exposes the deprecated navigator.modelContext alias", async () => {
    const { files } = await runBuild(await writeToml("ld-connected.toml", MINIMAL));
    const html = files["landing.html"]!;
    const callout = html.slice(html.indexOf('id="state-native"'), html.indexOf('id="state-pair"')).replace(/<[^>]+>/g, "");
    expect(callout).toContain("document.modelContext");
    expect(callout).toContain("navigator.modelContext");
    expect(callout).toContain("Chrome 149");
  });
});
