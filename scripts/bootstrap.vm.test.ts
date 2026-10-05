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

/** The key the bootstrap stores its page-wide registry under. */
const REGISTRY_KEY = "__cfWebmcpRegistered";

type GetToolsBehaviour =
  | "absent"
  | "resolve"
  | "sync-array"
  | "throw"
  | "getter-throws"
  | "reject"
  | "never"
  | "live-snapshot"
  | "resolve-null"
  | "resolve-object"
  | "resolve-malformed"
  | "custom";

interface Options {
  /** How document.modelContext.getTools behaves (default: it does not exist). */
  getTools?: GetToolsBehaviour;
  /** The tool names getTools reports (default ["search_pages"]). */
  reported?: string[];
  /** The raw entries "resolve" and "sync-array" answer with, instead of {name} objects for `reported`. */
  entries?: unknown[];
  /** What getTools does for "custom". */
  getToolsImpl?: () => unknown;
  /** Names of [toolname] elements on the page. */
  stamped?: string[];
  /** registerTool returns a rejected promise for these names. */
  rejectRegister?: string[];
  /** registerTool throws synchronously for these names. */
  throwRegister?: string[];
  /** A Cloudflare WebMCP Labs bridge script is on the page. */
  bridge?: boolean;
  /** The src attribute of every <script> element on the page. */
  scripts?: string[];
  /** document.querySelector throws. */
  querySelectorThrows?: boolean;
  /** Which host objects carry modelContext (default "document"). */
  host?: "document" | "navigator" | "both" | "none";
  /** What fetch answers with. */
  fetchImpl?: (url: string, init: Record<string, unknown>) => Promise<unknown>;
  /** The page's `location`; left out of the global when undefined. */
  location?: { origin: string; protocol: string; host: string };
  /** Make the places the page-wide registry would live unusable, one more step each. */
  lockdown?: "ctx-sealed" | "ctx-define-throws" | "ctx-key-taken" | "ctx-and-document-sealed";
  /**
   * Provide setTimeout and clearTimeout, as fakes the test fires by hand (default true).
   * "throw" provides setTimeout and clearTimeout functions that throw when called.
   */
  timers?: boolean | "throw";
  /**
   * A registry the page set before the script ran, under the registry key, on the host object
   * (and, for "string-on-both", on document too), as a non-configurable property the script
   * cannot replace:
   * - "getter-throws": an object whose read of one name (list_posts) throws;
   * - "proxy-throws": a Proxy that throws on every get and set;
   * - "frozen": a frozen empty object;
   * - "setter-drops": a Proxy that reports success for a write and keeps nothing;
   * - "string-on-both": a string, which is no registry, on the host object and on document.
   */
  preset?: "getter-throws" | "proxy-throws" | "frozen" | "setter-drops" | "string-on-both";
  /** console.warn and console.info throw. */
  consoleThrows?: boolean;
}

type Preset = NonNullable<Options["preset"]>;

function presetValue(kind: Preset): unknown {
  switch (kind) {
    case "getter-throws": {
      const registry = Object.create(null) as Record<string, unknown>;
      Object.defineProperty(registry, "list_posts", {
        enumerable: true,
        configurable: true,
        get() {
          throw new Error("hostile getter");
        },
      });
      return registry;
    }
    case "proxy-throws":
      return new Proxy(
        {},
        {
          get() {
            throw new Error("hostile get");
          },
          set() {
            throw new Error("hostile set");
          },
        },
      );
    case "frozen":
      return Object.freeze({});
    case "setter-drops":
      return new Proxy({}, { set: () => true });
    case "string-on-both":
      return "blocked by the page";
  }
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

interface Timer {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
  fired: boolean;
}

interface Run {
  registerCalls: RegisterCall[];
  /** Every name registerTool was given, in order. */
  registeredNames: string[];
  /** Names registerTool was given a second time: in a real browser, a dead renderer. */
  duplicates: string[];
  warns: unknown[][];
  infos: unknown[][];
  selectors: string[];
  fetchCalls: Array<{ url: string; init: Record<string, unknown> }>;
  getToolsCalls: number;
  /** Resolvers of the promises a "never" getTools handed out. */
  settleGetTools: Array<(value: unknown) => void>;
  timers: Timer[];
  /** Run every timer that has neither fired nor been cleared. */
  fireTimers(): void;
}

/** One page: a vm context with the fake browser objects, into which a script can be run any number of times. */
interface Page {
  run: Run;
  context: Record<string, unknown>;
  document: Record<string, unknown>;
  /** The object document.modelContext points at, or null when the page has none. */
  modelContext: Record<string, unknown> | null;
  runScript(js: string): void;
}

function createPage(o: Options = {}): Page {
  const context = vm.createContext({});
  // Promises made in the page's own realm, as a browser's are.
  const P = vm.runInContext("Promise", context) as PromiseConstructor;
  const run: Run = {
    registerCalls: [],
    registeredNames: [],
    duplicates: [],
    warns: [],
    infos: [],
    selectors: [],
    fetchCalls: [],
    getToolsCalls: 0,
    settleGetTools: [],
    timers: [],
    fireTimers() {
      for (const t of run.timers) {
        if (t.cleared || t.fired) continue;
        t.fired = true;
        t.fn();
      }
    },
  };
  const rejectRegister = o.rejectRegister ?? [];
  const throwRegister = o.throwRegister ?? [];
  const reported = o.reported ?? ["search_pages"];
  const entries = (): unknown[] => o.entries ?? reported.map((name) => ({ name }));

  const makeContext = (via: "document" | "navigator"): Record<string, unknown> => {
    const mc: Record<string, unknown> = {
      registerTool(def: RegisterCall["def"], opts?: RegisterCall["opts"]) {
        run.registerCalls.push({ def, opts, via });
        if (run.registeredNames.includes(def.name)) run.duplicates.push(def.name);
        run.registeredNames.push(def.name);
        if (throwRegister.includes(def.name)) throw new Error("sync boom");
        return rejectRegister.includes(def.name) ? P.reject(new Error("async boom")) : P.resolve(undefined);
      },
    };
    const behaviour = o.getTools ?? "absent";
    if (behaviour === "getter-throws") {
      Object.defineProperty(mc, "getTools", {
        enumerable: true,
        configurable: true,
        get() {
          run.getToolsCalls++;
          throw new Error("getTools getter boom");
        },
      });
    } else if (behaviour !== "absent") {
      mc["getTools"] = () => {
        run.getToolsCalls++;
        switch (behaviour) {
          case "resolve":
            return P.resolve(entries());
          case "sync-array":
            return entries();
          case "throw":
            throw new Error("getTools boom");
          case "reject":
            return P.reject(new Error("getTools rejected"));
          case "never":
            return new P((resolve) => void run.settleGetTools.push(resolve));
          case "live-snapshot":
            return P.resolve(run.registeredNames.map((name) => ({ name })));
          case "resolve-null":
            return P.resolve(null);
          case "resolve-object":
            return P.resolve({ nope: true });
          case "resolve-malformed":
            return P.resolve([null, 7, {}, { name: 5 }, { name: "" }, { name: "search_pages" }]);
          case "custom":
            return o.getToolsImpl!();
        }
        return undefined;
      };
    }
    return mc;
  };

  const host = o.host ?? "document";
  const scripts = [...(o.scripts ?? []), ...(o.bridge ? ["/.webmcp/bridge.js"] : [])];
  const doc: Record<string, unknown> = {
    querySelectorAll(selector: string) {
      run.selectors.push(selector);
      if (selector !== "[toolname]") return [];
      return (o.stamped ?? []).map((name) => ({
        getAttribute: (attr: string) => (attr === "toolname" ? name : null),
      }));
    },
    // Understands script[src="x"], script[src^="x"], script[src$="x"] and script[src*="x"].
    querySelector(selector: string) {
      run.selectors.push(selector);
      if (o.querySelectorThrows) throw new Error("querySelector boom");
      const m = /^script\[src([*$^]?)="(.*)"\]$/.exec(selector);
      if (!m) return null;
      const op = m[1];
      const needle = m[2]!;
      const hit = scripts.find((src) =>
        op === "*" ? src.includes(needle) : op === "$" ? src.endsWith(needle) : op === "^" ? src.startsWith(needle) : src === needle,
      );
      return hit === undefined ? null : { tagName: "SCRIPT", src: hit };
    },
  };

  let modelContext: Record<string, unknown> | null = null;
  if (host === "document" || host === "both") {
    const mc = makeContext("document");
    if (o.lockdown === "ctx-sealed" || o.lockdown === "ctx-and-document-sealed") Object.preventExtensions(mc);
    if (o.lockdown === "ctx-key-taken") {
      Object.defineProperty(mc, REGISTRY_KEY, { value: "taken", enumerable: false, configurable: false, writable: false });
    }
    if (o.preset !== undefined) {
      Object.defineProperty(mc, REGISTRY_KEY, {
        value: presetValue(o.preset),
        enumerable: false,
        configurable: false,
        writable: false,
      });
      if (o.preset === "string-on-both") {
        Object.defineProperty(doc, REGISTRY_KEY, {
          value: presetValue(o.preset),
          enumerable: false,
          configurable: false,
          writable: false,
        });
      }
    }
    modelContext = mc;
    doc["modelContext"] =
      o.lockdown === "ctx-define-throws"
        ? new Proxy(mc, {
            defineProperty() {
              throw new Error("defineProperty refused");
            },
          })
        : mc;
    if (o.lockdown === "ctx-and-document-sealed") Object.preventExtensions(doc);
  }
  const nav: Record<string, unknown> = {};
  if (host === "navigator" || host === "both") {
    const mc = makeContext("navigator");
    if (host === "navigator") modelContext = mc;
    nav["modelContext"] = mc;
  }

  const fetchImpl =
    o.fetchImpl ??
    (() => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { hello: "world" } }) }));

  Object.assign(context, {
    document: doc,
    navigator: nav,
    console: {
      warn: (...args: unknown[]) => {
        if (o.consoleThrows) throw new Error("console.warn refused");
        run.warns.push(args);
      },
      info: (...args: unknown[]) => {
        if (o.consoleThrows) throw new Error("console.info refused");
        run.infos.push(args);
      },
    },
    fetch: (url: string, init: Record<string, unknown>) => {
      run.fetchCalls.push({ url, init });
      return fetchImpl(url, init);
    },
    AbortController,
  });
  if (o.location !== undefined) context["location"] = o.location;
  if (o.timers === "throw") {
    context["setTimeout"] = (): number => {
      throw new Error("setTimeout refused");
    };
    context["clearTimeout"] = (): void => {
      throw new Error("clearTimeout refused");
    };
  } else if (o.timers !== false) {
    context["setTimeout"] = (fn: () => void, ms: number): number => {
      const t: Timer = { id: run.timers.length + 1, fn, ms, cleared: false, fired: false };
      run.timers.push(t);
      return t.id;
    };
    context["clearTimeout"] = (id: number): void => {
      const t = run.timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    };
  }
  return {
    run,
    context,
    document: doc,
    modelContext,
    runScript: (js: string) => void vm.runInContext(js, context, { filename: "bootstrap.js" }),
  };
}

function runBootstrap(js: string, o: Options = {}): Run {
  const page = createPage(o);
  page.runScript(js);
  return page.run;
}

/** The bootstrap with its TOOLS list edited, to stand in for a different build. */
function withTools(js: string, edit: (tools: Array<Record<string, unknown>>) => Array<Record<string, unknown>>): string {
  const edited = js.replace(
    /var TOOLS = (\[.*\]);/,
    (_m, json: string) => `var TOOLS = ${JSON.stringify(edit(JSON.parse(json) as Array<Record<string, unknown>>))};`,
  );
  expect(edited).not.toBe(js);
  return edited;
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
    expect(run.duplicates).toEqual([]);
  });

  it("falls back to the [toolname] set when reading getTools throws (a getter on the host object)", async () => {
    const run = runBootstrap(bootstrap, { getTools: "getter-throws", stamped: ["get_page"] });
    await flush();
    expect(names(run)).toEqual(["search_pages", "list_posts"]);
    expect(run.warns).toHaveLength(0);
  });

  it("counts the entries it can read when one entry throws on access, instead of dropping the whole list", async () => {
    const bad = {
      get name(): string {
        throw new Error("bad entry");
      },
    };
    const run = runBootstrap(bootstrap, { getTools: "resolve", entries: [bad, { name: "search_pages" }, bad, "get_page"] });
    await flush();
    expect(names(run)).toEqual(["list_posts"]);
    expect(run.warns).toHaveLength(0);
  });

  it("accepts entries that are plain name strings", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve", entries: ["search_pages", "list_posts"] });
    await flush();
    expect(names(run)).toEqual(["get_page"]);
  });

  it("accepts a mix of string and object entries, and ignores empty strings", async () => {
    const run = runBootstrap(bootstrap, { getTools: "sync-array", entries: ["", "list_posts", { name: "get_page" }, null] });
    await flush();
    expect(names(run)).toEqual(["search_pages"]);
  });
});

describe("generated bootstrap in a vm: a getTools() that never settles", () => {
  it("names the timeout as a constant of 1500 ms", () => {
    expect(bootstrap).toContain("GETTOOLS_TIMEOUT_MS = 1500");
  });

  it("registers against the [toolname] set once the timeout passes", async () => {
    const run = runBootstrap(bootstrap, { getTools: "never", stamped: ["get_page"] });
    await flush();
    expect(run.registerCalls).toHaveLength(0);
    expect(run.timers.map((t) => t.ms)).toEqual([1500]);

    run.fireTimers();
    expect(names(run)).toEqual(["search_pages", "list_posts"]);
    expect(run.duplicates).toEqual([]);
  });

  it("does not register a second time when getTools() settles after the timeout", async () => {
    const run = runBootstrap(bootstrap, { getTools: "never" });
    await flush();
    run.fireTimers();
    expect(names(run)).toEqual(["search_pages", "list_posts", "get_page"]);

    run.settleGetTools[0]!([{ name: "search_pages" }]);
    await flush();
    expect(names(run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(run.duplicates).toEqual([]);
  });

  it("stops the timer when getTools() settles in time, and a timer that fires anyway changes nothing", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve" });
    await flush();
    expect(names(run)).toEqual(["list_posts", "get_page"]);
    expect(run.timers).toHaveLength(1);
    expect(run.timers[0]!.cleared).toBe(true);

    // Even a timer the page failed to clear must not register again.
    run.timers[0]!.fn();
    expect(names(run)).toEqual(["list_posts", "get_page"]);
  });

  it("stops the timer when getTools() rejects", async () => {
    const run = runBootstrap(bootstrap, { getTools: "reject" });
    await flush();
    expect(names(run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(run.timers[0]!.cleared).toBe(true);
  });

  it("starts no timer when there is no getTools, or it throws", async () => {
    expect(runBootstrap(bootstrap, { getTools: "absent" }).timers).toHaveLength(0);
    expect(runBootstrap(bootstrap, { getTools: "throw" }).timers).toHaveLength(0);
    expect(runBootstrap(bootstrap, { getTools: "getter-throws" }).timers).toHaveLength(0);
  });

  it("still works on a page without setTimeout: it waits for getTools()", async () => {
    const run = runBootstrap(bootstrap, { getTools: "resolve", timers: false });
    await flush();
    expect(names(run)).toEqual(["list_posts", "get_page"]);
    const waiting = runBootstrap(bootstrap, { getTools: "never", timers: false });
    await flush();
    expect(waiting.registerCalls).toHaveLength(0);
  });
});

describe("generated bootstrap in a vm: the page-wide registry", () => {
  it("registers each tool once when the script runs twice and there is no getTools", async () => {
    const page = createPage({ getTools: "absent" });
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(page.run.duplicates).toEqual([]);
  });

  it("registers each tool once when the second getTools() snapshot predates the first run's registrations", async () => {
    const page = createPage({ getTools: "live-snapshot" });
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    // Both runs took their snapshot before either registered anything.
    expect(page.run.getToolsCalls).toBe(2);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(page.run.duplicates).toEqual([]);
  });

  it("registers each tool once across a third run that starts after the first two finished", async () => {
    const page = createPage({ getTools: "live-snapshot" });
    page.runScript(bootstrap);
    await flush();
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
  });

  it("never duplicates a name across two different builds whose tool lists overlap", async () => {
    const older = withTools(bootstrap, (tools) => [tools[0]!, tools[1]!]);
    const newer = withTools(bootstrap, (tools) => [tools[1]!, { ...tools[2]!, name: "extra_tool", endpoint: "/_webmcp/exec/extra_tool" }]);

    for (const order of [
      [older, newer],
      [newer, older],
    ]) {
      const page = createPage({ getTools: "live-snapshot" });
      for (const js of order) page.runScript(js);
      await flush();
      expect(new Set(names(page.run)).size).toBe(names(page.run).length);
      expect([...names(page.run)].sort()).toEqual(["extra_tool", "list_posts", "search_pages"]);
      expect(page.run.duplicates).toEqual([]);
    }
  });

  it("keeps the registry on the host object as a non-enumerable property, and every registered name in it", async () => {
    const page = createPage({ getTools: "absent" });
    page.runScript(bootstrap);
    await flush();
    const mc = page.modelContext!;
    const descriptor = Object.getOwnPropertyDescriptor(mc, REGISTRY_KEY);
    expect(descriptor).toBeDefined();
    expect(descriptor!.enumerable).toBe(false);
    expect(Object.keys(mc)).not.toContain(REGISTRY_KEY);
    expect(Object.keys(descriptor!.value as object).sort()).toEqual(["get_page", "list_posts", "search_pages"]);
  });

  it("adds no enumerable global and nothing to the document", async () => {
    const page = createPage({ getTools: "resolve" });
    const globalsBefore = Object.keys(page.context).sort();
    const documentBefore = Object.keys(page.document).sort();
    page.runScript(bootstrap);
    await flush();
    expect(Object.keys(page.context).sort()).toEqual(globalsBefore);
    expect(Object.keys(page.document).sort()).toEqual(documentBefore);
    expect(Object.getOwnPropertyNames(page.document)).not.toContain(REGISTRY_KEY);
  });

  it("falls back to the document when the host object cannot take a property (sealed)", async () => {
    const page = createPage({ getTools: "absent", lockdown: "ctx-sealed" });
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(page.run.duplicates).toEqual([]);
    const descriptor = Object.getOwnPropertyDescriptor(page.document, REGISTRY_KEY);
    expect(descriptor).toBeDefined();
    expect(descriptor!.enumerable).toBe(false);
    expect(Object.getOwnPropertyDescriptor(page.modelContext!, REGISTRY_KEY)).toBeUndefined();
  });

  it("falls back to the document when defineProperty on the host object throws", async () => {
    const page = createPage({ getTools: "absent", lockdown: "ctx-define-throws" });
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(Object.getOwnPropertyDescriptor(page.document, REGISTRY_KEY)).toBeDefined();
  });

  it("falls back to the document when something already holds the key on the host object", async () => {
    const page = createPage({ getTools: "absent", lockdown: "ctx-key-taken" });
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(page.run.warns).toHaveLength(0);
  });

  it("still registers once, without throwing, when neither the host object nor the document can hold a registry", async () => {
    const page = createPage({ getTools: "absent", lockdown: "ctx-and-document-sealed" });
    expect(() => page.runScript(bootstrap)).not.toThrow();
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(page.run.warns).toHaveLength(0);
  });

  it("checks the registry when it registers, so a late getTools() answer that misses a name cannot cause a duplicate", async () => {
    // Run one registers everything. Run two's getTools() answers late with a list that does
    // not mention run one's tools: only the registry stands between it and a duplicate.
    const page = createPage({ getTools: "never" });
    page.runScript(bootstrap);
    page.run.fireTimers();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    page.runScript(bootstrap);
    page.run.settleGetTools[1]!([]);
    await flush();
    expect(page.run.duplicates).toEqual([]);
    expect(page.run.registerCalls).toHaveLength(3);
  });
});

describe("generated bootstrap in a vm: a registry the page set first", () => {
  // A script of the page's own can define the registry key before ours runs, as a property we
  // cannot replace. Whatever it put there, our script must neither throw nor register a name a
  // second time. Where the registry is unusable (it cannot hold a write), the page has in effect
  // told us not to register, and nothing is registered.
  const hostile: Array<[label: string, preset: Preset, registeredByTwoRuns: string[]]> = [
    ["an object with a getter that throws for one name", "getter-throws", ["search_pages", "get_page"]],
    ["a Proxy that throws on get and set", "proxy-throws", []],
    ["a frozen object", "frozen", []],
    ["an object whose setter drops the write", "setter-drops", []],
    ["a non-object on the host object and on document", "string-on-both", []],
  ];

  it.each(hostile)(
    "%s: two runs, nothing thrown, no duplicate, no unhandled rejection",
    async (_label, preset, expected) => {
      const page = createPage({ getTools: "absent", preset });
      const seen = await watchUnhandled(async () => {
        expect(() => page.runScript(bootstrap)).not.toThrow();
        expect(() => page.runScript(bootstrap)).not.toThrow();
        await flush();
      });
      expect(seen).toEqual([]);
      expect(page.run.duplicates).toEqual([]);
      expect(names(page.run)).toEqual(expected);
      expect(page.run.warns).toEqual([]);
    },
  );

  it.each(hostile)(
    "%s: nothing escapes the timer callback when getTools never settles, and a late answer adds nothing",
    async (_label, preset, expected) => {
      const page = createPage({ getTools: "never", preset });
      const seen = await watchUnhandled(async () => {
        expect(() => page.runScript(bootstrap)).not.toThrow();
        expect(() => page.runScript(bootstrap)).not.toThrow();
        expect(() => page.run.fireTimers()).not.toThrow();
        for (const settle of page.run.settleGetTools) settle([]);
        await flush();
      });
      expect(seen).toEqual([]);
      expect(page.run.duplicates).toEqual([]);
      expect(names(page.run)).toEqual(expected);
    },
  );

  it.each(hostile)(
    "%s: nothing escapes the getTools path either, whether it resolves or rejects",
    async (_label, preset, expected) => {
      for (const getTools of ["resolve", "reject", "throw"] as const) {
        const page = createPage({ getTools, preset, reported: [] });
        const seen = await watchUnhandled(async () => {
          expect(() => page.runScript(bootstrap)).not.toThrow();
          expect(() => page.runScript(bootstrap)).not.toThrow();
          await flush();
        });
        expect(seen, getTools).toEqual([]);
        expect(page.run.duplicates, getTools).toEqual([]);
        expect(names(page.run), getTools).toEqual(expected);
      }
    },
  );

  it("uses a registry the page set when it is a plain writable object, and then a second run adds nothing", async () => {
    const page = createPage({ getTools: "absent" });
    const mine = Object.create(null);
    Object.defineProperty(page.modelContext!, REGISTRY_KEY, { value: mine, enumerable: false, configurable: false });
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(Object.keys(mine).sort()).toEqual(["get_page", "list_posts", "search_pages"]);
    expect(page.run.duplicates).toEqual([]);
  });

  it("still registers when only the host object holds a bad value and document is free (falls to the document)", async () => {
    const page = createPage({ getTools: "absent", lockdown: "ctx-key-taken" });
    page.runScript(bootstrap);
    page.runScript(bootstrap);
    await flush();
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
    expect(page.run.duplicates).toEqual([]);
  });

  it("does not let a console that throws stop the registration or escape the script", async () => {
    const page = createPage({ getTools: "absent", consoleThrows: true, throwRegister: ["search_pages"], rejectRegister: ["list_posts"], bridge: true });
    const seen = await watchUnhandled(async () => {
      expect(() => page.runScript(bootstrap)).not.toThrow();
      await flush();
    });
    expect(seen).toEqual([]);
    expect(names(page.run)).toEqual(["search_pages", "list_posts", "get_page"]);
  });

  it("does not let a setTimeout or clearTimeout that throws stop the registration", async () => {
    const resolving = createPage({ getTools: "resolve", timers: "throw" });
    expect(() => resolving.runScript(bootstrap)).not.toThrow();
    await flush();
    expect(names(resolving.run)).toEqual(["list_posts", "get_page"]);

    const rejecting = createPage({ getTools: "reject", timers: "throw" });
    expect(() => rejecting.runScript(bootstrap)).not.toThrow();
    await flush();
    expect(names(rejecting.run)).toEqual(["search_pages", "list_posts", "get_page"]);
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
    expect(run.selectors).toContain('script[src*="/.webmcp/bridge.js"]');
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

  it.each(["/.webmcp/bridge.js?v=1", "https://www.example.com/.webmcp/bridge.js?ver=2&x=y", "/.webmcp/bridge.js#top"])(
    "finds a bridge script whose src has more after the file name (%s)",
    async (src) => {
      const run = runBootstrap(bootstrap, { scripts: ["/app.js", src] });
      await flush();
      expect(run.infos).toHaveLength(1);
    },
  );

  it("does not take another script for the bridge", async () => {
    const run = runBootstrap(bootstrap, { scripts: ["/app.js", "/webmcp/bridge.js", "/.webmcp/other.js"] });
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
  const callGetPage = async (o: Options): Promise<string> => {
    const run = runBootstrap(bootstrap, { getTools: "absent", ...o });
    await flush();
    await run.registerCalls.find((c) => c.def.name === "get_page")!.def.execute({ path: "/about" });
    return run.fetchCalls[0]!.url;
  };

  it.each([
    ["https://www.example.com", "https:", "www.example.com"],
    ["https://my-site.example.workers.dev", "https:", "my-site.example.workers.dev"],
    ["http://localhost:8787", "http:", "localhost:8787"],
  ])("POSTs to the page origin %s, not to the configured domain", async (origin, protocol, host) => {
    expect(await callGetPage({ location: { origin, protocol, host } })).toBe(`${origin}/_webmcp/exec/get_page`);
  });

  it("falls back to the root-relative path under an opaque origin", async () => {
    expect(await callGetPage({ location: { origin: "null", protocol: "about:", host: "" } })).toBe(
      "/_webmcp/exec/get_page",
    );
    expect(await callGetPage({ location: { origin: "null", protocol: "https:", host: "sandboxed.example.com" } })).toBe(
      "/_webmcp/exec/get_page",
    );
  });

  it("falls back to the root-relative path when the page has no usable location", async () => {
    expect(await callGetPage({ location: { origin: "file://", protocol: "file:", host: "" } })).toBe("/_webmcp/exec/get_page");
  });

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

  it("keeps U+2028 and U+2029 from a tool description out of the script as escapes, so a pre-ES2019 engine can parse it", async () => {
    const ls = String.fromCharCode(0x2028);
    const ps = String.fromCharCode(0x2029);
    const description = `before${ls}between${ps}after`;
    const toml = TOML.replace('description = "Search the site."', `description = "${description}"`);
    const tomlPath = path.join(tmpDir, "separators.toml");
    await fs.writeFile(tomlPath, toml);
    const outDir = path.join(tmpDir, "out-separators");
    await buildConfig({ tomlPath, outDir });
    const js = await fs.readFile(path.join(outDir, "bootstrap.js"), "utf8");

    expect(js.includes(ls)).toBe(false);
    expect(js.includes(ps)).toBe(false);
    expect(js).toContain(["\\", "u2028"].join(""));
    expect(js).toContain(["\\", "u2029"].join(""));
    expect(es5Violations(js)).toEqual([]);

    const run = runBootstrap(js, { getTools: "absent" });
    await flush();
    expect(run.registerCalls[0]!.def.description).toBe(description);
  });
});
