import { describe, it, expect, beforeAll, afterAll } from "vitest";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfig } from "./build-config";
import { LICENSE_PREAMBLE } from "../src/widget-preamble";
import { es5Violations, inlineScripts } from "../src/test-support/es5";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runs the default landing page's inline script in a vm against a small fake DOM and a fake
 * `document.modelContext`. The state branching (Connected / Pairing required / Not
 * connected) and the diagnostic list are what a visitor sees, so they are checked by running
 * the script rather than by reading its text.
 */

const BASE_TOML = `
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
`;

/** The widget is opt-in, so the "widget on" landing switches it on. */
const TOML = `${BASE_TOML}\n[features]\nfallback_widget = true\n`;
const WIDGET_OFF = `${BASE_TOML}\n[features]\nfallback_widget = false\n`;

/** A tool whose description tries to end the inline script, plus a second tool with a schema. */
const HOSTILE_DESCRIPTION = "</script><script>alert(1)</script> <!--<script>";
const TWO_TOOLS = `${TOML}
[[tools]]
name        = "list_pages"
description = ${JSON.stringify(HOSTILE_DESCRIPTION)}
  [tools.input_schema]
  type     = "object"
  required = ["q"]
    [tools.input_schema.properties.q]
    type = "string"
  [tools.executor]
  type        = "sitemap_filter"
  sitemap_url = "https://example.com/sitemap.xml"

[paths]
namespace = "/_agents"
`;

/** The widget pin the build reads: a fake one, so these tests do not depend on vendor/webmcp/current.json. */
function fakePin(): Record<string, unknown> {
  const raw = Buffer.from("widget A", "utf8");
  const composed = Buffer.concat([Buffer.from(LICENSE_PREAMBLE, "utf8"), raw]);
  return {
    version: "v0.1.13",
    sha256: createHash("sha256").update(raw).digest("hex"),
    served_sha256: createHash("sha256").update(composed).digest("hex"),
    served_sri: `sha384-${createHash("sha384").update(composed).digest("base64")}`,
    preamble_sha256: createHash("sha256").update(LICENSE_PREAMBLE, "utf8").digest("hex"),
  };
}

let tmpDir = "";
let pinPath = "";
let landingWidgetOn = "";
let landingWidgetOff = "";
let landingTwoTools = "";

async function buildLanding(name: string, toml: string): Promise<string> {
  const tomlPath = path.join(tmpDir, `${name}.toml`);
  await fs.writeFile(tomlPath, toml);
  const outDir = path.join(tmpDir, `out-${name}`);
  await buildConfig({ tomlPath, outDir, widgetPinPath: pinPath });
  return fs.readFile(path.join(outDir, "landing.html"), "utf8");
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-landing-"));
  pinPath = path.join(tmpDir, "pin.json");
  await fs.writeFile(pinPath, JSON.stringify(fakePin(), null, 2) + "\n");
  landingWidgetOn = await buildLanding("on", TOML);
  landingWidgetOff = await buildLanding("off", WIDGET_OFF);
  landingTwoTools = await buildLanding("two", TWO_TOOLS);
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

class FakeNode {
  children: FakeNode[] = [];
  classes = new Set<string>();
  private text = "";
  constructor(readonly tag: string) {}
  classList = { add: (c: string): void => void this.classes.add(c) };
  appendChild(child: FakeNode): FakeNode {
    this.children.push(child);
    return child;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get innerHTML(): string {
    return "";
  }
  set innerHTML(value: string) {
    // Clearing is harmless; anything else would put a tool name through the HTML parser.
    if (value !== "") throw new Error(`innerHTML was assigned: ${value}`);
    this.text = "";
    this.children = [];
  }
}

interface ModelContextOptions {
  registerTool?: boolean;
  /** "absent" leaves the member out, "throw" and "reject" make it fail. */
  getTools?: "absent" | "list" | "throw" | "reject" | "custom";
  /** What getTools does for "custom". */
  getToolsImpl?: () => unknown;
  /** Raw entries "list" answers with, instead of {name} objects for `names`. */
  entries?: unknown[];
  executeTool?: boolean;
  ontoolchange?: boolean;
  names?: string[];
}

interface Page {
  active(): string[];
  diag(): string[];
  loadHandlers: Array<() => void>;
  toolchangeHandlers: Array<() => void>;
}

function makeModelContext(o: ModelContextOptions, page: Pick<Page, "toolchangeHandlers">): Record<string, unknown> {
  const mc: Record<string, unknown> = {};
  if (o.registerTool !== false) mc["registerTool"] = () => undefined;
  const getTools = o.getTools ?? "list";
  if (getTools === "list") {
    mc["getTools"] = () => Promise.resolve(o.entries ?? (o.names ?? []).map((name) => ({ name })));
  }
  if (getTools === "custom") mc["getTools"] = () => o.getToolsImpl!();
  if (getTools === "throw") {
    mc["getTools"] = () => {
      throw new Error("getTools boom");
    };
  }
  if (getTools === "reject") mc["getTools"] = () => Promise.reject(new Error("getTools rejected"));
  if (o.executeTool !== false) mc["executeTool"] = () => Promise.resolve("");
  if (o.ontoolchange !== false) mc["ontoolchange"] = null;
  mc["addEventListener"] = (type: string, fn: () => void) => {
    if (type === "toolchange") page.toolchangeHandlers.push(fn);
  };
  return mc;
}

interface RunOptions {
  /** document.modelContext: an object spec, null for a property that exists but is null, undefined for none. */
  document?: ModelContextOptions | null;
  navigator?: ModelContextOptions;
  readyState?: string;
}

function runLanding(landing: string, o: RunOptions = {}): Page {
  const script = inlineScripts(landing).find((s) => s.includes("webmcp-diag"));
  if (!script) throw new Error("the landing has no state script");

  const nodes: Record<string, FakeNode> = {};
  for (const id of ["state-native", "state-pair", "state-disabled", "webmcp-diag"]) nodes[id] = new FakeNode(id);
  const page: Page = {
    active: () =>
      ["state-native", "state-pair", "state-disabled"].filter((id) => nodes[id]!.classes.has("active")),
    diag: () => nodes["webmcp-diag"]!.children.map((li) => li.textContent),
    loadHandlers: [],
    toolchangeHandlers: [],
  };

  const doc: Record<string, unknown> = {
    readyState: o.readyState ?? "loading",
    getElementById: (id: string) => nodes[id] ?? null,
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (text: string) => {
      const n = new FakeNode("#text");
      n.textContent = text;
      return n;
    },
  };
  if (o.document === null) doc["modelContext"] = null;
  else if (o.document !== undefined) doc["modelContext"] = makeModelContext(o.document, page);

  const nav: Record<string, unknown> = {};
  if (o.navigator !== undefined) nav["modelContext"] = makeModelContext(o.navigator, page);

  const context = vm.createContext({
    document: doc,
    navigator: nav,
    window: {
      addEventListener: (type: string, fn: () => void) => {
        if (type === "load") page.loadHandlers.push(fn);
      },
    },
  });
  vm.runInContext(script, context, { filename: "landing-inline.js" });
  return page;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const diagLine = (page: Page, key: string): string | undefined => page.diag().find((l) => l.startsWith(`${key}:`));

describe("landing page script: state branching", () => {
  it("shows Connected when document.modelContext can register tools", () => {
    const page = runLanding(landingWidgetOn, { document: {} });
    expect(page.active()).toEqual(["state-native"]);
    expect(page.diag().at(-1)).toBe("Selected state: state-native");
  });

  it("shows Connected through the deprecated navigator alias when document has none", () => {
    const page = runLanding(landingWidgetOn, { navigator: {} });
    expect(page.active()).toEqual(["state-native"]);
    expect(diagLine(page, "document.modelContext")).toBe("document.modelContext: false");
    expect(diagLine(page, "navigator.modelContext (deprecated alias)")).toBe(
      "navigator.modelContext (deprecated alias): true",
    );
  });

  it("shows pairing when there is no WebMCP and the widget is on", () => {
    expect(runLanding(landingWidgetOn).active()).toEqual(["state-pair"]);
  });

  it("shows Not connected when there is no WebMCP and the widget is off", () => {
    expect(runLanding(landingWidgetOff).active()).toEqual(["state-disabled"]);
  });

  it("does not throw on a document.modelContext that exists but is null, and is not Connected", () => {
    const page = runLanding(landingWidgetOn, { document: null });
    expect(page.active()).toEqual(["state-pair"]);
    expect(diagLine(page, "document.modelContext")).toBe("document.modelContext: true");
  });

  it("is not Connected when modelContext has no registerTool", () => {
    expect(runLanding(landingWidgetOff, { document: { registerTool: false } }).active()).toEqual(["state-disabled"]);
  });
});

describe("landing page script: diagnostic", () => {
  it("reports document.modelContext, getTools, executeTool and ontoolchange", () => {
    const page = runLanding(landingWidgetOn, { document: {} });
    expect(diagLine(page, "document.modelContext")).toBe("document.modelContext: true");
    expect(diagLine(page, "selected host")).toBe("selected host: document.modelContext");
    expect(diagLine(page, "typeof registerTool on the selected host")).toBe(
      "typeof registerTool on the selected host: function",
    );
    expect(diagLine(page, "typeof document.modelContext.getTools")).toBe("typeof document.modelContext.getTools: function");
    expect(diagLine(page, "typeof document.modelContext.executeTool")).toBe(
      "typeof document.modelContext.executeTool: function",
    );
    expect(diagLine(page, "'ontoolchange' in document.modelContext")).toBe("'ontoolchange' in document.modelContext: true");
    expect(diagLine(page, "fallback widget configured")).toBe("fallback widget configured: true");
  });

  it("reports the members a build lacks as undefined, not as an error", () => {
    const page = runLanding(landingWidgetOn, { document: { getTools: "absent", executeTool: false, ontoolchange: false } });
    expect(diagLine(page, "typeof document.modelContext.getTools")).toBe("typeof document.modelContext.getTools: undefined");
    expect(diagLine(page, "typeof document.modelContext.executeTool")).toBe(
      "typeof document.modelContext.executeTool: undefined",
    );
    expect(diagLine(page, "'ontoolchange' in document.modelContext")).toBe(
      "'ontoolchange' in document.modelContext: false",
    );
    expect(page.active()).toEqual(["state-native"]);
  });

  it("still reports the navigator.modelContextTesting probes", () => {
    const keys = runLanding(landingWidgetOn, { document: {} }).diag().map((l) => l.split(":")[0]);
    expect(keys).toContain("navigator.modelContextTesting");
    expect(keys).toContain("typeof navigator.modelContextTesting.listTools");
    expect(keys).toContain("typeof navigator.modelContextTesting.executeTool");
  });

  it("reports the document probes as absent, without throwing, when there is no document.modelContext", () => {
    const page = runLanding(landingWidgetOn);
    expect(diagLine(page, "typeof document.modelContext.getTools")).toContain("undefined");
    expect(diagLine(page, "'ontoolchange' in document.modelContext")).toContain("n/a");
  });

  it("lists the tool names getTools() reports once the page has loaded, as text", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const page = runLanding(landingWidgetOn, { document: { names: ["search_pages", hostile] } });
    expect(page.loadHandlers).toHaveLength(1);
    page.loadHandlers[0]!();
    await flush();
    // textContent only: the fake node throws if innerHTML is assigned anything but "".
    expect(diagLine(page, "document.modelContext.getTools() names")).toBe(
      `document.modelContext.getTools() names: search_pages, ${hostile}`,
    );
    expect(page.active()).toEqual(["state-native"]);
  });

  it("lists names at once when the page is already loaded, and says when there are none", async () => {
    const page = runLanding(landingWidgetOn, { document: { names: [] }, readyState: "complete" });
    await flush();
    expect(page.loadHandlers).toHaveLength(0);
    expect(diagLine(page, "document.modelContext.getTools() names")).toContain("none");
  });

  it("refreshes the list when the toolchange event fires, in the same list item", async () => {
    const names = ["search_pages"];
    const page = runLanding(landingWidgetOn, { document: { names } });
    page.loadHandlers[0]!();
    await flush();
    const before = page.diag().length;
    names.push("get_page");
    expect(page.toolchangeHandlers.length).toBeGreaterThan(0);
    for (const fn of page.toolchangeHandlers) fn();
    await flush();
    expect(page.diag()).toHaveLength(before);
    expect(diagLine(page, "document.modelContext.getTools() names")).toBe(
      "document.modelContext.getTools() names: search_pages, get_page",
    );
  });

  it.each(["throw", "reject"] as const)("survives a getTools() that does %s and keeps the state", async (getTools) => {
    const page = runLanding(landingWidgetOn, { document: { getTools }, readyState: "complete" });
    await flush();
    expect(page.active()).toEqual(["state-native"]);
    expect(diagLine(page, "document.modelContext.getTools() names")).toMatch(/getTools\(\) (threw|rejected)/);
  });

  it("does not call getTools() on a browser that has no document.modelContext", async () => {
    const page = runLanding(landingWidgetOn, { navigator: { names: ["x"] }, readyState: "complete" });
    await flush();
    expect(diagLine(page, "document.modelContext.getTools() names")).toBeUndefined();
  });

  it("says it could not read the list when an entry throws while it is read, and keeps the state", async () => {
    const bad = {
      get name(): string {
        throw new Error("name getter boom");
      },
    };
    const page = runLanding(landingWidgetOn, { document: { entries: [{ name: "search_pages" }, bad] }, readyState: "complete" });
    await flush();
    expect(page.active()).toEqual(["state-native"]);
    expect(diagLine(page, "document.modelContext.getTools() names")).toBe(
      "document.modelContext.getTools() names: could not read getTools(): name getter boom",
    );
  });

  it("shows only the latest answer when an earlier getTools() call resolves after a later one", async () => {
    const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const page = runLanding(landingWidgetOn, {
      document: {
        getTools: "custom",
        getToolsImpl: () => new Promise((resolve, reject) => void pending.push({ resolve, reject })),
      },
    });
    page.loadHandlers[0]!(); // call 1
    for (const fn of page.toolchangeHandlers) fn(); // call 2
    expect(pending).toHaveLength(2);

    pending[1]!.resolve([{ name: "newer" }]);
    await flush();
    expect(diagLine(page, "document.modelContext.getTools() names")).toBe("document.modelContext.getTools() names: newer");

    pending[0]!.resolve([{ name: "older" }]);
    await flush();
    expect(diagLine(page, "document.modelContext.getTools() names")).toBe("document.modelContext.getTools() names: newer");
  });

  it("does not let an earlier call's failure overwrite a later answer either", async () => {
    const pending: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];
    const page = runLanding(landingWidgetOn, {
      document: {
        getTools: "custom",
        getToolsImpl: () => new Promise((resolve, reject) => void pending.push({ resolve, reject })),
      },
    });
    page.loadHandlers[0]!();
    for (const fn of page.toolchangeHandlers) fn();
    pending[1]!.resolve([{ name: "newer" }]);
    await flush();
    pending[0]!.reject(new Error("too late"));
    await flush();
    expect(diagLine(page, "document.modelContext.getTools() names")).toBe("document.modelContext.getTools() names: newer");
  });

  it("shows a later call's answer over an earlier one that is still waiting", async () => {
    const pending: Array<(v: unknown) => void> = [];
    const page = runLanding(landingWidgetOn, {
      document: { getTools: "custom", getToolsImpl: () => new Promise((resolve) => void pending.push(resolve)) },
    });
    page.loadHandlers[0]!();
    for (const fn of page.toolchangeHandlers) fn();
    pending[0]!([{ name: "first" }]);
    await flush();
    // Call 1 is no longer the latest, so it must not write; call 2 has not answered yet.
    expect(diagLine(page, "document.modelContext.getTools() names")).not.toContain("first");
    pending[1]!([{ name: "second" }]);
    await flush();
    expect(diagLine(page, "document.modelContext.getTools() names")).toBe("document.modelContext.getTools() names: second");
  });
});

describe("landing page script: the diagnostic reports the host the state was chosen from", () => {
  it("document.modelContext without registerTool plus a navigator alias with it: Connected, through navigator", () => {
    const page = runLanding(landingWidgetOn, { document: { registerTool: false }, navigator: {} });
    expect(page.active()).toEqual(["state-native"]);
    expect(diagLine(page, "selected host")).toBe("selected host: navigator.modelContext (deprecated alias)");
    expect(diagLine(page, "typeof registerTool on the selected host")).toBe(
      "typeof registerTool on the selected host: function",
    );
    // The document probes still describe document.modelContext itself.
    expect(diagLine(page, "document.modelContext")).toBe("document.modelContext: true");
  });

  it("the same page with an empty document.modelContext object (no members at all)", () => {
    const page = runLanding(landingWidgetOn, { document: { registerTool: false, getTools: "absent", executeTool: false }, navigator: {} });
    expect(page.active()).toEqual(["state-native"]);
    expect(diagLine(page, "selected host")).toBe("selected host: navigator.modelContext (deprecated alias)");
  });

  it("both hosts usable: document wins, as in the bootstrap", () => {
    const page = runLanding(landingWidgetOn, { document: {}, navigator: {} });
    expect(diagLine(page, "selected host")).toBe("selected host: document.modelContext");
  });

  it("no usable host: says none, and the state is not Connected", () => {
    const page = runLanding(landingWidgetOff, { document: { registerTool: false } });
    expect(page.active()).toEqual(["state-disabled"]);
    expect(diagLine(page, "selected host")).toBe("selected host: none");
    expect(diagLine(page, "typeof registerTool on the selected host")).toContain("undefined");
  });

  it("a diagnostic line never says registerTool is undefined on the host the page is Connected through", () => {
    for (const o of [{ document: {} }, { navigator: {} }, { document: { registerTool: false }, navigator: {} }]) {
      const page = runLanding(landingWidgetOn, o);
      expect(page.active()).toEqual(["state-native"]);
      expect(diagLine(page, "typeof registerTool on the selected host")).toBe(
        "typeof registerTool on the selected host: function",
      );
    }
  });
});

describe("the minimum viable template in docs/customisation.md", () => {
  let minimal = "";
  let landingOn = "";
  let landingOff = "";

  const fenceStart = "`".repeat(3) + "html";

  beforeAll(async () => {
    const md = await fs.readFile(path.join(REPO_ROOT, "docs", "customisation.md"), "utf8");
    const section = md.split(/^## Minimum viable template\s*$/m)[1];
    if (!section) throw new Error("docs/customisation.md has no 'Minimum viable template' section");
    const start = section.indexOf(fenceStart);
    const end = section.indexOf("`".repeat(3), start + fenceStart.length);
    if (start < 0 || end < 0) throw new Error("the minimum viable template has no html code block");
    minimal = section.slice(start + fenceStart.length, end).trim();
    await fs.writeFile(path.join(tmpDir, "minimal.html"), minimal);
    const withTemplate = (toml: string): string => `${toml}\n[webmcp_landing]\ntemplate = "minimal.html"\n`;
    landingOn = await buildLanding("min-on", withTemplate(TOML));
    landingOff = await buildLanding("min-off", withTemplate(WIDGET_OFF));
  });

  interface MinimalNode {
    style: { display: string };
  }

  /** Runs the template's script against fake state divs; returns which ones end up displayed. */
  function shown(landing: string, host: { document?: Record<string, unknown> | null; navigator?: Record<string, unknown> }): string[] {
    const script = inlineScripts(landing).find((s) => s.includes("state-native"));
    if (!script) throw new Error("the minimal template has no state script");
    const nodes: Record<string, MinimalNode> = {};
    for (const id of ["state-native", "state-pair", "state-disabled"]) nodes[id] = { style: { display: "" } };
    const doc: Record<string, unknown> = {
      querySelectorAll: (selector: string) => (selector === ".state" ? Object.values(nodes) : []),
      getElementById: (id: string) => nodes[id] ?? null,
    };
    if (host.document !== undefined) doc["modelContext"] = host.document;
    const context = vm.createContext({ document: doc, navigator: host.navigator ?? {} });
    vm.runInContext(script, context, { filename: "minimal-inline.js" });
    return Object.entries(nodes)
      .filter(([, n]) => n.style.display === "block")
      .map(([id]) => id);
  }

  const withRegisterTool = { registerTool: () => undefined };

  it("gives every state div the class the hide logic looks for", () => {
    for (const id of ["state-native", "state-pair", "state-disabled"]) {
      expect(minimal, id).toMatch(new RegExp(`<div id="${id}" class="state">`));
    }
  });

  it("loads the bootstrap once", () => {
    expect(minimal.split("{{bootstrap_block}}")).toHaveLength(2);
  });

  it("is ES5, in the template and in the built page", () => {
    for (const landing of [landingOn, landingOff]) {
      const scripts = inlineScripts(landing);
      expect(scripts.length).toBeGreaterThan(0);
      for (const s of scripts) expect(es5Violations(s)).toEqual([]);
    }
  });

  it("shows exactly one state, chosen the way the bootstrap chooses its host", () => {
    expect(shown(landingOn, { document: withRegisterTool })).toEqual(["state-native"]);
    expect(shown(landingOn, { navigator: { modelContext: withRegisterTool } })).toEqual(["state-native"]);
    // document.modelContext exists but cannot register: the bootstrap falls back to the navigator alias, so the page does too.
    expect(shown(landingOn, { document: {}, navigator: { modelContext: withRegisterTool } })).toEqual(["state-native"]);
    expect(shown(landingOn, { document: null, navigator: { modelContext: withRegisterTool } })).toEqual(["state-native"]);
    expect(shown(landingOn, {})).toEqual(["state-pair"]);
    expect(shown(landingOn, { document: {} })).toEqual(["state-pair"]);
    expect(shown(landingOff, {})).toEqual(["state-disabled"]);
    expect(shown(landingOff, { document: null })).toEqual(["state-disabled"]);
  });
});

/**
 * Runs the landing's widget init script in a vm with a fake WebMCP class (the vendored widget's
 * API: `new WebMCP(options)`, `registerTool(name, description, inputSchema, execute)`) and a
 * fake fetch. The execute function's return value is what the bridge receives as the tool
 * result: the bridge passes it through unchanged as the MCP CallToolResult.
 */
describe("the fallback widget init script", () => {
  interface Registered {
    name: string;
    description: string;
    schema: unknown;
    execute: (input?: unknown) => unknown;
  }

  /** A page element the init script may reveal: it only ever sets text and removes `hidden`. */
  class FakeElement {
    hidden = true;
    text = "";
    get textContent(): string {
      return this.text;
    }
    set textContent(value: string) {
      this.text = value;
    }
    set innerHTML(value: string) {
      throw new Error(`innerHTML was assigned: ${value}`);
    }
    removeAttribute(name: string): void {
      if (name === "hidden") this.hidden = false;
    }
    setAttribute(name: string): void {
      if (name === "hidden") this.hidden = true;
    }
  }

  interface WidgetRun {
    constructed: unknown[];
    registered: Registered[];
    fetches: Array<{ url: string; init: Record<string, unknown> }>;
    loadHandlers: Array<() => void>;
    warnings: unknown[][];
    /** The hidden "Click the blue square" step and the hidden failure line in the pairing block. */
    step: FakeElement;
    error: FakeElement;
    /** Runs the load handlers, as the browser does after the deferred widget script ran. */
    load(): void;
  }

  interface WidgetRunOptions {
    /** The page's location; null for no location global at all. */
    location?: Record<string, unknown> | null;
    /**
     * "absent": the widget script did not load (R2 503, SRI mismatch). "no-mount": the
     * constructor returns but puts no widget on the page.
     */
    webmcp?: "ok" | "absent" | "constructor-throws" | "first-register-throws" | "no-mount";
    /** What fetch answers; default a JSON envelope { ok: true, data: {} }. */
    fetchImpl?: (url: string, init: Record<string, unknown>) => unknown;
    readyState?: string;
    /** document.modelContext / navigator.modelContext, as for the state script. */
    documentModelContext?: Record<string, unknown> | null;
    navigatorModelContext?: Record<string, unknown>;
    /** The page has neither the step nor the failure line (getElementById answers null). */
    noBlockElements?: boolean;
  }

  const OK_ENVELOPE = { ok: true, data: { entries: [{ url: "https://example.com/a" }] } };
  const okFetch = (): unknown => Promise.resolve({ json: () => Promise.resolve(OK_ENVELOPE) });

  function initScriptOf(landing: string): string {
    const script = inlineScripts(landing).find((s) => s.includes("new WebMCP("));
    if (!script) throw new Error("the landing has no widget init script");
    return script;
  }

  function runWidgetInit(landing: string, o: WidgetRunOptions = {}): WidgetRun {
    const run: WidgetRun = {
      constructed: [],
      registered: [],
      fetches: [],
      loadHandlers: [],
      warnings: [],
      step: new FakeElement(),
      error: new FakeElement(),
      load: () => {
        for (const fn of run.loadHandlers) fn();
      },
    };
    const mode = o.webmcp ?? "ok";
    let mounted: FakeElement | null = null;
    class FakeWebMCP {
      constructor(options: unknown) {
        if (mode === "constructor-throws") throw new Error("widget constructor boom");
        run.constructed.push(options);
        // The real widget appends <div data-webmcp-widget> to document.body.
        if (mode !== "no-mount") mounted = new FakeElement();
      }
      registerTool(name: string, description: string, schema: unknown, execute: (input?: unknown) => unknown): void {
        if (mode === "first-register-throws" && run.registered.length === 0 && !(this as { thrown?: boolean }).thrown) {
          (this as { thrown?: boolean }).thrown = true;
          throw new Error("registerTool boom");
        }
        run.registered.push({ name, description, schema, execute });
      }
    }
    const elements: Record<string, FakeElement> = o.noBlockElements
      ? {}
      : { "webmcp-widget-step": run.step, "webmcp-widget-error": run.error };
    const doc: Record<string, unknown> = {
      readyState: o.readyState ?? "loading",
      getElementById: (id: string) => elements[id] ?? null,
      querySelector: (selector: string) => (selector === "[data-webmcp-widget]" ? mounted : null),
    };
    if (o.documentModelContext !== undefined) doc["modelContext"] = o.documentModelContext;
    const nav: Record<string, unknown> = {};
    if (o.navigatorModelContext !== undefined) nav["modelContext"] = o.navigatorModelContext;
    const globals: Record<string, unknown> = {
      document: doc,
      navigator: nav,
      window: {
        addEventListener: (type: string, fn: () => void) => {
          if (type === "load") run.loadHandlers.push(fn);
        },
      },
      fetch: (url: string, init: Record<string, unknown>) => {
        run.fetches.push({ url, init });
        return (o.fetchImpl ?? okFetch)(url, init);
      },
      console: { warn: (...args: unknown[]) => void run.warnings.push(args), info: () => {}, log: () => {} },
    };
    if (o.location !== null) {
      globals["location"] = o.location ?? { protocol: "https:", host: "shop.example.com", origin: "https://shop.example.com" };
    }
    if (mode !== "absent") globals["WebMCP"] = FakeWebMCP;
    vm.runInContext(initScriptOf(landing), vm.createContext(globals), { filename: "widget-init.js" });
    return run;
  }

  it("does nothing before load, then starts the widget once with a 30 minute inactivity timeout and registers every tool once", () => {
    const run = runWidgetInit(landingTwoTools);
    expect(run.constructed).toEqual([]);
    expect(run.loadHandlers).toHaveLength(1);
    run.load();
    expect(run.constructed).toHaveLength(1);
    // The vendored widget reads options.inactivityTimeout in milliseconds (webmcp.js:17, 893).
    expect(JSON.parse(JSON.stringify(run.constructed[0]))).toEqual({ inactivityTimeout: 1800000 });
    expect(run.registered.map((r) => r.name)).toEqual(["search_pages", "list_pages"]);
    expect(run.registered[0]!.description).toBe("Search the site.");
    expect(JSON.parse(JSON.stringify(run.registered[1]!.schema))).toEqual({
      type: "object",
      required: ["q"],
      properties: { q: { type: "string" } },
    });
  });

  it("hands the widget a description that tried to end the script, unchanged", () => {
    const run = runWidgetInit(landingTwoTools);
    run.load();
    expect(run.registered[1]!.description).toBe(HOSTILE_DESCRIPTION);
  });

  it("POSTs the input as JSON to <page origin><namespace>/exec/<tool>, without credentials", async () => {
    const run = runWidgetInit(landingTwoTools);
    run.load();
    await run.registered[1]!.execute({ q: "blog" });
    expect(run.fetches).toHaveLength(1);
    expect(run.fetches[0]!.url).toBe("https://shop.example.com/_agents/exec/list_pages");
    const init = JSON.parse(JSON.stringify(run.fetches[0]!.init));
    expect(init).toEqual({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "blog" }),
      credentials: "omit",
    });
  });

  it("sends {} when the bridge passes no arguments", async () => {
    const run = runWidgetInit(landingWidgetOn);
    run.load();
    await run.registered[0]!.execute(undefined);
    expect(run.fetches[0]!.init["body"]).toBe("{}");
  });

  it("returns the MCP CallToolResult the bridge passes through: the envelope as text, isError false on ok:true", async () => {
    const run = runWidgetInit(landingWidgetOn);
    run.load();
    const result = await run.registered[0]!.execute({ query: "a" });
    expect(JSON.parse(JSON.stringify(result))).toEqual({
      content: [{ type: "text", text: JSON.stringify(OK_ENVELOPE) }],
      isError: false,
    });
  });

  it("sets isError for an executor error envelope, a body that is not JSON and a failed fetch", async () => {
    const errorEnvelope = { ok: false, error: { code: "invalid_input", message: "missing query", retriable: false } };
    const cases: Array<[string, () => unknown, (text: string) => void]> = [
      [
        "an ok:false envelope",
        () => Promise.resolve({ json: () => Promise.resolve(errorEnvelope) }),
        (text) => expect(JSON.parse(text)).toEqual(errorEnvelope),
      ],
      [
        "a body that is not JSON",
        () => Promise.resolve({ json: () => Promise.reject(new SyntaxError("Unexpected token")) }),
        (text) => expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "internal", retriable: false } }),
      ],
      [
        "a fetch that rejects",
        () => Promise.reject(new TypeError("Failed to fetch")),
        (text) => expect(JSON.parse(text)).toMatchObject({ ok: false, error: { message: "Failed to fetch", retriable: true } }),
      ],
      [
        "an envelope without ok:true",
        () => Promise.resolve({ json: () => Promise.resolve({ data: {} }) }),
        (text) => expect(JSON.parse(text)).toEqual({ data: {} }),
      ],
    ];
    for (const [label, fetchImpl, checkText] of cases) {
      const run = runWidgetInit(landingWidgetOn, { fetchImpl });
      run.load();
      const result = JSON.parse(JSON.stringify(await run.registered[0]!.execute({ query: "a" }))) as {
        content: Array<{ type: string; text: string }>;
        isError: boolean;
      };
      expect(result.isError, label).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0]!.type, label).toBe("text");
      checkText(result.content[0]!.text);
    }
  });

  it.each([
    ["an opaque origin", { protocol: "https:", host: "shop.example.com", origin: "null" }],
    ["a file: page", { protocol: "file:", host: "", origin: "file://" }],
    ["no location at all", null],
  ] as const)("calls the endpoint root-relative under %s", async (_label, location) => {
    const run = runWidgetInit(landingWidgetOn, { location: location as Record<string, unknown> | null });
    run.load();
    await run.registered[0]!.execute({ query: "a" });
    expect(run.fetches[0]!.url).toBe("/_webmcp/exec/search_pages");
  });

  it("keeps a port in the page origin", async () => {
    const run = runWidgetInit(landingWidgetOn, {
      location: { protocol: "http:", host: "localhost:8787", origin: "http://localhost:8787" },
    });
    run.load();
    await run.registered[0]!.execute({ query: "a" });
    expect(run.fetches[0]!.url).toBe("http://localhost:8787/_webmcp/exec/search_pages");
  });

  it("reveals the blue-square step once the widget is on the page, and leaves the failure line hidden", () => {
    const run = runWidgetInit(landingWidgetOn);
    expect(run.step.hidden).toBe(true);
    run.load();
    expect(run.step.hidden).toBe(false);
    expect(run.error.hidden).toBe(true);
    expect(run.error.textContent).toBe("");
    expect(run.warnings).toEqual([]);
  });

  // The widget never got onto the page: its script did not run (R2 503, SRI mismatch), its
  // constructor threw, or it returned without mounting. The step stays hidden and one line says so.
  it.each([
    ["its script did not load", "absent"],
    ["its constructor throws", "constructor-throws"],
    ["it does not mount", "no-mount"],
  ] as const)("says on the page and in the console that the widget could not be loaded when %s", (_label, webmcp) => {
    const run = runWidgetInit(landingWidgetOn, { webmcp });
    expect(() => run.load()).not.toThrow();
    expect(run.registered).toEqual([]);
    expect(run.step.hidden).toBe(true);
    expect(run.error.hidden).toBe(false);
    expect(run.error.textContent).toMatch(/widget .*could not be loaded/i);
    expect(run.warnings.length).toBeGreaterThan(0);
    expect(String(run.warnings[0]![0])).toContain("cf-webmcp");
  });

  it("does not construct anything when the widget script did not load", () => {
    const run = runWidgetInit(landingWidgetOn, { webmcp: "absent" });
    run.load();
    expect(run.constructed).toEqual([]);
  });

  it("throws nothing when the page has neither the step nor the failure line (a custom template)", () => {
    for (const webmcp of ["ok", "absent"] as const) {
      const run = runWidgetInit(landingWidgetOn, { webmcp, noBlockElements: true });
      expect(() => run.load()).not.toThrow();
      expect(run.constructed).toHaveLength(webmcp === "ok" ? 1 : 0);
    }
  });

  it("registers the remaining tools when one registerTool call throws", () => {
    const run = runWidgetInit(landingTwoTools, { webmcp: "first-register-throws" });
    expect(() => run.load()).not.toThrow();
    expect(run.registered.map((r) => r.name)).toEqual(["list_pages"]);
    expect(run.warnings.length).toBeGreaterThan(0);
  });

  it("starts at once when the page has already loaded", () => {
    const run = runWidgetInit(landingWidgetOn, { readyState: "complete" });
    expect(run.loadHandlers).toHaveLength(0);
    expect(run.registered.map((r) => r.name)).toEqual(["search_pages"]);
  });

  // Each case: the browser as the widget init sees it, the same browser as the state script sees
  // it, and the state that script shows. The widget starts exactly when the pairing state shows.
  const registers = { registerTool: (): undefined => undefined };
  const browsers: Array<[string, WidgetRunOptions, RunOptions, string]> = [
    ["document.modelContext", { documentModelContext: registers }, { document: {} }, "state-native"],
    ["the navigator alias", { navigatorModelContext: registers }, { navigator: {} }, "state-native"],
    [
      "document.modelContext without registerTool plus the navigator alias",
      { documentModelContext: {}, navigatorModelContext: registers },
      { document: { registerTool: false }, navigator: {} },
      "state-native",
    ],
    ["no WebMCP", {}, {}, "state-pair"],
    ["a null document.modelContext", { documentModelContext: null }, { document: null }, "state-pair"],
    ["document.modelContext without registerTool", { documentModelContext: {} }, { document: { registerTool: false } }, "state-pair"],
  ];

  it.each(browsers)("with %s, starts the widget exactly when the page shows the pairing state", (_label, init, state, shownState) => {
    expect(runLanding(landingWidgetOn, state).active()).toEqual([shownState]);
    const run = runWidgetInit(landingWidgetOn, init);
    run.load();
    expect(run.constructed).toHaveLength(shownState === "state-pair" ? 1 : 0);
    // With WebMCP of its own the page shows Connected: the pairing block stays as it was.
    if (shownState === "state-native") {
      expect(run.step.hidden).toBe(true);
      expect(run.error.hidden).toBe(true);
      expect(run.warnings).toEqual([]);
    }
  });

  it("is absent from a landing without the widget", () => {
    expect(inlineScripts(landingWidgetOff).some((s) => s.includes("new WebMCP("))).toBe(false);
  });

  it("is ES5", () => {
    for (const landing of [landingWidgetOn, landingTwoTools]) expect(es5Violations(initScriptOf(landing))).toEqual([]);
  });
});
