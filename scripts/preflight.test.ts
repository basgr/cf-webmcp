import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs, probeUrl, runPreflight } from "./preflight";
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
  opts: { deployToken?: string; origin?: string } = {},
): Promise<{ code: number; result: Result; lines: string[] }> {
  const tomlPath = await writeToml("webmcp.toml", toml);
  const outDir = path.join(tmpDir, "preflight-out");
  const lines: string[] = [];
  const code = await runPreflight(tomlPath, false, {
    outDir,
    log: (l) => lines.push(l),
    deployToken: opts.deployToken ?? "",
    origin: opts.origin,
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
    expect(warnings[0]).toContain(
      "GET and HEAD requests get the landing page unless their Accept header asks for text/event-stream; every other method goes to origin",
    );
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

describe("preflight: GET probes for a directory-form landing path", () => {
  const DIR_FORM = `${MINIMAL}\n[webmcp_landing]\npath = "/mcp/"\n`;
  const html = () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const getUrls = (calls: FetchCall[]) => calls.filter((c) => c.init.method === "GET").map((c) => c.url);

  /** GET answers keyed by URL; everything else 404, POST included. */
  function stubGets(answers: Record<string, () => Response>) {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        const answer = init.method === "GET" ? answers[String(input)] : undefined;
        return answer ? answer() : new Response("not found", { status: 404 });
      }),
    );
    return calls;
  }

  it("probes both /mcp/ and the slash-less /mcp, which the Worker claims for browser GETs", async () => {
    const calls = stubGets({});

    await run(DIR_FORM);

    const urls = getUrls(calls);
    expect(urls).toContain("https://example.com/mcp/");
    expect(urls).toContain("https://example.com/mcp");
  });

  it("reports a collision when origin serves content at the slash-less /mcp", async () => {
    stubGets({ "https://example.com/mcp": html });

    const { code, result } = await run(DIR_FORM);

    expect(code).toBe(1);
    expect(result.collisions).toEqual(["/mcp: origin already serves content here"]);
  });

  it("reports a collision at /mcp/ as before", async () => {
    stubGets({ "https://example.com/mcp/": html });

    const { code, result } = await run(DIR_FORM);

    expect(code).toBe(1);
    expect(result.collisions).toEqual(["/mcp/: origin already serves content here"]);
  });

  it("treats a redirect from /mcp to /mcp/ at origin as free, like any 3xx", async () => {
    stubGets({
      "https://example.com/mcp": () => new Response(null, { status: 301, headers: { location: "/mcp/" } }),
    });

    const { code, result } = await run(DIR_FORM);

    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
  });

  it("probes only /mcp for a file-form landing path, and only the configured path for a custom one", async () => {
    const plain = stubGets({});
    await run(MINIMAL);
    expect(getUrls(plain).filter((u) => u.includes("/mcp"))).toEqual(["https://example.com/mcp"]);

    vi.unstubAllGlobals();
    const custom = stubGets({});
    await run(`${MINIMAL}\n[webmcp_landing]\npath = "/pair"\n`);
    expect(getUrls(custom).filter((u) => u.includes("/pair"))).toEqual(["https://example.com/pair"]);
  });

  it("probes no landing path at all when the landing feature is off", async () => {
    const calls = stubGets({});

    await run(`${DIR_FORM}\n[features]\nwebmcp_landing = false\n`);

    expect(getUrls(calls).filter((u) => /\/mcp\/?$/.test(u))).toEqual([]);
  });
});

describe("preflight: the ARD manifest (ard.json) and its aliases", () => {
  const ARD = "https://example.com/.well-known/ard.json";
  const PREDECESSOR = "https://example.com/.well-known/ai-catalog.json";
  const ON = `${MINIMAL}\n[features]\nai_catalog = true\n`;
  const withMode = (mode: string, extra = "") => `${ON}\n[ai_catalog]\nmode = "${mode}"\n${extra}`;
  const getUrls = (calls: FetchCall[]) => calls.filter((c) => c.init.method === "GET").map((c) => c.url);
  const json = (body: unknown, ct = "application/json") => () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": ct } });
  const html = () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const text = () => new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
  const VALID = { entries: [{ identifier: "urn:air:example.com:agent:x", displayName: "X", type: "application/a2a-agent-card+json", url: "https://example.com/x.json" }] };

  /** GET answers keyed by URL; everything else 404, POST included. */
  function stubGets(answers: Record<string, () => Response>) {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        const answer = init.method === "GET" ? answers[String(input)] : undefined;
        return answer ? answer() : new Response("not found", { status: 404 });
      }),
    );
    return calls;
  }

  it("probes neither path when the feature is off or in passthrough", async () => {
    const off = stubGets({});
    await run(MINIMAL);
    expect(getUrls(off)).not.toContain(ARD);
    expect(getUrls(off)).not.toContain(PREDECESSOR);

    vi.unstubAllGlobals();
    const pt = stubGets({});
    await run(withMode("passthrough"));
    expect(getUrls(pt)).not.toContain(ARD);
    expect(getUrls(pt)).not.toContain(PREDECESSOR);
  });

  it("probes the canonical path and the predecessor alias", async () => {
    const calls = stubGets({});
    const { code, result } = await run(ON);
    expect(getUrls(calls)).toContain(ARD);
    expect(getUrls(calls)).toContain(PREDECESSOR);
    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
  });

  it("synthesize: a 200 at the canonical path or at the alias is a COLLISION (the Worker shadows it)", async () => {
    stubGets({ [ARD]: json(VALID), [PREDECESSOR]: json(VALID) });
    const { code, result } = await run(ON);
    expect(code).toBe(1);
    expect(result.collisions).toEqual([
      "/.well-known/ard.json: origin already serves content here",
      "/.well-known/ai-catalog.json: origin already serves content here",
    ]);
  });

  it("merge: a 200 JSON ARD document at the canonical path is reported as a merge, not a collision", async () => {
    stubGets({ [ARD]: json(VALID) });
    const { code, result, lines } = await run(withMode("merge"));
    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(result.warnings.filter((w) => w.includes("ard.json"))).toEqual([]);
    expect(lines.find((l) => l.includes("/.well-known/ard.json"))).toMatch(/merge/);
  });

  it("merge: a 200 JSON document at the predecessor path is a merge too, in either JSON type", async () => {
    for (const ct of ["application/json", "application/ai-catalog+json"]) {
      vi.unstubAllGlobals();
      stubGets({ [PREDECESSOR]: json(VALID, ct) });
      const { code, result, lines } = await run(withMode("merge"));
      expect(code, ct).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(lines.find((l) => l.includes("/.well-known/ai-catalog.json"))).toMatch(/merge/);
    }
  });

  it("merge: HTML at the canonical path is a COLLISION", async () => {
    stubGets({ [ARD]: html });
    const { code, result } = await run(withMode("merge"));
    expect(code).toBe(1);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toMatch(/^\/\.well-known\/ard\.json: .*text\/html/);
  });

  it("merge: text at the predecessor path, read after a canonical 404, is a COLLISION", async () => {
    stubGets({ [PREDECESSOR]: text });
    const { code, result } = await run(withMode("merge"));
    expect(code).toBe(1);
    expect(result.collisions).toHaveLength(1);
    expect(result.collisions[0]).toMatch(/^\/\.well-known\/ai-catalog\.json: .*text\/plain/);
  });

  it("merge: accepts application/ld+json", async () => {
    stubGets({ [ARD]: json(VALID, "application/ld+json") });
    const { code, result } = await run(withMode("merge"));
    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
  });

  it.each([500, 503, 410, 403])(
    "merge: a %i at the canonical path is a WARNING (the Worker serves the generated document), not a COLLISION",
    async (status) => {
      stubGets({ [ARD]: () => new Response("x", { status, headers: { "content-type": "text/plain" } }) });
      const { code, result } = await run(withMode("merge"));
      expect(code).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(result.warnings.filter((w) => w.startsWith("/.well-known/ard.json"))).toEqual([
        `/.well-known/ard.json: origin answers ${status}; in merge mode the Worker serves the generated document instead`,
      ]);
    },
  );

  it("merge: a 503 at the predecessor path after a canonical 404 is a WARNING too", async () => {
    stubGets({ [PREDECESSOR]: () => new Response("x", { status: 503 }) });
    const { code, result } = await run(withMode("merge"));
    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ai-catalog.json"))).toEqual([
      "/.well-known/ai-catalog.json: origin answers 503; in merge mode the Worker serves the generated document instead",
    ]);
  });

  it("merge: with a valid ard.json at origin, a document at the predecessor path is reported as redirected, not merged", async () => {
    stubGets({ [ARD]: json(VALID), [PREDECESSOR]: json(VALID, "application/ai-catalog+json") });
    const { code, result, lines } = await run(withMode("merge"));
    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(lines.find((l) => l.includes("/.well-known/ai-catalog.json"))).toMatch(/redirected to \/\.well-known\/ard\.json, not merged/);
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ai-catalog.json"))).toEqual([
      "/.well-known/ai-catalog.json: origin serves a document here too, but the Worker redirects this path to /.well-known/ard.json and does not merge it",
    ]);
  });

  it("merge: the predecessor path is not read after a canonical answer other than 404, so its own answer is not judged", async () => {
    stubGets({ [ARD]: () => new Response("x", { status: 500 }), [PREDECESSOR]: html });
    const { result, lines } = await run(withMode("merge"));
    expect(result.collisions).toEqual([]);
    expect(lines.find((l) => l.includes("/.well-known/ai-catalog.json"))).toMatch(/not merged/);
  });

  it("merge with aliases = []: a document at the predecessor path next to a valid ard.json is left to origin, no warning", async () => {
    stubGets({ [ARD]: json(VALID), [PREDECESSOR]: json(VALID) });
    const { code, result, lines } = await run(withMode("merge", "aliases = []\n"));
    expect(code).toBe(0);
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ai-catalog.json"))).toEqual([]);
    expect(lines.find((l) => l.includes("/.well-known/ai-catalog.json"))).toMatch(/not read, origin answers at \/\.well-known\/ard\.json/);
  });

  it("merge: a body declared as JSON that does not parse is a COLLISION", async () => {
    stubGets({ [ARD]: () => new Response("<html>", { status: 200, headers: { "content-type": "application/json" } }) });
    const { code, result } = await run(withMode("merge"));
    expect(code).toBe(1);
    expect(result.collisions).toEqual(["/.well-known/ard.json: origin answers 200 application/json but the body is not JSON"]);
  });

  it("merge: JSON that is not an ARD v0.91 document is not a collision, but warns that it is relayed unchanged", async () => {
    stubGets({ [ARD]: json({ specVersion: "1.0", entries: [{ displayName: "no identifier" }] }) });
    const { code, result } = await run(withMode("merge"));
    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ard.json"))).toEqual([
      "/.well-known/ard.json: origin's JSON is not an ARD manifest (an object with an entries array of objects with a string identifier, nested at most 64 levels deep); the Worker relays it unchanged and adds no entry",
    ]);
  });

  it("merge: an ARD document nested more than 64 levels deep is judged as the Worker judges it: relayed unchanged", async () => {
    const rowOf = (lines: string[], label: string) => lines.find((l) => l.trimStart().startsWith(label));
    const deep = (depth: number) =>
      () =>
        new Response(`{"entries":[{"identifier":"urn:air:example.com:agent:deep","x":${"[".repeat(depth - 3)}${"]".repeat(depth - 3)}}]}`, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
    for (const depth of [2_000, 65]) {
      vi.unstubAllGlobals();
      stubGets({ [ARD]: deep(depth) });
      const { code, result, lines } = await run(withMode("merge"));
      expect(code, String(depth)).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(rowOf(lines, "/.well-known/ard.json"), String(depth)).toContain("merge refused");
      expect(result.warnings.filter((w) => w.startsWith("/.well-known/ard.json"))).toHaveLength(1);
    }
    vi.unstubAllGlobals();
    stubGets({ [ARD]: deep(64) });
    const { lines, result } = await run(withMode("merge"));
    expect(rowOf(lines, "/.well-known/ard.json")).not.toContain("refused");
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ard.json"))).toEqual([]);
  });

  it("merge: probes the predecessor path even when aliases is empty, because the merge reads it", async () => {
    const calls = stubGets({});
    await run(withMode("merge", "aliases = []\n"));
    expect(getUrls(calls)).toContain(PREDECESSOR);
  });

  it("merge: a custom alias is a claim, so a 200 there is a COLLISION", async () => {
    stubGets({ "https://example.com/.well-known/ard": json(VALID) });
    const { result } = await run(withMode("merge", 'aliases = ["/.well-known/ai-catalog.json", "/.well-known/ard"]\n'));
    expect(result.collisions).toEqual(["/.well-known/ard: origin already serves content here"]);
  });

  it("probes an alias equal to the canonical path once", async () => {
    const calls = stubGets({});
    await run(withMode("synthesize", 'aliases = ["/.well-known/ard.json"]\n'));
    expect(getUrls(calls).filter((u) => u === ARD)).toHaveLength(1);
    expect(getUrls(calls)).not.toContain(PREDECESSOR);
  });
});

describe("preflight: an origin file over the Worker's 1 MiB merge cap", () => {
  const MIB = 1024 * 1024;
  const ARD = "https://example.com/.well-known/ard.json";
  const PREDECESSOR = "https://example.com/.well-known/ai-catalog.json";
  const ARD_ON = `${MINIMAL}\n[features]\nai_catalog = true\n\n[ai_catalog]\nmode = "merge"\n`;
  const VALID_ARD = JSON.stringify({
    entries: [{ identifier: "urn:air:example.com:agent:x", displayName: "X", type: "application/a2a-agent-card+json", url: "https://example.com/x.json" }],
  });
  /** `head`, then spaces, to exactly `size` bytes. */
  const padded = (head: string, size: number): Uint8Array => {
    const bytes = new Uint8Array(size).fill(0x20);
    bytes.set(new TextEncoder().encode(head));
    return bytes;
  };
  /** The same bytes as a stream with no Content-Length, in 64 KiB chunks. */
  const streamed = (bytes: Uint8Array): ReadableStream<Uint8Array> => {
    let at = 0;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= bytes.length) return c.close();
        c.enqueue(bytes.subarray(at, at + 65536));
        at += 65536;
      },
    });
  };

  function stubGets(answers: Record<string, () => Response>) {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        const answer = init.method === "GET" ? answers[String(input)] : undefined;
        return answer ? answer() : new Response("not found", { status: 404 });
      }),
    );
    return calls;
  }
  const doc = (bytes: Uint8Array | ReadableStream<Uint8Array>, ct: string, headers: Record<string, string> = {}) => () =>
    new Response(bytes as BodyInit, { status: 200, headers: { "content-type": ct, ...headers } });

  const TOO_LARGE = "too large to merge, relayed unchanged";
  const rowOf = (lines: string[], label: string) => lines.find((l) => l.trimStart().startsWith(label));

  it("ARD merge: a valid document over 1 MiB is reported as too large to merge, relayed unchanged, a warning", async () => {
    stubGets({ [ARD]: doc(padded(VALID_ARD, MIB + 1), "application/json") });

    const { code, result, lines } = await run(ARD_ON);

    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(rowOf(lines, "/.well-known/ard.json")).toContain(`WARNING (${TOO_LARGE})`);
    expect(rowOf(lines, "/.well-known/ard.json")).not.toMatch(/ merge \(ARD manifest/);
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ard.json"))).toEqual([
      "/.well-known/ard.json: origin's document is over 1 MiB, too large to merge, relayed unchanged; the Worker adds no entry",
    ]);
  });

  it("ARD merge: the same when the size is found by reading, with no Content-Length", async () => {
    stubGets({ [ARD]: doc(streamed(padded(VALID_ARD, MIB + 100_000)), "application/json") });

    const { code, result, lines } = await run(ARD_ON);

    expect(code).toBe(0);
    expect(rowOf(lines, "/.well-known/ard.json")).toContain(TOO_LARGE);
    expect(result.warnings.filter((w) => w.includes("too large to merge"))).toHaveLength(1);
  });

  it("ARD merge: a Content-Length over the cap is enough, the body is not read", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    stubGets({ [ARD]: doc(body, "application/json", { "content-length": String(MIB + 1) }) });

    const { lines } = await run(ARD_ON);

    expect(rowOf(lines, "/.well-known/ard.json")).toContain(TOO_LARGE);
    expect(pulled).toBe(false);
  });

  it("ARD merge: a document of exactly 1 MiB is still a merge", async () => {
    stubGets({ [ARD]: doc(padded(VALID_ARD, MIB), "application/json") });

    const { code, result, lines } = await run(ARD_ON);

    expect(code).toBe(0);
    expect(rowOf(lines, "/.well-known/ard.json")).toMatch(/ merge \(ARD manifest/);
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ard.json"))).toEqual([]);
  });

  it("ARD merge: size comes first, as in the Worker: an oversize body that is not JSON is relayed, not a collision", async () => {
    stubGets({ [ARD]: doc(padded("<html>", MIB + 1), "application/json") });

    const { code, result } = await run(ARD_ON);

    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(result.warnings.filter((w) => w.includes("too large to merge"))).toHaveLength(1);
  });

  it("ARD merge: an oversize document at the predecessor path, read after a canonical 404, is too large to merge too", async () => {
    stubGets({ [PREDECESSOR]: doc(padded(VALID_ARD, MIB + 1), "application/ai-catalog+json") });

    const { code, result } = await run(ARD_ON);

    expect(code).toBe(0);
    expect(result.collisions).toEqual([]);
    expect(result.warnings.filter((w) => w.startsWith("/.well-known/ai-catalog.json"))).toEqual([
      "/.well-known/ai-catalog.json: origin's document is over 1 MiB, too large to merge, relayed unchanged; the Worker adds no entry",
    ]);
  });

  it("ARD synthesize: an oversize document is still a COLLISION (the Worker shadows it), the cap is a merge matter", async () => {
    stubGets({ [ARD]: doc(padded(VALID_ARD, MIB + 1), "application/json") });

    const { code, result } = await run(`${MINIMAL}\n[features]\nai_catalog = true\n`);

    expect(code).toBe(1);
    expect(result.collisions).toEqual(["/.well-known/ard.json: origin already serves content here"]);
  });

  it.each([
    ["/llms.txt", "text/plain", "# Origin\n"],
    ["/robots.txt", "text/plain", "User-agent: *\n"],
    ["/.well-known/agents.md", "text/markdown", "# Origin\n"],
    ["/.well-known/agent-skills/site/SKILL.md", "text/markdown", "# Origin\n"],
  ])(
    "%s: an origin file over 1 MiB is too large to merge, relayed unchanged: not a merge, not a missing-marker warning",
    async (route, ct, head) => {
      stubGets({ [`https://example.com${route}`]: doc(streamed(padded(head, MIB + 5)), ct) });

      // SKILL.md is a merge only in merge mode (the default, synthesize, never fetches origin's file).
      const { code, result, lines } = await run(`${MINIMAL}
[agent_skills]
mode = "merge"
`);

      expect(code).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(rowOf(lines, route)).toContain(`WARNING (${TOO_LARGE})`);
      expect(result.warnings.filter((w) => w.startsWith(`${route}:`))).toEqual([
        `${route}: origin's file is over 1 MiB, too large to merge, relayed unchanged; the Worker adds no block`,
      ]);
    },
  );

  it("a text file of exactly 1 MiB is still a merge, with the marker check", async () => {
    stubGets({ "https://example.com/llms.txt": doc(padded("# Origin\n<!-- cf-webmcp:begin -->\n", MIB), "text/plain") });

    const { result, lines } = await run(MINIMAL);

    expect(rowOf(lines, "/llms.txt")).toContain("merge (marker present, will replace)");
    expect(result.warnings.filter((w) => w.startsWith("/llms.txt"))).toEqual([]);
  });

  it("names the cap only on the file that is over it", async () => {
    stubGets({ "https://example.com/llms.txt": doc(padded("# Origin\n", MIB + 1), "text/plain") });

    const { code, lines } = await run(MINIMAL);

    expect(code).toBe(0);
    expect(lines.filter((l) => l.includes(TOO_LARGE))).toHaveLength(1);
    expect(rowOf(lines, "/robots.txt")).not.toContain("too large");
  });
});

describe("preflight: a row is a merge only in a mode where the Worker merges, and judges content types as the Worker does", () => {
  const MIB = 1024 * 1024;
  const PROFILE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';
  const bytes = (text: string, size = 0): Uint8Array => {
    const out = new Uint8Array(Math.max(size, text.length)).fill(0x20);
    out.set(new TextEncoder().encode(text));
    return out;
  };
  /** A 200 with the bytes as given and a content type if one is named (a Uint8Array body sets none of its own). */
  const answer = (body: Uint8Array, ct?: string) => () =>
    new Response(body as BodyInit, { status: 200, headers: ct === undefined ? {} : { "content-type": ct } });
  const rowOf = (lines: string[], label: string) => lines.find((l) => l.trimStart().startsWith(label));

  function stubGets(answers: Record<string, () => Response>) {
    const calls: FetchCall[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        calls.push({ url: String(input), init });
        const a = init.method === "GET" ? answers[String(input)] : undefined;
        return a ? a() : new Response("not found", { status: 404 });
      }),
    );
    return calls;
  }
  const getUrls = (calls: FetchCall[]) => calls.filter((c) => c.init.method === "GET").map((c) => c.url);
  const mode = (block: string, value: string) => `${MINIMAL}\n[${block}]\nmode = "${value}"\n`;

  describe.each([
    ["llms.txt", "/llms.txt", "llms_txt", "merge"],
    ["agents.md", "/.well-known/agents.md", "agents_md", "merge"],
    ["SKILL.md", "/.well-known/agent-skills/site/SKILL.md", "agent_skills", "synthesize"],
  ])("%s", (_name, route, block) => {
    const URL_ = `https://example.com${route}`;
    const small = answer(bytes("# Origin\n"), "text/markdown");
    const big = answer(bytes("# Origin\n", MIB + 10), "text/markdown");

    it.each(["synthesize", "replace"])(
      "in %s mode a file at origin is a claim: a COLLISION, never a merge row",
      async (m) => {
        stubGets({ [URL_]: small });
        const { code, result, lines } = await run(mode(block, m));
        expect(code).toBe(1);
        expect(result.collisions).toEqual([`${route}: origin already serves content here`]);
        expect(rowOf(lines, route)).toContain("COLLISION");
        expect(rowOf(lines, route)).not.toMatch(/merge/);
      },
    );

    it.each(["synthesize", "replace"])("in %s mode an oversize file at origin is a COLLISION too, not 'too large to merge'", async (m) => {
      stubGets({ [URL_]: big });
      const { result, lines } = await run(mode(block, m));
      expect(result.collisions).toEqual([`${route}: origin already serves content here`]);
      expect(result.warnings.filter((w) => w.includes("too large"))).toEqual([]);
      expect(lines.filter((l) => l.includes("too large"))).toEqual([]);
    });

    it("in merge mode the file is a merge row, and an oversize one is too large to merge", async () => {
      stubGets({ [URL_]: small });
      const a = await run(mode(block, "merge"));
      expect(a.result.collisions).toEqual([]);
      expect(rowOf(a.lines, route)).toMatch(/merge \(marker absent/);

      vi.unstubAllGlobals();
      stubGets({ [URL_]: big });
      const b = await run(mode(block, "merge"));
      expect(rowOf(b.lines, route)).toContain("too large to merge, relayed unchanged");
      expect(b.result.warnings.filter((w) => w.startsWith(`${route}:`))).toHaveLength(1);
    });

    it("with no 404 and no file at origin, every mode is clean", async () => {
      stubGets({});
      for (const m of ["synthesize", "replace", "merge"]) {
        const r = await run(mode(block, m));
        expect(r.code, m).toBe(0);
      }
    });
  });

  it("the defaults: llms.txt and agents.md merge, SKILL.md does not (synthesize is its default mode)", async () => {
    stubGets({
      "https://example.com/llms.txt": answer(bytes("# o\n"), "text/plain"),
      "https://example.com/.well-known/agents.md": answer(bytes("# o\n"), "text/markdown"),
      "https://example.com/.well-known/agent-skills/site/SKILL.md": answer(bytes("# o\n"), "text/markdown"),
    });
    const { result } = await run(MINIMAL);
    expect(result.collisions).toEqual(["/.well-known/agent-skills/site/SKILL.md: origin already serves content here"]);
  });

  describe("content types are the Worker's", () => {
    it.each([
      ["/llms.txt", undefined],
      ["/robots.txt", undefined],
      ["/.well-known/agents.md", undefined],
    ])("%s: a 200 without a Content-Type is mergeable, as in the Worker", async (route, ct) => {
      stubGets({ [`https://example.com${route}`]: answer(bytes("hello\n"), ct) });
      const { code, result, lines } = await run(MINIMAL);
      expect(code).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(rowOf(lines, route)).toMatch(/merge \(marker/);
    });

    it("SKILL.md in merge mode: no Content-Type and text/x-markdown merge", async () => {
      for (const ct of [undefined, "text/x-markdown", "text/plain; charset=utf-8"]) {
        vi.unstubAllGlobals();
        stubGets({ "https://example.com/.well-known/agent-skills/site/SKILL.md": answer(bytes("# o\n"), ct) });
        const { result, lines } = await run(mode("agent_skills", "merge"));
        expect(result.collisions, String(ct)).toEqual([]);
        expect(rowOf(lines, "/.well-known/agent-skills/site/SKILL.md"), String(ct)).toMatch(/merge \(marker/);
      }
    });

    it("llms.txt and agents.md do not take text/x-markdown, nor robots.txt text/markdown: the Worker relays those, so they collide", async () => {
      stubGets({ "https://example.com/llms.txt": answer(bytes("# o\n"), "text/x-markdown") });
      expect((await run(MINIMAL)).result.collisions).toEqual([expect.stringMatching(/^\/llms\.txt: expected text\/plain or text\/markdown/)]);

      vi.unstubAllGlobals();
      stubGets({ "https://example.com/robots.txt": answer(bytes("# o\n"), "text/markdown") });
      expect((await run(MINIMAL)).result.collisions).toEqual([expect.stringMatching(/^\/robots\.txt: expected text\/plain/)]);
    });
  });

  describe("the API catalog (merge mode is the default) is a merge row, JSON-aware, with the cap", () => {
    const API = "https://example.com/.well-known/api-catalog";
    const LINKSET = JSON.stringify({ linkset: [{ anchor: "https://example.com/api", "service-doc": [{ href: "https://example.com/docs" }] }] });

    it.each([PROFILE, "application/linkset+json", "application/json", undefined])(
      "a valid linkset (Content-Type %s) is a merge, not a COLLISION",
      async (ct) => {
        stubGets({ [API]: answer(bytes(LINKSET), ct) });
        const { code, result, lines } = await run(MINIMAL);
        expect(code, String(ct)).toBe(0);
        expect(result.collisions, String(ct)).toEqual([]);
        expect(rowOf(lines, "/.well-known/api-catalog"), String(ct)).toMatch(/ merge \(linkset/);
        expect(result.warnings.filter((w) => w.startsWith("/.well-known/api-catalog"))).toEqual([]);
      },
    );

    it("a body that is not a linkset is a warning: the Worker serves its own catalog and drops origin's", async () => {
      stubGets({ [API]: answer(bytes('{"hello":"world"}'), "application/json") });
      const { code, result, lines } = await run(MINIMAL);
      expect(code).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(rowOf(lines, "/.well-known/api-catalog")).toContain("WARNING");
      expect(result.warnings.filter((w) => w.startsWith("/.well-known/api-catalog"))).toEqual([
        "/.well-known/api-catalog: origin's JSON is not an RFC 9264 linkset (an object with a linkset array of objects with a string anchor, nested at most 64 levels deep); the Worker serves its generated catalog instead of it",
      ]);
    });

    it("a linkset nested more than 64 levels deep is the same warning, as the Worker serves its own catalog for it", async () => {
      const nested = (depth: number) =>
        `{"linkset":[{"anchor":"https://example.com/api","x":${"[".repeat(depth - 3)}${"]".repeat(depth - 3)}}]}`;
      for (const depth of [2_000, 65]) {
        vi.unstubAllGlobals();
        stubGets({ [API]: answer(bytes(nested(depth)), "application/json") });
        const { code, result, lines } = await run(MINIMAL);
        expect(code, String(depth)).toBe(0);
        expect(rowOf(lines, "/.well-known/api-catalog"), String(depth)).toContain("WARNING");
        expect(result.warnings.filter((w) => w.startsWith("/.well-known/api-catalog"))).toHaveLength(1);
      }
      vi.unstubAllGlobals();
      stubGets({ [API]: answer(bytes(nested(64)), "application/json") });
      expect(rowOf((await run(MINIMAL)).lines, "/.well-known/api-catalog")).toMatch(/ merge \(linkset/);
    });

    it("a body that is not JSON is the same warning", async () => {
      stubGets({ [API]: answer(bytes("<html>"), "application/json") });
      const { code, result } = await run(MINIMAL);
      expect(code).toBe(0);
      expect(result.warnings.filter((w) => w.startsWith("/.well-known/api-catalog"))).toHaveLength(1);
    });

    it("HTML or another content type is a COLLISION (the Worker relays it, so its entry never appears)", async () => {
      stubGets({ [API]: answer(bytes("<html></html>"), "text/html") });
      const { code, result } = await run(MINIMAL);
      expect(code).toBe(1);
      expect(result.collisions).toEqual([expect.stringMatching(/^\/\.well-known\/api-catalog: expected a linkset/)]);
    });

    it("an oversize catalog is too large to merge, relayed unchanged, judged before its content", async () => {
      stubGets({ [API]: answer(bytes("<not json>", MIB + 1), "application/linkset+json") });
      const { code, result, lines } = await run(MINIMAL);
      expect(code).toBe(0);
      expect(result.collisions).toEqual([]);
      expect(rowOf(lines, "/.well-known/api-catalog")).toContain("too large to merge, relayed unchanged");
      expect(result.warnings.filter((w) => w.startsWith("/.well-known/api-catalog"))).toEqual([
        "/.well-known/api-catalog: origin's document is over 1 MiB, too large to merge, relayed unchanged; the Worker adds no entry",
      ]);
    });

    it("a catalog of exactly 1 MiB is still a merge", async () => {
      stubGets({ [API]: answer(bytes(LINKSET, MIB), "application/linkset+json") });
      const { result, lines } = await run(MINIMAL);
      expect(result.collisions).toEqual([]);
      expect(rowOf(lines, "/.well-known/api-catalog")).toMatch(/ merge \(linkset/);
    });

    it.each(["synthesize", "replace"])("in %s mode a catalog at origin is a COLLISION (the Worker answers there)", async (m) => {
      stubGets({ [API]: answer(bytes(LINKSET), "application/linkset+json") });
      const { code, result } = await run(mode("api_catalog", m));
      expect(code).toBe(1);
      expect(result.collisions).toEqual(["/.well-known/api-catalog: origin already serves content here"]);
    });
  });

  describe("only documents the Worker serves are probed", () => {
    const API = "https://example.com/.well-known/api-catalog";
    const INDEX = "https://example.com/.well-known/agent-skills/index.json";

    it("the API catalog is probed with the manifest on, and not with it off or the catalog in passthrough or off", async () => {
      const served = stubGets({});
      await run(MINIMAL);
      expect(getUrls(served)).toContain(API);
      for (const toml of [
        `${MINIMAL}\n[features]\nmanifest = false\n`,
        `${MINIMAL}\n[features]\napi_catalog = false\n`,
        mode("api_catalog", "passthrough"),
      ]) {
        vi.unstubAllGlobals();
        const calls = stubGets({ [API]: answer(bytes("{}"), "application/json") });
        const { code, result } = await run(toml);
        expect(getUrls(calls), toml).not.toContain(API);
        expect(code).toBe(0);
        expect(result.collisions).toEqual([]);
      }
    });

    it("the skills index is probed when it is served, and not with agent_skills off, merge or passthrough", async () => {
      const served = stubGets({});
      await run(MINIMAL);
      expect(getUrls(served)).toContain(INDEX);
      for (const toml of [
        `${MINIMAL}\n[features]\nagent_skills = false\n`,
        mode("agent_skills", "merge"),
        mode("agent_skills", "passthrough"),
        `${MINIMAL}\n[features]\nagent_skills_index = false\n`,
      ]) {
        vi.unstubAllGlobals();
        const calls = stubGets({ [INDEX]: answer(bytes("{}"), "application/json") });
        const { code, result } = await run(toml);
        expect(getUrls(calls), toml).not.toContain(INDEX);
        expect(code).toBe(0);
        expect(result.collisions).toEqual([]);
      }
    });
  });
});

describe("preflight: --origin overrides where the probes go, and nothing else", () => {
  const OVERRIDE = "https://origin.internal.example";
  const hostsOf = (calls: FetchCall[]) => [...new Set(calls.map((c) => new URL(c.url).host))];

  async function sharedOutHashes(toml: string, origin: string | undefined) {
    const tomlPath = await writeToml("webmcp.toml", toml);
    const outDir = path.join(tmpDir, "shared-out");
    await buildConfig({ tomlPath, outDir });
    const buildHash = /CONFIG_HASH = "([0-9a-f]+)"/.exec(await fs.readFile(path.join(outDir, "hash.ts"), "utf8"))![1]!;
    await runPreflight(tomlPath, false, { outDir, log: () => {}, deployToken: "", origin });
    const result = JSON.parse(await fs.readFile(path.join(outDir, "preflight.json"), "utf8")) as Result;
    return { buildHash, preflightHash: result.config_hash, outDir };
  }

  it("sends every probe, GET and POST, to the override host and none to [origin].base_url", async () => {
    const { calls } = stubOrigin();

    await run(MINIMAL, { origin: OVERRIDE });

    expect(calls.length).toBeGreaterThan(10);
    expect(hostsOf(calls)).toEqual(["origin.internal.example"]);
    expect(calls.map((c) => c.url)).toContain(`${OVERRIDE}/mcp`);
    expect(calls.map((c) => c.url)).toContain(`${OVERRIDE}/.well-known/webmcp`);
    expect(calls.some((c) => c.init.method === "POST" && c.url === `${OVERRIDE}/mcp`)).toBe(true);
  });

  it("keeps the paths and does not follow redirects", async () => {
    const { calls } = stubOrigin();

    await run(`${MINIMAL}\n[webmcp_landing]\npath = "/mcp/"\n`, { origin: `${OVERRIDE}/` });

    const urls = calls.map((c) => c.url);
    expect(urls).toContain(`${OVERRIDE}/mcp/`);
    expect(urls).toContain(`${OVERRIDE}/mcp`);
    expect(urls).toContain(`${OVERRIDE}/llms.txt`);
    expect(calls.every((c) => c.init.redirect === "manual")).toBe(true);
  });

  const LISTED = MINIMAL.replace('allowed_origins = ["https://example.com"]', `allowed_origins = ["https://example.com", "${OVERRIDE}"]`);

  it("sends the deploy token headers to the override host only, when allowed_origins lists it", async () => {
    const { calls } = stubOrigin();

    await run(LISTED, { origin: OVERRIDE, deployToken: "tok-123" });

    expect(calls.length).toBeGreaterThan(10);
    for (const { url, init } of calls) {
      expect(new URL(url).host, url).toBe("origin.internal.example");
      const headers = init.headers as Record<string, string>;
      expect(headers["cf-webmcp-deploy-token"], url).toBe("tok-123");
      expect(headers["cf-webmcp-bypass"], url).toBe("1");
    }
  });

  it("withholds the token from an override host that allowed_origins does not list, probes it all the same, and says why", async () => {
    const { calls } = stubOrigin();

    const { code, lines } = await run(MINIMAL, { origin: OVERRIDE, deployToken: "tok-123" });

    expect(code).toBe(0);
    expect(calls.length).toBeGreaterThan(10);
    for (const { url, init } of calls) {
      expect(new URL(url).host, url).toBe("origin.internal.example");
      const names = Object.keys(init.headers as Record<string, string>);
      expect(names.filter((n) => n.startsWith("cf-webmcp")), url).toEqual([]);
    }
    const text = lines.join("\n");
    expect(text).toContain("token: withheld");
    expect(text).toContain(`${OVERRIDE} is not in [origin].allowed_origins`);
    expect(text).not.toContain("tok-123");
  });

  it("stamps the hash of the unmodified config: it equals the build's CONFIG_HASH", async () => {
    stubOrigin();

    const { buildHash, preflightHash } = await sharedOutHashes(MINIMAL, OVERRIDE);

    expect(preflightHash).toBe(buildHash);
  });

  it("stamps the same hash with and without --origin, and the next build does not call the result stale", async () => {
    stubOrigin();

    const withOverride = await sharedOutHashes(MINIMAL, OVERRIDE);
    const without = await sharedOutHashes(MINIMAL, undefined);
    expect(withOverride.preflightHash).toBe(without.preflightHash);

    // The next build of the same TOML, in the directory preflight wrote to.
    const tomlPath = path.join(tmpDir, "webmcp.toml");
    await buildConfig({ tomlPath, outDir: without.outDir });
    expect(await fs.readFile(path.join(without.outDir, "config.ts"), "utf8")).not.toContain("preflight result is stale");
  });

  it.each([
    ["https://origin.internal.example"],
    ["https://origin.internal.example/"],
    ["http://localhost:8080"],
    ["https://origin.internal.example:8443"],
  ])("accepts %s", async (origin) => {
    stubOrigin();

    const { code } = await run(MINIMAL, { origin });

    expect(code).toBe(0);
  });

  it.each([
    ["a path", "https://origin.internal.example/app"],
    ["a path of two slashes", "https://origin.internal.example//"],
    ["a query", "https://origin.internal.example/?x=1"],
    ["an empty query", "https://origin.internal.example?"],
    ["a fragment", "https://origin.internal.example/#x"],
    ["userinfo", "https://user:pw@origin.internal.example"],
    ["a scheme other than http(s)", "ftp://origin.internal.example"],
    ["a protocol-relative value", "//origin.internal.example"],
    ["a bare host", "origin.internal.example"],
    ["an empty value", ""],
    ["a javascript: URL", "javascript:alert(1)"],
  ])("rejects %s before any request is sent", async (_label, origin) => {
    const { calls } = stubOrigin();

    await expect(run(MINIMAL, { origin })).rejects.toThrow(/--origin/);
    expect(calls).toEqual([]);
  });

  it("parses --origin from the command line", () => {
    expect(parseArgs(["--config=a.toml", "--force", "--origin=https://o.example"])).toEqual({
      configPath: "a.toml",
      force: true,
      origin: "https://o.example",
    });
    expect(parseArgs([])).toEqual({ configPath: "webmcp.toml", force: false, origin: undefined });
  });
});

describe("preflight: User-Agent", () => {
  it("names the package version, on the GET probes and on the MCP POST", async () => {
    const { calls } = stubOrigin();

    await run(MINIMAL);

    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>)["user-agent"], c.url).toBe(`cf-webmcp-preflight/${PKG_VERSION}`);
    }
    expect(calls.some((c) => c.init.method === "POST")).toBe(true);
  });
});

describe("preflight: command-line arguments", () => {
  it("accepts --config and --origin written with a space instead of =", () => {
    expect(parseArgs(["--config", "a.toml", "--origin", "https://o.example", "--force"])).toEqual({
      configPath: "a.toml",
      force: true,
      origin: "https://o.example",
    });
    expect(parseArgs(["--config", "a.toml"])).toEqual({ configPath: "a.toml", force: false, origin: undefined });
  });

  it("accepts the two forms side by side, in any order", () => {
    expect(parseArgs(["--force", "--origin=https://o.example", "--config", "dir/a.toml"])).toEqual({
      configPath: "dir/a.toml",
      force: true,
      origin: "https://o.example",
    });
  });

  it("keeps a value that contains = after the first one", () => {
    expect(parseArgs(["--config=a=b.toml"]).configPath).toBe("a=b.toml");
  });

  it.each([
    ["an unknown flag", ["--bogus"], /unknown argument "--bogus"/],
    ["an unknown flag with a value", ["--bogus=1"], /unknown argument "--bogus=1"/],
    ["a misspelled flag", ["--Origin=https://o.example"], /unknown argument "--Origin=https:\/\/o\.example"/],
    ["a short flag", ["-f"], /unknown argument "-f"/],
    ["--force given a value", ["--force=true"], /unknown argument "--force=true"/],
    ["a positional argument (the config path needs --config)", ["webmcp.toml"], /unknown argument "webmcp\.toml"/],
    ["a bare --origin", ["--origin"], /--origin needs a value/],
    ["a bare --config", ["--config"], /--config needs a value/],
    ["a bare --origin before another flag", ["--origin", "--force"], /--origin needs a value/],
    ["a bare --config before another flag", ["--config", "--origin=https://o.example"], /--config needs a value/],
    ["--origin= with nothing after it", ["--origin="], /--origin needs a value/],
    ["--config= with nothing after it", ["--config="], /--config needs a value/],
    ["--origin given twice", ["--origin=https://a.example", "--origin", "https://b.example"], /--origin was given more than once/],
    ["--config given twice", ["--config=a.toml", "--config=b.toml"], /--config was given more than once/],
    ["--force given twice", ["--force", "--force"], /--force was given more than once/],
  ])("refuses %s", (_label, argv, message) => {
    expect(() => parseArgs(argv)).toThrow(message);
  });

  it("names the accepted arguments in the error", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/--config=<path>.*--origin=<url>.*--force/s);
  });

  it("exits with 2 and prints the error to stderr, nothing to stdout, for a bad argument", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const run = (args: string[]) =>
      spawnSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), "scripts/preflight.ts", ...args], {
        cwd: root,
        encoding: "utf8",
        // No deploy token, and no result written: the run stops before it reads a config.
        env: { ...process.env, CF_WEBMCP_DEPLOY_TOKEN: "" },
        timeout: 60_000,
      });

    for (const args of [["--origin"], ["--config"], ["--bogus"], ["--origin", "https://o.example", "stray.toml"]]) {
      const result = run(args);
      expect(result.status, `exit code for ${args.join(" ")}`).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/--config=<path>/);
    }
  }, 120_000);
});

describe("preflight: the deploy token only goes where the Worker may send it", () => {
  it("refuses a base_url outside allowed_origins with the build's own error, before any request", async () => {
    const { calls } = stubOrigin();
    const offList = MINIMAL.replace('base_url        = "https://example.com"', 'base_url        = "https://origin.example.net"');

    const err = await run(offList, { deployToken: "tok-123" }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^\[build-config\] \[origin\]\.base_url "https:\/\/origin\.example\.net"/);
    expect((err as Error).message).toContain("is not in [origin].allowed_origins");
    expect(calls).toEqual([]);
  });

  it("refuses it with no token set too: the build would refuse the config", async () => {
    const { calls } = stubOrigin();
    const offList = MINIMAL.replace('base_url        = "https://example.com"', 'base_url        = "https://origin.example.net"');

    await expect(run(offList)).rejects.toThrow(/allowed_origins/);
    expect(calls).toEqual([]);
  });

  it.each([
    ["http://origin.example.com", true],
    ["http://localhost:8081", false],
    ["http://127.0.0.1:8081", false],
    ["http://[::1]:8081", false],
    ["http://app.localhost:8081", false],
    ["https://origin.example.com", false],
  ])("base_url %s: a warning about the token in clear text: %s", async (base, warned) => {
    stubOrigin();
    const toml = MINIMAL.replace('base_url        = "https://example.com"', `base_url        = "${base}"`).replace(
      'allowed_origins = ["https://example.com"]',
      `allowed_origins = ["https://example.com", "${base}"]`,
    );

    const { lines } = await run(toml, { deployToken: "tok-123" });

    const warning = lines.filter((l) => l.includes("over plain http"));
    expect(warning.length).toBe(warned ? 1 : 0);
    if (warned) expect(warning[0]).toContain(new URL(base).host);
  });

  it("does not warn about http when no token is sent", async () => {
    stubOrigin();
    const toml = MINIMAL.replace('base_url        = "https://example.com"', 'base_url        = "http://origin.example.com"').replace(
      'allowed_origins = ["https://example.com"]',
      'allowed_origins = ["http://origin.example.com"]',
    );

    const { lines } = await run(toml);

    expect(lines.filter((l) => l.includes("over plain http"))).toEqual([]);
  });
});

describe("preflight: a deploy token the Worker cannot reliably take out of its answers", () => {
  const warningsOf = (lines: string[]) => lines.filter((l) => l.includes("WARNING") && l.includes("CF_WEBMCP_DEPLOY_TOKEN"));

  it.each([
    ["a short word", "secret"],
    ["base64 with / + and =", "Ab3/xY+9kQ==zz-SECRET-0123456789"],
    ["31 characters of the safe set", "a".repeat(31)],
    ["32 characters with a space", "0123456789abcdef 123456789abcdef"],
  ])("warns for %s, without printing the token", async (_label, token) => {
    stubOrigin();
    const { lines } = await run(MINIMAL, { deployToken: token });

    const warnings = warningsOf(lines);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("openssl rand -hex 32");
    expect(lines.join("\n")).not.toContain(token);
  });

  it("names both reasons for a short token with a character outside the safe set", async () => {
    stubOrigin();
    const { lines } = await run(MINIMAL, { deployToken: "secret/1" });

    const [warning] = warningsOf(lines);
    expect(warning).toContain("shorter than 32 characters");
    expect(warning).toContain("A-Z, a-z, 0-9");
  });

  it.each([
    ["64 hex characters", "0123456789abcdef".repeat(4)],
    ["32 characters of letters, digits, _ and -", "Ab3_xY-9kQzz-SECRET_0123456789ab"],
    ["no token", ""],
  ])("is quiet for %s", async (_label, token) => {
    stubOrigin();
    const { lines } = await run(MINIMAL, { deployToken: token });

    expect(warningsOf(lines)).toEqual([]);
  });

  it("warns for a token that is withheld too: it is the same secret the Worker sends", async () => {
    stubOrigin();
    const { lines } = await run(MINIMAL, { deployToken: "secret", origin: "https://origin.example.net" });

    expect(lines.join("\n")).toContain("token: withheld");
    expect(warningsOf(lines)).toHaveLength(1);
  });
});

describe("probeUrl: a probe never leaves the host it was aimed at", () => {
  const base = new URL("https://origin.example");

  it("resolves an ordinary path on the base", () => {
    expect(probeUrl(base, "/mcp/").href).toBe("https://origin.example/mcp/");
    expect(probeUrl(new URL("http://localhost:8080"), "/llms.txt").href).toBe("http://localhost:8080/llms.txt");
  });

  it.each(["//evil.example/mcp/", "/\\evil.example/", "https://evil.example/x", "///evil.example"])(
    "refuses %s, because the deploy token goes out with the request",
    (p) => {
      expect(() => probeUrl(base, p)).toThrow(/not https:\/\/origin\.example/);
    },
  );
});
