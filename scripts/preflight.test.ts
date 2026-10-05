import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
      "/.well-known/ard.json: origin's JSON is not an ARD manifest (an object with an entries array of objects with a string identifier); the Worker relays it unchanged and adds no entry",
    ]);
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

  it("sends the deploy token headers to the override host only", async () => {
    const { calls } = stubOrigin();

    await run(MINIMAL, { origin: OVERRIDE, deployToken: "tok-123" });

    for (const { url, init } of calls) {
      expect(new URL(url).host, url).toBe("origin.internal.example");
      const headers = init.headers as Record<string, string>;
      expect(headers["cf-webmcp-deploy-token"], url).toBe("tok-123");
      expect(headers["cf-webmcp-bypass"], url).toBe("1");
    }
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
