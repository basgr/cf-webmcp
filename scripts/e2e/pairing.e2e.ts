/**
 * End-to-end check of the fallback widget's pairing, run by hand and never by `npm test`:
 *
 *   npm run e2e:pairing
 *
 * It drives the whole chain with real parts:
 *
 *   MCP client (@modelcontextprotocol/sdk, stdio)
 *     -> bridge `npx -y @jason.today/webmcp@<pinned> --mcp --port <free port>` (MCP stdio server)
 *     -> the bridge's localhost websocket daemon, started first with `--port <free port>`, the
 *        way step 1 on the landing starts it (that step also passes --config; this script never)
 *     -> the widget on the landing page, in the installed Chrome (playwright-core)
 *     -> `wrangler dev` serving templates/example-site with fallback_widget = true
 *     -> the example-site origin (scripts/dev-origin.ts)
 *
 * and asserts that tools/list shows the example tools and that tools/call search_pages returns
 * content, with isError false, and an invalid input isError true. The pairing token comes from
 * the bridge's own `_webmcp_get-token` tool and goes into the widget the way a visitor pastes it.
 *
 * What it leaves alone:
 *   - No desktop MCP client config: the bridge never gets `--config`, and it runs with HOME and
 *     USERPROFILE pointed at a temporary directory, so its own state (~/.webmcp: server token,
 *     pairing tokens, PID file) lands there. npx uses a temporary npm cache as well.
 *   - No browser download: playwright-core launches the installed Chrome (channel "chrome"), or
 *     the executable named by CHROME_PATH.
 *   - No tracked file: the ports are free ones picked at run time and passed as arguments, the
 *     config with fallback_widget = true is a temporary copy of the example-site TOML.
 *
 * What it changes and restores: src/generated (gitignored) is built from that temporary config
 * and rebuilt from templates/example-site/webmcp.toml at the end, as `npm test` builds it. The
 * composed widget object stays in the local R2 state of wrangler.dev.toml (.wrangler/state,
 * gitignored), where `npm run upload-widget -- --local` put it.
 *
 * Every child process (origin, wrangler, the bridge and the daemon it detaches, Chrome) is
 * stopped on every path, including Ctrl+C, and the script checks that their ports are closed.
 * It prints PASS or FAIL per step and exits 1 on any failure.
 *
 * Windows: the bridge's daemon calls process.stdin.setRawMode(true) on win32
 * (src/websocket-server.js:1504-1514 at tag v0.1.13), which exists only on a TTY. Started by an
 * MCP client it has no TTY, throws "process.stdin.setRawMode is not a function" and exits, so
 * nothing listens on the websocket port. On Windows this script preloads a shim into the bridge's
 * processes (NODE_OPTIONS=--require) that gives stdin a no-op setRawMode when it has none. That
 * shim is test scaffolding for an upstream bug; a visitor's bridge on Windows has no such shim.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, promises as fs, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type Browser } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE = process.execPath;
const TSX_CLI = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const WRANGLER_CLI = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const EXAMPLE_TOML = path.join(ROOT, "templates", "example-site", "webmcp.toml");
const IS_WIN = process.platform === "win32";

interface Pin {
  version: string;
  served_sha256: string;
}
const PIN = JSON.parse(readFileSync(path.join(ROOT, "vendor", "webmcp", "current.json"), "utf8")) as Pin;
/** The bridge release that matches the vendored widget, as the landing names it. */
const BRIDGE_PACKAGE = `@jason.today/webmcp@${PIN.version.replace(/^v/, "")}`;
const CLI_LINE = `npx -y ${BRIDGE_PACKAGE} --config claude`;
const WIDGET_ASSET = `widget.${PIN.served_sha256.slice(0, 16)}.js`;
const VENDORED_WIDGET = path.join(ROOT, "vendor", "webmcp", PIN.version, "webmcp.js");
const EXAMPLE_TOOLS = ["search_pages", "list_posts", "get_page"];

/** The last lines a process wrote, shown when a step fails. */
class Log {
  readonly lines: string[] = [];
  push(chunk: unknown): void {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue;
      this.lines.push(line);
      if (this.lines.length > 300) this.lines.shift();
    }
  }
  tail(n: number): string {
    return this.lines.slice(-n).join("\n");
  }
}

interface Managed {
  name: string;
  proc: ChildProcess;
  log: Log;
}

interface Run {
  base: string;
  home: string;
  managed: Managed[];
  bridgeLog: Log;
  browserLog: Log;
  browser: Browser | null;
  client: Client | null;
  transport: StdioClientTransport | null;
  ports: number[];
}

const run: Run = {
  base: "",
  home: "",
  managed: [],
  bridgeLog: new Log(),
  browserLog: new Log(),
  browser: null,
  client: null,
  transport: null,
  ports: [],
};

// ---------------------------------------------------------------------------
// Processes and ports
// ---------------------------------------------------------------------------

function startNode(name: string, args: string[], env: NodeJS.ProcessEnv): Managed {
  const proc = spawn(NODE, args, {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group on POSIX, so the whole group can be stopped.
    detached: !IS_WIN,
    windowsHide: true,
  });
  const log = new Log();
  proc.stdout?.on("data", (d) => log.push(d));
  proc.stderr?.on("data", (d) => log.push(d));
  proc.on("exit", (code, signal) => log.push(`[${name} exited, code ${code}, signal ${signal}]`));
  const m = { name, proc, log };
  run.managed.push(m);
  return m;
}

function descendants(pid: number): number[] {
  const r = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
  const kids = (r.stdout ?? "").split(/\s+/).filter(Boolean).map(Number);
  return kids.flatMap((k) => [k, ...descendants(k)]);
}

/** Stops a process and everything it started. Synchronous, so the exit handler can use it. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  for (const p of [...descendants(pid).reverse(), pid]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "localhost" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `probe` until it returns a value, or throws after `timeoutMs`. */
async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (e) {
      last = e;
    }
    await sleep(500);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ""}`);
}

async function httpGet(url: string): Promise<{ status: number; body: Buffer }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}
const results: StepResult[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  process.stdout.write(`  ...   ${name}\n`);
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    throw e;
  }
}

/** The text of a tools/call result's first content item, and its isError. */
function textOf(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const first = r.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected a text content item, got ${JSON.stringify(result).slice(0, 300)}`);
  }
  return { text: first.text, isError: r.isError === true };
}

const WINDOWS_STDIN_SHIM = `// Written by scripts/e2e/pairing.e2e.ts for the bridge's processes only.
// @jason.today/webmcp 0.1.13 calls process.stdin.setRawMode(true) on win32
// (src/websocket-server.js:1504-1514); without a TTY on stdin that throws and the daemon exits.
if (process.platform === 'win32' && /@jason\\.today[\\\\/]webmcp[\\\\/]/.test(process.argv[1] || '')) {
  var stdin = process.stdin;
  if (stdin && typeof stdin.setRawMode !== 'function') stdin.setRawMode = function () { return stdin; };
}
`;

async function main(): Promise<void> {
  run.base = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-e2e-"));
  run.home = path.join(run.base, "home");
  const npmCache = path.join(run.base, "npm-cache");
  const tomlPath = path.join(run.base, "webmcp.toml");
  await fs.mkdir(run.home);

  const [originPort, workerPort, inspectorPort, bridgePort] = await (async () => {
    const ports: number[] = [];
    while (ports.length < 4) {
      const p = await freePort();
      if (!ports.includes(p)) ports.push(p);
    }
    return ports as [number, number, number, number];
  })();
  run.ports = [originPort, workerPort, bridgePort];
  const workerOrigin = `http://localhost:${workerPort}`;
  // The bridge names a page's channel after its host with "." and ":" replaced by "_"
  // (webmcp.js _format), and prefixes the page's tools with it for the MCP client.
  const channel = `localhost_${workerPort}`;

  console.log(`cf-webmcp pairing e2e (bridge ${BRIDGE_PACKAGE}, widget ${PIN.version})`);
  console.log(`  ports: origin ${originPort}, worker ${workerPort}, inspector ${inspectorPort}, bridge websocket ${bridgePort}`);
  console.log(`  temporary HOME/USERPROFILE and npm cache under ${run.base}`);

  await step("preconditions: the vendored widget file is present", async () => {
    if (!existsSync(VENDORED_WIDGET)) {
      throw new Error(`${path.relative(ROOT, VENDORED_WIDGET)} is missing; run npm run update-widget with the version and sha256 from vendor/webmcp/current.json`);
    }
    return path.relative(ROOT, VENDORED_WIDGET);
  });

  let landingPath = "";
  await step("build the example site with fallback_widget = true (temporary TOML)", async () => {
    let toml = await fs.readFile(EXAMPLE_TOML, "utf8");
    landingPath = /^\[webmcp_landing\][^[]*?^path\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? "";
    if (!landingPath) throw new Error("the example-site TOML has no [webmcp_landing].path");
    const before = toml;
    toml = toml.replace(/^fallback_widget\s*=\s*false.*$/m, "fallback_widget  = true");
    if (toml === before) throw new Error("the example-site TOML has no `fallback_widget = false` line to switch on");
    if (!toml.includes("localhost:8081") || !toml.includes("localhost:8787")) {
      throw new Error("the example-site TOML no longer names localhost:8081 and localhost:8787");
    }
    toml = toml.split("localhost:8081").join(`localhost:${originPort}`).split("localhost:8787").join(`localhost:${workerPort}`);
    await fs.writeFile(tomlPath, toml);
    const r = spawnSync(NODE, [TSX_CLI, "scripts/build-config.ts"], {
      cwd: ROOT,
      env: { ...process.env, CF_WEBMCP_CONFIG: tomlPath },
      encoding: "utf8",
      windowsHide: true,
    });
    if (r.status !== 0) throw new Error(`build failed:\n${r.stdout}\n${r.stderr}`);
    const landing = await fs.readFile(path.join(ROOT, "src", "generated", "landing.html"), "utf8");
    if (!landing.includes(CLI_LINE)) throw new Error(`the built landing does not contain "${CLI_LINE}"`);
    if (!landing.includes("new WebMCP(")) throw new Error("the built landing does not start the widget");
    return `landing names "${CLI_LINE}" and starts the widget`;
  });

  await step("upload the composed widget to local R2 (npm run upload-widget -- --local)", async () => {
    const r = spawnSync("npm run upload-widget -- --local", { cwd: ROOT, shell: true, encoding: "utf8", windowsHide: true });
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.status !== 0) throw new Error(`upload-widget failed:\n${out}`);
    const line = out.split(/\r?\n/).find((l) => l.includes("[upload-widget] uploading"));
    return line ? line.replace("[upload-widget] ", "") : "uploaded";
  });

  await step("start the example-site origin", async () => {
    const origin = startNode("origin", [TSX_CLI, "scripts/dev-origin.ts"], { ...process.env, ORIGIN_PORT: String(originPort) });
    await waitFor("the origin to answer", 30_000, async () => {
      if (origin.proc.exitCode !== null) throw new Error(`origin exited:\n${origin.log.tail(20)}`);
      return (await httpGet(`http://localhost:${originPort}/sitemap.xml`)).status === 200 ? true : undefined;
    });
    return `http://localhost:${originPort}`;
  });

  await step("start wrangler dev (wrangler.dev.toml) and serve the widget from local R2", async () => {
    const wrangler = startNode(
      "wrangler",
      [
        WRANGLER_CLI,
        "dev",
        "--config",
        "wrangler.dev.toml",
        "--port",
        String(workerPort),
        "--inspector-port",
        String(inspectorPort),
        "--show-interactive-dev-session=false",
      ],
      { ...process.env, WRANGLER_SEND_METRICS: "false" },
    );
    await waitFor("wrangler dev to answer /_webmcp/health", 120_000, async () => {
      if (wrangler.proc.exitCode !== null) throw new Error(`wrangler exited:\n${wrangler.log.tail(30)}`);
      return (await httpGet(`${workerOrigin}/_webmcp/health`)).status === 200 ? true : undefined;
    });
    const widget = await httpGet(`${workerOrigin}/_webmcp/${WIDGET_ASSET}`);
    if (widget.status !== 200) throw new Error(`GET /_webmcp/${WIDGET_ASSET} answered ${widget.status}`);
    const sha = createHash("sha256").update(widget.body).digest("hex");
    if (sha !== PIN.served_sha256) throw new Error(`the served widget hashes to ${sha}, the pin says ${PIN.served_sha256}`);
    const landing = await httpGet(`${workerOrigin}${landingPath}`);
    if (landing.status !== 200 || !landing.body.toString("utf8").includes(CLI_LINE)) {
      throw new Error(`GET ${landingPath} answered ${landing.status} without the pinned CLI line`);
    }
    return `${workerOrigin}: ${landingPath} names the pinned CLI, /_webmcp/${WIDGET_ASSET} is the pinned object`;
  });

  // The bridge's processes: a temporary HOME/USERPROFILE for its state, a temporary npm cache, and
  // on Windows the stdin shim. Their working directory is outside run.base, so no process that
  // outlives a kill by a moment holds the directory open.
  const shimPath = path.join(run.base, "stdin-setrawmode-shim.cjs");
  const bridgeEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") bridgeEnv[k] = v;
  Object.assign(bridgeEnv, {
    HOME: run.home,
    USERPROFILE: run.home,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    // Forward slashes: NODE_OPTIONS treats a backslash in a quoted value as an escape.
    NODE_OPTIONS: IS_WIN ? `--require "${shimPath.replace(/\\/g, "/")}"` : "",
  });
  /** Bridge arguments, checked: --config writes the desktop MCP client's config, and this script never passes it. */
  const bridgeArgs = (...args: string[]): string[] => {
    if (args.includes("--config")) throw new Error("refusing to pass --config to the bridge");
    return ["-y", BRIDGE_PACKAGE, ...args];
  };

  await step(`start the bridge daemon as landing step 1 does, without --config (npx ${bridgeArgs("--port", String(bridgePort)).join(" ")})`, async () => {
    await fs.writeFile(shimPath, WINDOWS_STDIN_SHIM);
    // Step 1 on the landing (`--config <client>`) configures the client and starts the daemon;
    // the client then starts `--mcp`, which finds the daemon running and connects to it. Started
    // the other way round, the MCP side's first connect races the daemon's start-up, and its
    // reconnects send no token (src/server.js:216-222 calls connectToWebSocketServer() without
    // the server token, so the URL says token=undefined) and the daemon answers 401.
    // The command is a fixed string of the package spec and a port number.
    const r = spawnSync(`npx ${bridgeArgs("--port", String(bridgePort)).join(" ")}`, {
      cwd: os.tmpdir(),
      env: bridgeEnv,
      shell: true,
      encoding: "utf8",
      windowsHide: true,
      timeout: 240_000,
    });
    run.bridgeLog.push(r.stdout);
    run.bridgeLog.push(r.stderr);
    if (r.status !== 0) throw new Error(`the bridge exited with ${r.status}:\n${r.stdout}\n${r.stderr}`);
    const banner = await waitFor("the daemon to answer on its port", 20_000, async () => {
      const res = await httpGet(`http://localhost:${bridgePort}/`);
      return res.status === 200 ? res.body.toString("utf8").trim() : undefined;
    });
    return `daemon (pid ${daemonPid()}) on port ${bridgePort} answers "${banner}"`;
  });

  await step(`start the bridge as an MCP stdio server through the SDK (npx ${bridgeArgs("--mcp", "--port", String(bridgePort)).join(" ")})`, async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: bridgeArgs("--mcp", "--port", String(bridgePort)),
      env: bridgeEnv,
      cwd: os.tmpdir(),
      stderr: "pipe",
    });
    transport.stderr?.on("data", (d) => run.bridgeLog.push(d));
    run.transport = transport;
    const client = new Client({ name: "cf-webmcp-pairing-e2e", version: "1.0.0" });
    run.client = client;
    await client.connect(transport, { timeout: 120_000 });
    await waitFor("the bridge's MCP side to reach the daemon", 20_000, async () =>
      run.bridgeLog.lines.some((l) => l.includes("Connected to WebSocket server on path: /mcp")) ? true : undefined,
    );
    const server = client.getServerVersion();
    return `connected to ${server?.name ?? "?"} ${server?.version ?? "?"}; its MCP side reached the daemon on /mcp`;
  });

  let token = "";
  await step("get a pairing token from the bridge's own _webmcp_get-token tool", async () => {
    const { text } = textOf(await run.client!.callTool({ name: "_webmcp_get-token", arguments: {} }));
    token = text.trim().split(/\r?\n/).pop()!.trim();
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as { server?: string; token?: string };
    if (decoded.server !== `ws://localhost:${bridgePort}` || !decoded.token) {
      throw new Error(`the token does not name ws://localhost:${bridgePort}: ${JSON.stringify({ server: decoded.server })}`);
    }
    return `token for ${decoded.server}`;
  });

  await step("open the landing in Chrome and paste the token into the widget", async () => {
    const executablePath = process.env["CHROME_PATH"];
    try {
      run.browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: "chrome", headless: true });
    } catch (e) {
      throw new Error(
        `could not start Chrome (${e instanceof Error ? e.message.split("\n")[0] : String(e)}). ` +
          `Install Google Chrome or set CHROME_PATH; this script never downloads a browser.`,
      );
    }
    const page = await run.browser.newPage();
    page.on("console", (m) => run.browserLog.push(`[console.${m.type()}] ${m.text()}`));
    page.on("pageerror", (e) => run.browserLog.push(`[pageerror] ${e.message}`));
    await page.goto(`${workerOrigin}${landingPath}`, { waitUntil: "load" });
    await page.locator("#state-pair.active").waitFor({ state: "visible", timeout: 10_000 });
    await page.locator("[data-webmcp-widget] .webmcp-trigger").click({ timeout: 10_000 });
    await page.locator(".webmcp-token-input").fill(token);
    await page.locator(".webmcp-connect-btn").click();
    await page.locator(".webmcp-status", { hasText: "Connected to" }).waitFor({ timeout: 20_000 });
    const status = (await page.locator(".webmcp-status").textContent())?.trim() ?? "";
    const warnings = run.browserLog.lines.filter((l) => l.includes("cf-webmcp: fallback widget"));
    if (warnings.length) throw new Error(`the widget init warned:\n${warnings.join("\n")}`);
    return `pairing state shown; widget says "${status}"`;
  });

  await step("tools/list through the MCP client shows the example tools", async () => {
    const want = EXAMPLE_TOOLS.map((n) => `${channel}-${n}`);
    const names = await waitFor("the page's tools in tools/list", 20_000, async () => {
      const listed = (await run.client!.listTools()).tools.map((t) => t.name);
      return want.every((w) => listed.includes(w)) ? listed : undefined;
    });
    return names.join(", ");
  });

  await step(`tools/call ${channel}-search_pages {"query":"blog"} returns content`, async () => {
    const { text, isError } = textOf(await run.client!.callTool({ name: `${channel}-search_pages`, arguments: { query: "blog" } }));
    if (isError) throw new Error(`isError is true: ${text}`);
    const envelope = JSON.parse(text) as { ok?: boolean; data?: { entries?: unknown[] } };
    if (envelope.ok !== true || !Array.isArray(envelope.data?.entries) || envelope.data.entries.length === 0) {
      throw new Error(`unexpected envelope: ${text.slice(0, 300)}`);
    }
    return `isError false, ${envelope.data.entries.length} entr${envelope.data.entries.length === 1 ? "y" : "ies"}: ${text.slice(0, 160)}`;
  });

  await step(`tools/call ${channel}-search_pages {} (no query) returns isError true`, async () => {
    const { text, isError } = textOf(await run.client!.callTool({ name: `${channel}-search_pages`, arguments: {} }));
    const envelope = JSON.parse(text) as { ok?: boolean; error?: { code?: string } };
    if (!isError || envelope.ok !== false) throw new Error(`expected isError true and ok:false, got isError ${isError}: ${text}`);
    return `isError true, error code ${envelope.error?.code}`;
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** The daemon the bridge detaches is in no process tree; its PID file (in the temporary HOME) names it. */
function daemonPid(): number | null {
  try {
    const pid = Number(readFileSync(path.join(run.home, ".webmcp", ".webmcp-server.pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Stops every process. Synchronous, so it also runs from the exit handler. */
function killAll(): void {
  if (run.transport?.pid) killTree(run.transport.pid);
  const daemon = run.home ? daemonPid() : null;
  if (daemon) killTree(daemon);
  for (const m of [...run.managed].reverse()) killTree(m.proc.pid);
}

let cleanedUp = false;
async function cleanup(): Promise<string[]> {
  if (cleanedUp) return [];
  cleanedUp = true;
  const problems: string[] = [];
  const daemon = run.home ? daemonPid() : null;
  if (run.browser) await run.browser.close().catch((e: unknown) => problems.push(`closing Chrome: ${String(e)}`));
  if (run.client) await Promise.race([run.client.close().catch(() => undefined), sleep(5000)]);
  killAll();
  await sleep(2000);

  const leftovers = run.managed.filter((m) => m.proc.pid && isAlive(m.proc.pid)).map((m) => `${m.name} (pid ${m.proc.pid})`);
  if (daemon && isAlive(daemon)) leftovers.push(`bridge daemon (pid ${daemon})`);
  if (run.transport?.pid && isAlive(run.transport.pid)) leftovers.push(`bridge (pid ${run.transport.pid})`);
  for (const port of run.ports) if (await portOpen(port)) leftovers.push(`something still listens on port ${port}`);
  if (leftovers.length) problems.push(`left running: ${leftovers.join(", ")}`);

  // Put src/generated back to what `npm test` and `npm run dev:worker` build.
  const r = spawnSync(NODE, [TSX_CLI, "scripts/build-config.ts"], {
    cwd: ROOT,
    env: { ...process.env, CF_WEBMCP_CONFIG: EXAMPLE_TOML },
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status !== 0) problems.push(`rebuilding src/generated from the example-site TOML failed: ${r.stderr}`);

  if (run.base) {
    await fs.rm(run.base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch((e: unknown) => {
      problems.push(`removing ${run.base}: ${String(e)}`);
    });
  }
  return problems;
}

function printLogs(): void {
  const sections: Array<[string, Log]> = [
    ...run.managed.map((m): [string, Log] => [m.name, m.log]),
    ["bridge (stderr)", run.bridgeLog],
    ["browser console", run.browserLog],
  ];
  for (const [name, log] of sections) {
    if (!log.lines.length) continue;
    console.log(`\n--- last lines of ${name} ---\n${log.tail(40)}`);
  }
}

process.once("exit", () => killAll());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`\n${signal}: stopping every child process`);
    void cleanup().finally(() => process.exit(130));
  });
}

let failed = false;
try {
  await main();
} catch {
  failed = true;
}
const cleanupProblems = await cleanup();

console.log("\nResults:");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name} (${r.ms} ms)\n        ${r.detail.split("\n").join("\n        ")}`);
console.log(`  ${cleanupProblems.length ? "FAIL" : "PASS"}  cleanup: every child process stopped, ports closed, src/generated rebuilt from the example-site TOML`);
for (const p of cleanupProblems) console.log(`        ${p}`);
if (failed) printLogs();
const ok = !failed && cleanupProblems.length === 0;
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
