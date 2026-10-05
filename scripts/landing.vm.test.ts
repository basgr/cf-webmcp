import { describe, it, expect, beforeAll, afterAll } from "vitest";
import vm from "node:vm";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "./build-config";
import { inlineScripts } from "../src/test-support/es5";

/**
 * Runs the default landing page's inline script in a vm against a small fake DOM and a fake
 * `document.modelContext`. The state branching (Connected / Pairing required / Not
 * connected) and the diagnostic list are what a visitor sees, so they are checked by running
 * the script rather than by reading its text.
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
`;

const WIDGET_OFF = `${TOML}\n[features]\nfallback_widget = false\n`;

let tmpDir = "";
let landingWidgetOn = "";
let landingWidgetOff = "";

async function buildLanding(name: string, toml: string): Promise<string> {
  const tomlPath = path.join(tmpDir, `${name}.toml`);
  await fs.writeFile(tomlPath, toml);
  const outDir = path.join(tmpDir, `out-${name}`);
  await buildConfig({ tomlPath, outDir });
  return fs.readFile(path.join(outDir, "landing.html"), "utf8");
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-landing-"));
  landingWidgetOn = await buildLanding("on", TOML);
  landingWidgetOff = await buildLanding("off", WIDGET_OFF);
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
  getTools?: "absent" | "list" | "throw" | "reject";
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
  if (getTools === "list") mc["getTools"] = () => Promise.resolve((o.names ?? []).map((name) => ({ name })));
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
    expect(diagLine(page, "typeof modelContext.registerTool")).toBe("typeof modelContext.registerTool: function");
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
});
