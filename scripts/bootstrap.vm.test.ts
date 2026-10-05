import { describe, it, expect, beforeAll, afterAll } from "vitest";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "./build-config";
import { es5Violations } from "../src/test-support/es5";

/**
 * Runs the generated bootstrap in a node `vm` context against a fake `document`,
 * `modelContext`, `fetch` and `AbortController`, to check what it does rather than what
 * its text contains: which tools it registers, in what order relative to `getTools()`,
 * and what it does when the browser API misbehaves.
 */

const TOML = `
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
  type = "object"
  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"

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
  type     = "object"
  required = ["path"]
    [tools.input_schema.properties.path]
    type = "string"
  [tools.executor]
  type         = "dom_extract"
  url_template = "https://example.com{{path}}"
`;

let bootstrap = "";
let tmpDir = "";

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-vm-"));
  const tomlPath = path.join(tmpDir, "vm.toml");
  await fs.writeFile(tomlPath, TOML);
  const outDir = path.join(tmpDir, "out");
  await buildConfig({ tomlPath, outDir });
  bootstrap = await fs.readFile(path.join(outDir, "bootstrap.js"), "utf8");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

type GetToolsBehaviour =
  | "absent"
  | "resolve"
  | "sync-array"
  | "throw"
  | "reject"
  | "resolve-null"
  | "resolve-object"
  | "resolve-malformed";

interface Options {
  /** How document.modelContext.getTools behaves (default: it does not exist). */
  getTools?: GetToolsBehaviour;
  /** The tool names getTools reports (default ["search_pages"]). */
  reported?: string[];
  /** Names of [toolname] elements on the page. */
  stamped?: string[];
  /** registerTool returns a rejected promise for these names. */
  rejectRegister?: string[];
  /** registerTool throws synchronously for these names. */
  throwRegister?: string[];
  /** A Cloudflare WebMCP Labs bridge script is on the page. */
  bridge?: boolean;
  /** document.querySelector throws. */
  querySelectorThrows?: boolean;
  /** Which host objects carry modelContext (default "document"). */
  host?: "document" | "navigator" | "both" | "none";
  /** What fetch answers with. */
  fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<unknown>;
}

interface RegisterCall {
  def: {
    name: string;
    title?: string;
    description: string;
    inputSchema: unknown;
    annotations: Record<string, unknown>;
    execute: (input: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError: boolean }>;
  };
  opts: { signal?: AbortSignal } | undefined;
  via: "document" | "navigator";
}

interface Run {
  registerCalls: RegisterCall[];
  warns: unknown[][];
  infos: unknown[][];
  selectors: string[];
  fetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
  getToolsCalls: number;
}

function runBootstrap(js: string, o: Options = {}): Run {
  const context = vm.createContext({});
  // Promises made in the page's own realm, as a browser's are.
  const P = vm.runInContext("Promise", context) as PromiseConstructor;
  const run: Run = { registerCalls: [], warns: [], infos: [], selectors: [], fetchCalls: [], getToolsCalls: 0 };
  const rejectRegister = o.rejectRegister ?? [];
  const throwRegister = o.throwRegister ?? [];
  const reported = o.reported ?? ["search_pages"];

  const makeContext = (via: "document" | "navigator"): Record<string, unknown> => {
    const mc: Record<string, unknown> = {
      registerTool(def: RegisterCall["def"], opts?: RegisterCall["opts"]) {
        run.registerCalls.push({ def, opts, via });
        if (throwRegister.includes(def.name)) throw new Error("sync boom");
        return rejectRegister.includes(def.name) ? P.reject(new Error("async boom")) : P.resolve(undefined);
      },
    };
    const behaviour = o.getTools ?? "absent";
    if (behaviour !== "absent") {
      mc["getTools"] = () => {
        run.getToolsCalls++;
        switch (behaviour) {
          case "resolve":
            return P.resolve(reported.map((name) => ({ name })));
          case "sync-array":
            return reported.map((name) => ({ name }));
          case "throw":
            throw new Error("getTools boom");
          case "reject":
            return P.reject(new Error("getTools rejected"));
          case "resolve-null":
            return P.resolve(null);
          case "resolve-object":
            return P.resolve({ nope: true });
          case "resolve-malformed":
            return P.resolve([null, 7, {}, { name: 5 }, { name: "" }, { name: "search_pages" }]);
        }
        return undefined;
      };
    }
    return mc;
  };

  const host = o.host ?? "document";
  const doc: Record<string, unknown> = {
    querySelectorAll(selector: string) {
      run.selectors.push(selector);
      if (selector !== "[toolname]") return [];
      return (o.stamped ?? []).map((name) => ({
        getAttribute: (attr: string) => (attr === "toolname" ? name : null),
      }));
    },
    querySelector(selector: string) {
      run.selectors.push(selector);
      if (o.querySelectorThrows) throw new Error("querySelector boom");
      return o.bridge && selector === 'script[src$="/.webmcp/bridge.js"]' ? { tagName: "SCRIPT" } : null;
    },
  };
  if (host === "document" || host === "both") doc["modelContext"] = makeContext("document");
  const nav: Record<string, unknown> = {};
  if (host === "navigator" || host === "both") nav["modelContext"] = makeContext("navigator");

  const fetchImpl =
    o.fetchImpl ??
    (() => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { hello: "world" } }) }));

  Object.assign(context, {
    document: doc,
    navigator: nav,
    console: {
      warn: (...args: unknown[]) => void run.warns.push(args),
      info: (...args: unknown[]) => void run.infos.push(args),
    },
    fetch: (url: string, init: Record<string, unknown>) => {
      run.fetchCalls.push({ url, init });
      return fetchImpl(url, init);
    },
    AbortController,
  });
  vm.runInContext(js, context, { filename: "bootstrap.js" });
  return run;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const names = (run: Run): string[] => run.registerCalls.map((c) => c.def.name);

/** Runs `body` with a process-level watch for unhandled rejections; returns the reasons seen. */
async function watchUnhandled(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    await flush();
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

describe("generated bootstrap in a vm: duplicate avoidance", () => {
  it("waits for getTools(), skips the name it reports, and registers the others once each", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve", reported: ["search_pages"] });
    expect(run.getToolsCalls).toBe(1);
    // Registration waits for the getTools() promise.
    expect(run.registerCalls).toHaveLength(0);

    await flush();
    expect(names(run)).toEqual(["list_posts", "get_page"]);
    expect(run.warns).toHaveLength(0);

    await flush();
    expect(names(run)).toEqual(["list_posts", "get_page"]);
    expect(run.getToolsCalls).toBe(1);
  });

  it("gives every tool its own live AbortSignal as the second argument", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve" });
    await flush();

    expect(run.registerCalls).toHaveLength(2);
    const signals = run.registerCalls.map((c) => c.opts?.signal);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
    }
    expect(new Set(signals).size).toBe(2);
  });

  it("never aborts a signal on its own: holding the controllers must not unregister a tool", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve" });
    await flush();
    // Exercise the paths that run later: a tool call, then a long wait.
    await run.registerCalls[0]!.def.execute({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const c of run.registerCalls) expect(c.opts!.signal!.aborted).toBe(false);
  });

  it("unions the [toolname] elements with the names getTools() reports", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve", reported: ["search_pages"], stamped: ["get_page"] });
    await flush();
    expect(names(run)).toEqual(["list_posts"]);
  });

  it("accepts a getTools() that returns a plain array instead of a promise", async () => {
    const run = runBootstrap(bootstrap, { getTools: "sync-array", reported: ["list_posts"] });
    await flush();
    expect(names(run)).toEqual(["search_pages", "get_page"]);
  });

  it("falls back to the [toolname] set alone when getTools() throws synchronously, and registers once", async () => {
    const run = runBootstrap(bootstrap, { getTools: "throw", stamped: ["get_page"] });
    await flush();
    expect(names(run)).toEqual(["search_pages", "list_posts"]);
    expect(run.getToolsCalls).toBe(1);
  });

  it("falls back to the [toolname] set alone when getTools() rejects, and registers once", async () => {
    const seen = await watchUnhandled(async () => {
      const run = runBootstrap(bootstrap, { getTools: "reject", stamped: ["get_page"] });
      await flush();
      expect(names(run)).toEqual(["search_pages", "list_posts"]);
    });
    expect(seen).toEqual([]);
  });

  it("registers immediately when getTools does not exist", async () => {
    const run = runBootstrap(bootstrap, { getTools: "absent", stamped: ["list_posts"] });
    await Promise.resolve();
    expect(names(run)).toEqual(["search_pages", "get_page"]);
    expect(run.getToolsCalls).toBe(0);
  });

  it.each(["resolve-null", "resolve-object"] as const)(
    "treats a getTools() result that is not an array (%s) as reporting nothing",
    async (getTools) => {
      const run = runBootstrap(bootstrap, { getTools, stamped: ["get_page"] });
      await flush();
      expect(names(run)).toEqual(["search_pages", "list_posts"]);
      expect(run.warns).toHaveLength(0);
    },
  );

  it("ignores entries without a string name and still honours the valid ones", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve-malformed" });
    await flush();
    expect(names(run)).toEqual(["list_posts", "get_page"]);
    expect(run.warns).toHaveLength(0);
  });

  it("registers a name only once even if it is somehow listed twice in its own tool list", async () => {
    // The build refuses duplicate [[tools]] names, so this builds the bootstrap text by hand.
    const doubled = bootstrap.replace(/var TOOLS = (\[.*\]);/, (_m, json: string) => {
      const list = JSON.parse(json) as unknown[];
      return `var TOOLS = ${JSON.stringify([...list, list[0]])};`;
    });
    expect(doubled).not.toBe(bootstrap);
    const run = runBootstrap(doubled, { getTools: "absent" });
    await flush();
    expect(names(run)).toEqual(["search_pages", "list_posts", "get_page"]);
  });
});

describe("generated bootstrap in a vm: host and failures", () => {
  it("registers on document.modelContext and leaves navigator.modelContext alone when both exist", async () => {
    const run = runBootstrap(bootstrap, { host: "both" });
    await flush();
    expect(run.registerCalls.map((c) => c.via)).toEqual(["document", "document", "document"]);
  });

  it("falls back to navigator.modelContext when document has none", async () => {
    const run = runBootstrap(bootstrap, { host: "navigator" });
    await flush();
    expect(run.registerCalls.map((c) => c.via)).toEqual(["navigator", "navigator", "navigator"]);
    // The fallback host gets the same signal argument.
    expect(run.registerCalls[0]!.opts!.signal).toBeInstanceOf(AbortSignal);
  });

  it("does nothing, and does not throw, when the browser has no WebMCP at all", async () => {
    const run = runBootstrap(bootstrap, { host: "none", getTools: "resolve" });
    await flush();
    expect(run.registerCalls).toHaveLength(0);
    expect(run.getToolsCalls).toBe(0);
    expect(run.infos).toHaveLength(0);
  });

  it("warns about a registerTool promise that rejects, keeps registering the rest, and leaves no unhandled rejection", async () => {
    let run!: Run;
    const seen = await watchUnhandled(async () => {
      run = runBootstrap(bootstrap, { getTools: "absent", rejectRegister: ["list_posts"] });
      await flush();
    });
    expect(seen).toEqual([]);
    expect(names(run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(run.warns).toHaveLength(1);
    const [message, name, error] = run.warns[0]!;
    expect(message).toBe("cf-webmcp: failed to register tool");
    expect(name).toBe("list_posts");
    expect((error as Error).message).toBe("async boom");
  });

  it("also survives a rejection on the path that waits for getTools()", async () => {
    let run!: Run;
    const seen = await watchUnhandled(async () => {
      run = runBootstrap(bootstrap, { getTools: "resolve", rejectRegister: ["get_page"] });
      await flush();
    });
    expect(seen).toEqual([]);
    expect(names(run)).toEqual(["list_posts", "get_page"]);
    expect(run.warns.map((w) => w[1])).toEqual(["get_page"]);
  });

  it("warns about a registerTool that throws synchronously and keeps registering the rest", async () => {
    const run = runBootstrap(bootstrap, { getTools: "absent", throwRegister: ["search_pages"] });
    await flush();
    expect(names(run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(run.warns.map((w) => w[1])).toEqual(["search_pages"]);
  });

  it("passes the tool definition with annotations, a title only when set, and an execute function", async () => {
    const run = runBootstrap(bootstrap, { getTools: "absent" });
    await flush();
    const search = run.registerCalls[0]!.def;
    expect(search.name).toBe("search_pages");
    expect(search.description).toBe("Search the site.");
    expect(search.annotations).toEqual({ readOnlyHint: true, untrustedContentHint: false, consequentialHint: false });
    expect("title" in search).toBe(false);
    expect(typeof search.execute).toBe("function");
    expect(run.registerCalls[1]!.def.annotations).toEqual({
      readOnlyHint: true,
      untrustedContentHint: true,
      consequentialHint: false,
    });
  });
});

describe("generated bootstrap in a vm: Cloudflare WebMCP Labs", () => {
  it("says so once, at the start, when the Labs bridge script is on the page", async () => {
    const run = runBootstrap(bootstrap, { bridge: true, getTools: "resolve" });
    await flush();
    expect(run.selectors).toContain('script[src$="/.webmcp/bridge.js"]');
    expect(run.infos).toEqual([
      ["cf-webmcp: Cloudflare WebMCP Labs bridge detected; keep tool names distinct from its tools"],
    ]);
    expect(names(run)).toEqual(["list_posts", "get_page"]);
  });

  it("says nothing when the bridge is absent", async () => {
    const run = runBootstrap(bootstrap, { bridge: false });
    await flush();
    expect(run.infos).toEqual([]);
  });

  it("does not let a failing document.querySelector stop the registration", async () => {
    const run = runBootstrap(bootstrap, { querySelectorThrows: true });
    await flush();
    expect(names(run)).toEqual(["search_pages", "list_posts", "get_page"]);
  });
});

describe("generated bootstrap in a vm: calling a registered tool", () => {
  it("POSTs to the root-relative exec endpoint and returns the tool-result shape", async () => {
    const run = runBootstrap(bootstrap, { getTools: "absent" });
    await flush();
    const getPage = run.registerCalls.find((c) => c.def.name === "get_page")!.def;

    const result = await getPage.execute({ path: "/about" });

    expect(run.fetchCalls).toHaveLength(1);
    const call = run.fetchCalls[0]!;
    expect(call.url).toBe("/_webmcp/exec/get_page");
    expect(call.init["method"]).toBe("POST");
    expect(call.init["credentials"]).toBe("omit");
    expect(JSON.parse(call.init["body"] as string)).toEqual({ path: "/about" });
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      content: [{ type: "text", text: JSON.stringify({ ok: true, data: { hello: "world" } }) }],
      isError: false,
    });
  });

  it("reports isError for an executor error envelope and for a failed fetch", async () => {
    const failing = runBootstrap(bootstrap, {
      fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: { code: "not_found" } }) }),
    });
    await flush();
    const r1 = await failing.registerCalls[0]!.def.execute({});
    expect(r1.isError).toBe(true);

    const offline = runBootstrap(bootstrap, { fetchImpl: () => Promise.reject(new Error("network down")) });
    await flush();
    const r2 = await offline.registerCalls[0]!.def.execute({});
    expect(r2.isError).toBe(true);
    expect(JSON.parse(r2.content[0]!.text)).toMatchObject({ ok: false, error: { code: "internal", retriable: true } });
  });
});

describe("generated bootstrap: syntax", () => {
  it("is valid ES5: no arrow functions, let/const, template literals, spread or async", () => {
    expect(es5Violations(bootstrap)).toEqual([]);
  });

  it("the ES5 check does catch the syntax it is meant to catch", () => {
    const modern = [
      "const a = () => 1;",
      "let b = `x${a()}`;",
      "foo(...[1, 2]);",
      "async function f() { await g(); }",
      "class C {}",
      "var { d } = o;",
      "var e = { b };",
      "var f2 = a?.b ?? 1;",
    ].join("\n");
    const found = es5Violations(modern).join("\n");
    for (const needle of [
      "arrow function",
      "let or const",
      "template literal",
      "spread",
      "await",
      "class",
      "destructuring",
      "shorthand property",
      "optional chaining",
      "nullish coalescing",
    ]) {
      expect(found, needle).toContain(needle);
    }
    expect(es5Violations("var x = function (a) { return a ? [a] : {}; };")).toEqual([]);
  });
});
