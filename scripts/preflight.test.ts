import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./preflight";
import { buildConfig } from "./build-config";

/**
 * Preflight tests run in a sandbox temp dir per test: the TOML is written there, the result
 * (preflight.json) goes to an outDir there (never to src/generated), and global fetch is stubbed,
 * so nothing touches the network or the repo.
 */

const PKG_VERSION = (
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
  ) as { version: string }
).version;

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-preflight-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Stub global fetch: every GET is a 404 (nothing to collide with), and a POST is answered from `post`,
 * keyed by URL. An answer that is an Error is thrown (a network failure); a URL not listed answers 404.
 */
function stubOrigin(post: Record<string, Response | Error | (() => Response)> = {}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (init.method === "POST") {
        const answer = post[url];
        if (answer instanceof Error) throw answer;
        if (typeof answer === "function") return answer();
        if (answer) return answer;
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return { calls, posts: () => calls.filter((c) => c.init.method === "POST") };
}

const json = (body = '{"jsonrpc":"2.0","id":1,"result":{}}') =>
  new Response(body, { status: 200, headers: { "content-type": "application/json" } });

interface Result {
  ran_at: string | null;
  collisions: string[];
  warnings: string[];
  config_hash?: string;
}

async function writeToml(name: string, contents: string): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, contents);
  return p;
}

async function run(
  toml: string,
  opts: { deployToken?: string } = {},
): Promise<{ code: number; result: Result; lines: string[] }> {
  const tomlPath = await writeToml("webmcp.toml", toml);
  const outDir = path.join(tmpDir, "preflight-out");
  const lines: string[] = [];
  const code = await runPreflight(tomlPath, false, {
    outDir,
    log: (l) => lines.push(l),
    deployToken: opts.deployToken ?? "",
  });
  const result = JSON.parse(await fs.readFile(path.join(outDir, "preflight.json"), "utf8")) as Result;
  return { code, result, lines };
}

const mcpWarnings = (r: Result) => r.warnings.filter((w) => /MCP server/.test(w));

describe("preflight: an origin MCP server at the landing path", () => {
  it("warns (not a collision) when origin answers a JSON-RPC initialize with 200 JSON", async () => {
    stubOrigin({ "https://example.com/mcp": json() });

    const { code, result } = await run(MINIMAL);

    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    const warnings = mcpWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("/mcp");
    expect(warnings[0]).toMatch(/not HTML|non-HTML|HTML GET/i);
  });

  it("warns for a 200 text/event-stream answer, and does not wait for the stream to end", async () => {
    // A stream that never closes: preflight must cancel the body rather than read it.
    const never = new ReadableStream<Uint8Array>({ start() {} });
    stubOrigin({
      "https://example.com/mcp": new Response(never, { status: 200, headers: { "content-type": "text/event-stream" } }),
    });

    const { result } = await run(MINIMAL);

    expect(mcpWarnings(result)).toHaveLength(1);
  });

  it("matches the content type case-insensitively and with a charset", async () => {
    stubOrigin({
      "https://example.com/mcp": new Response("{}", { status: 200, headers: { "content-type": "Application/JSON; charset=utf-8" } }),
    });

    expect(mcpWarnings((await run(MINIMAL)).result)).toHaveLength(1);
  });

  it("adds nothing when origin answers 200 HTML (an ordinary page at that path)", async () => {
    stubOrigin({
      "https://example.com/mcp": new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }),
    });

    const { code, result } = await run(MINIMAL);

    expect(code).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.collisions).toEqual([]);
  });

  it.each([404, 405, 401, 400, 500])("adds nothing when origin answers %i, even with a JSON body", async (status) => {
    stubOrigin({
      "https://example.com/mcp": new Response('{"error":"x"}', { status, headers: { "content-type": "application/json" } }),
    });

    const { code, result } = await run(MINIMAL);

    expect(code).toBe(0);
    expect(mcpWarnings(result)).toEqual([]);
  });

  it("adds nothing for a 3xx (the probe does not follow redirects)", async () => {
    const { calls } = stubOrigin({
      "https://example.com/mcp": new Response(null, { status: 307, headers: { location: "https://www.example.com/mcp" } }),
    });

    const { result } = await run(MINIMAL);

    expect(mcpWarnings(result)).toEqual([]);
    expect(calls.map((c) => c.url)).not.toContain("https://www.example.com/mcp");
  });

  it("does not fail, warn or collide when the request errors", async () => {
    stubOrigin({ "https://example.com/mcp": new TypeError("fetch failed") });

    const { code, result } = await run(MINIMAL);

    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(mcpWarnings(result)).toEqual([]);
  });

  it("sends a minimal JSON-RPC 2.0 initialize with JSON and event-stream accepted, and does not follow redirects", async () => {
    const { posts } = stubOrigin();

    await run(MINIMAL);

    expect(posts()).toHaveLength(1);
    const { url, init } = posts()[0]!;
    expect(url).toBe("https://example.com/mcp");
    expect(init.redirect).toBe("manual");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["accept"]).toBe("application/json, text/event-stream");
    expect(JSON.parse(init.body as string)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "cf-webmcp-preflight", version: PKG_VERSION },
      },
    });
  });

  it("sends the deploy-token headers on the probe when a token is set, and none when it is not", async () => {
    const withToken = stubOrigin();
    await run(MINIMAL, { deployToken: "tok-123" });
    const sent = withToken.posts()[0]!.init.headers as Record<string, string>;
    expect(sent["cf-webmcp-bypass"]).toBe("1");
    expect(sent["cf-webmcp-deploy-token"]).toBe("tok-123");

    vi.unstubAllGlobals();
    const without = stubOrigin();
    await run(MINIMAL);
    const bare = without.posts()[0]!.init.headers as Record<string, string>;
    expect(Object.keys(bare).filter((k) => k.startsWith("cf-webmcp"))).toEqual([]);
  });

  it("probes the claimed /mcp/ and the slash-less /mcp for a directory-form landing path", async () => {
    const { posts } = stubOrigin({ "https://example.com/mcp": json() });

    const { result } = await run(`${MINIMAL}\n[webmcp_landing]\npath = "/mcp/"\n`);

    expect(posts().map((c) => c.url)).toEqual(["https://example.com/mcp/", "https://example.com/mcp"]);
    const warnings = mcpWarnings(result);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.startsWith("/mcp:")).toBe(true);
  });

  it("probes a custom landing path", async () => {
    const { posts } = stubOrigin({ "https://example.com/pair": json() });

    const { result } = await run(`${MINIMAL}\n[webmcp_landing]\npath = "/pair"\n`);

    expect(posts().map((c) => c.url)).toEqual(["https://example.com/pair"]);
    expect(mcpWarnings(result)[0]!.startsWith("/pair:")).toBe(true);
  });

  it("sends no probe at all when the landing feature is off", async () => {
    const { posts } = stubOrigin({ "https://example.com/mcp": json() });

    const { result } = await run(`${MINIMAL}\n[features]\nwebmcp_landing = false\n`);

    expect(posts()).toEqual([]);
    expect(mcpWarnings(result)).toEqual([]);
  });

  it("still reports the GET collisions it always did", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) =>
        init.method !== "POST" && String(input) === "https://example.com/mcp"
          ? new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } })
          : new Response("not found", { status: 404 }),
      ),
    );

    const { code, result } = await run(MINIMAL);

    expect(code).toBe(1);
    expect(result.collisions).toEqual(["/mcp: origin already serves content here"]);
  });
});

describe("preflight: config hash", () => {
  const PARENT = `
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
  const CHILD = `
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

  async function buildHash(tomlPath: string, outDir: string): Promise<string> {
    await buildConfig({ tomlPath, outDir });
    const hashTs = await fs.readFile(path.join(outDir, "hash.ts"), "utf8");
    return /CONFIG_HASH = "([0-9a-f]+)"/.exec(hashTs)![1]!;
  }

  it("equals the build's CONFIG_HASH for a TOML with inherits", async () => {
    stubOrigin();
    await writeToml("parent.toml", PARENT);
    const childPath = await writeToml("child.toml", CHILD);
    const outDir = path.join(tmpDir, "shared-out");

    const buildsAs = await buildHash(childPath, outDir);
    await runPreflight(childPath, false, { outDir, log: () => {}, deployToken: "" });
    const result = JSON.parse(await fs.readFile(path.join(outDir, "preflight.json"), "utf8")) as Result;

    expect(result.config_hash).toBe(buildsAs);
  });

  it("is not flagged stale by the next build of the same TOML", async () => {
    stubOrigin();
    await writeToml("parent.toml", PARENT);
    const childPath = await writeToml("child.toml", CHILD);
    const outDir = path.join(tmpDir, "shared-out");

    await runPreflight(childPath, false, { outDir, log: () => {}, deployToken: "" });
    await buildConfig({ tomlPath: childPath, outDir });
    const configTs = await fs.readFile(path.join(outDir, "config.ts"), "utf8");

    expect(configTs).not.toContain("preflight result is stale");
    expect(configTs).toContain('"ran_at":"20');
  });

  it("accepts a child TOML that takes its required blocks from the parent", async () => {
    stubOrigin();
    await writeToml("parent.toml", PARENT);
    const childPath = await writeToml("child.toml", `inherits = "parent.toml"\nschema_version = 1\n`);
    const outDir = path.join(tmpDir, "shared-out");

    const buildsAs = await buildHash(childPath, outDir);
    const code = await runPreflight(childPath, false, { outDir, log: () => {}, deployToken: "" });
    const result = JSON.parse(await fs.readFile(path.join(outDir, "preflight.json"), "utf8")) as Result;

    expect(code).toBe(0);
    expect(result.config_hash).toBe(buildsAs);
  });

  it("equals the build's CONFIG_HASH for a TOML without inherits", async () => {
    stubOrigin();
    const tomlPath = await writeToml("plain.toml", MINIMAL);
    const outDir = path.join(tmpDir, "shared-out");

    const buildsAs = await buildHash(tomlPath, outDir);
    await runPreflight(tomlPath, false, { outDir, log: () => {}, deployToken: "" });
    const result = JSON.parse(await fs.readFile(path.join(outDir, "preflight.json"), "utf8")) as Result;

    expect(result.config_hash).toBe(buildsAs);
  });
});
