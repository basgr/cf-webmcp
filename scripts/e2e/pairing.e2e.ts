/**
 * End-to-end check of the fallback widget's pairing, run by hand and never by `npm test`:
 *
 *   npm run e2e:pairing
 *
 * It follows the pairing steps the landing page shows, with the commands taken from the built
 * page itself, and real parts throughout:
 *
 *   step 1  the bridge's daemon: the page's `npx -y @jason.today/webmcp@<pinned> --foreground`,
 *           plus `--port <free port>`, as a long-running child of this script. The home is new,
 *           so, as the page says for a first run, it is stopped once and started again
 *   step 2  the MCP client: @modelcontextprotocol/sdk's stdio client starts the page's Claude
 *           Desktop entry (`npx -y @jason.today/webmcp@<pinned> --mcp`, plus `--port`), after the
 *           daemon is up, as the page says
 *   step 3  a pairing token from the bridge's `_webmcp_get-token` tool (the page's `--new`
 *           command is checked as well)
 *   step 4  the widget on the landing page in the installed Chrome (playwright-core): it must
 *           mount and show the step that points at it; the token goes in as a visitor pastes it
 *   then    tools/list shows the example tools, tools/call search_pages returns content with
 *           isError false, and an invalid input returns isError true, all through
 *           `wrangler dev` (templates/example-site with fallback_widget = true) and the
 *           example-site origin (scripts/dev-origin.ts)
 *
 * On Windows it also checks the reason step 1 says --foreground: without it, the bridge's
 * forked daemon exits at once. Last, a second tab whose widget script answers 503 must show the
 * page's "could not be loaded" line and keep the widget step hidden.
 *
 * What it leaves alone:
 *   - No desktop MCP client config: the bridge never gets `--config`. Its processes run with
 *     HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_CONFIG_HOME and XDG_DATA_HOME pointed at a
 *     temporary directory, so the bridge's own state (~/.webmcp: server token, pairing tokens, PID
 *     file) lands there, and npx uses a temporary npm cache.
 *   - No browser download: playwright-core launches the installed Chrome (channel "chrome"), or
 *     the executable named by CHROME_PATH.
 *   - No tracked file: the ports are free ones picked at run time and passed as arguments, and
 *     the config with fallback_widget = true is a temporary copy of the example-site TOML.
 *
 * What it changes and restores: src/generated (gitignored) is built from that temporary config
 * and rebuilt from templates/example-site/webmcp.toml at the end, as `npm test` builds it. The
 * composed widget object stays in the local R2 state of wrangler.dev.toml (.wrangler/state,
 * gitignored), where `npm run upload-widget -- --local` put it.
 *
 * Every child process (origin, wrangler, the bridge's daemon and MCP side, every npx under
 * them, Chrome) is stopped on every path, including Ctrl+C and a command that runs past its
 * time, as a whole process tree (taskkill /T on Windows). The script then checks that the ports
 * are closed. It prints PASS or FAIL per step and exits 1 on any failure.
 *
 * The Windows shim: the bridge's daemon calls process.stdin.setRawMode(true) on win32
 * (src/websocket-server.js:1504-1514 at tag v0.1.13), which only a terminal has. A visitor runs
 * step 1 in a terminal, so it works for them. This script starts the daemon as a child process
 * with no terminal, so on Windows it preloads a shim into the daemon's processes only
 * (NODE_OPTIONS=--require) that gives stdin a no-op setRawMode when it has none. The MCP side
 * and the one-shot commands run without it.
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
  /** Temporary home directories of the bridge's processes; each may hold a daemon PID file. */
  homes: string[];
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
  homes: [],
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

/**
 * Starts a child this script owns until cleanup: a node script, or (shell) a command line made
 * of fixed text, a package spec and port numbers.
 */
function startChild(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, shell = false): Managed {
  const proc = spawn(command, args, {
    cwd: shell ? os.tmpdir() : ROOT,
    env,
    shell,
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

const hasExited = (proc: ChildProcess): boolean => proc.exitCode !== null || proc.signalCode !== null;

/** Runs a one-shot command line to its end; past `timeoutMs` its whole process tree is stopped. */
function runToEnd(name: string, commandLine: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  const m = startChild(name, commandLine, [], env, true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      m.log.push(`[${name} ran past ${timeoutMs} ms; stopping its process tree]`);
      killTree(m.proc.pid);
    }, timeoutMs);
    m.proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out: m.log.lines.join("\n") });
    });
  });
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

async function httpGet(url: string): Promise<{ status: number; body: Buffer; headers: Headers }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
  return { status: res.status, body: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

/** The daemon PID a bridge home's PID file names, if any. */
function daemonPidIn(home: string): number | null {
  try {
    const pid = Number(readFileSync(path.join(home, ".webmcp", ".webmcp-server.pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** A bridge pairing token is base64 JSON naming the daemon's websocket URL. */
function decodeToken(token: string): { server?: string; token?: string } {
  return JSON.parse(Buffer.from(token, "base64").toString("utf8")) as { server?: string; token?: string };
}

// ---------------------------------------------------------------------------
// The landing page's own instructions
// ---------------------------------------------------------------------------

function unescapeHtml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

interface PageSteps {
  foreground: string;
  newToken: string;
  clientEntry: { command: string; args: string[] };
}

/** The commands the pairing steps give, read from the built landing page. */
function pageSteps(landing: string): PageSteps {
  const code = [...landing.matchAll(/<code>([\s\S]*?)<\/code>/g)].map((m) => unescapeHtml(m[1]!));
  const foreground = code.find((c) => /^npx -y \S+ --foreground$/.test(c));
  const newToken = code.find((c) => /^npx -y \S+ --new$/.test(c));
  const json = code.find((c) => c.includes('"mcpServers"'));
  if (!foreground || !newToken || !json) throw new Error("the landing does not show the --foreground, --new and client-entry steps");
  const entry = (JSON.parse(json) as { mcpServers?: { webmcp?: { command?: unknown; args?: unknown } } }).mcpServers?.webmcp;
  if (!entry || typeof entry.command !== "string" || !Array.isArray(entry.args)) throw new Error(`unexpected client entry: ${json}`);
  return { foreground, newToken, clientEntry: { command: entry.command, args: entry.args.map(String) } };
}

/** Refuses --config, which writes a desktop MCP client's config. */
function noConfigFlag(commandLineOrArgs: string | string[]): void {
  const parts = Array.isArray(commandLineOrArgs) ? commandLineOrArgs : commandLineOrArgs.split(/\s+/);
  if (parts.includes("--config")) throw new Error("refusing to pass --config to the bridge");
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

const WINDOWS_STDIN_SHIM = `// Written by scripts/e2e/pairing.e2e.ts for the bridge daemon it starts without a terminal.
// @jason.today/webmcp 0.1.13 calls process.stdin.setRawMode(true) on win32
// (src/websocket-server.js:1504-1514); a visitor runs the daemon in a terminal, where stdin has
// it, but this child process has no terminal, so stdin gets a no-op. NODE_OPTIONS also loads this
// file into npx's own node process; the argv check leaves that one alone.
if (process.platform === 'win32' && /@jason\\.today[\\\\/]webmcp[\\\\/]/.test(process.argv[1] || '')) {
  var stdin = process.stdin;
  if (stdin && typeof stdin.setRawMode !== 'function') stdin.setRawMode = function () { return stdin; };
}
`;

/** The environment of the bridge's processes: every home and config directory points into `dir`. */
async function bridgeEnvIn(dir: string, npmCache: string, nodeOptions: string): Promise<Record<string, string>> {
  const home = path.join(dir, "home");
  const dirs = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(dir, "appdata"),
    LOCALAPPDATA: path.join(dir, "localappdata"),
    XDG_CONFIG_HOME: path.join(dir, "xdg-config"),
    XDG_DATA_HOME: path.join(dir, "xdg-data"),
  };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
  run.homes.push(home);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  return {
    ...env,
    ...dirs,
    npm_config_cache: npmCache,
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NODE_OPTIONS: nodeOptions,
  };
}

async function main(): Promise<void> {
  run.base = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-e2e-"));
  const npmCache = path.join(run.base, "npm-cache");
  const tomlPath = path.join(run.base, "webmcp.toml");

  const ports: number[] = [];
  while (ports.length < 5) {
    const p = await freePort();
    if (!ports.includes(p)) ports.push(p);
  }
  const [originPort, workerPort, inspectorPort, bridgePort, deadDaemonPort] = ports as [number, number, number, number, number];
  run.ports = [originPort, workerPort, bridgePort, deadDaemonPort];
  const workerOrigin = `http://localhost:${workerPort}`;
  // The bridge names a page's channel after its host with "." and ":" replaced by "_"
  // (webmcp.js _format), and prefixes the page's tools with it for the MCP client.
  const channel = `localhost_${workerPort}`;

  console.log(`cf-webmcp pairing e2e (bridge ${BRIDGE_PACKAGE}, widget ${PIN.version})`);
  console.log(`  ports: origin ${originPort}, worker ${workerPort}, inspector ${inspectorPort}, bridge websocket ${bridgePort}`);
  console.log(`  temporary home, config and npm cache directories under ${run.base}`);

  await step("preconditions: the vendored widget file is present", async () => {
    if (!existsSync(VENDORED_WIDGET)) {
      throw new Error(`${path.relative(ROOT, VENDORED_WIDGET)} is missing; run npm run update-widget with the version and sha256 from vendor/webmcp/current.json`);
    }
    return path.relative(ROOT, VENDORED_WIDGET);
  });

  let landingPath = "";
  let steps: PageSteps | null = null;
  await step("build the example site with fallback_widget = true (temporary TOML) and read its pairing steps", async () => {
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
    if (!landing.includes("new WebMCP(")) throw new Error("the built landing does not start the widget");
    steps = pageSteps(landing);
    for (const c of [steps.foreground, steps.newToken, ...steps.clientEntry.args]) {
      if (c.includes("@jason.today/webmcp@") && !c.includes(BRIDGE_PACKAGE)) throw new Error(`"${c}" does not name ${BRIDGE_PACKAGE}`);
    }
    return `step 1 "${steps.foreground}", step 2 ${JSON.stringify(steps.clientEntry)}, step 3 "${steps.newToken}"`;
  });
  const page = steps as PageSteps | null;
  if (!page) throw new Error("unreachable: no pairing steps");

  await step("upload the composed widget to local R2 (npm run upload-widget -- --local)", async () => {
    const r = spawnSync("npm run upload-widget -- --local", { cwd: ROOT, shell: true, encoding: "utf8", windowsHide: true });
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.status !== 0) throw new Error(`upload-widget failed:\n${out}`);
    const line = out.split(/\r?\n/).find((l) => l.includes("[upload-widget] uploading"));
    return line ? line.replace("[upload-widget] ", "") : "uploaded";
  });

  await step("start the example-site origin", async () => {
    const origin = startChild("origin", NODE, [TSX_CLI, "scripts/dev-origin.ts"], { ...process.env, ORIGIN_PORT: String(originPort) });
    await waitFor("the origin to answer", 30_000, async () => {
      if (hasExited(origin.proc)) throw new Error(`origin exited:\n${origin.log.tail(20)}`);
      return (await httpGet(`http://localhost:${originPort}/sitemap.xml`)).status === 200 ? true : undefined;
    });
    return `http://localhost:${originPort}`;
  });

  await step("start wrangler dev (wrangler.dev.toml) and serve the widget from local R2", async () => {
    const wrangler = startChild(
      "wrangler",
      NODE,
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
      if (hasExited(wrangler.proc)) throw new Error(`wrangler exited:\n${wrangler.log.tail(30)}`);
      return (await httpGet(`${workerOrigin}/_webmcp/health`)).status === 200 ? true : undefined;
    });
    const widget = await httpGet(`${workerOrigin}/_webmcp/${WIDGET_ASSET}`);
    if (widget.status !== 200) throw new Error(`GET /_webmcp/${WIDGET_ASSET} answered ${widget.status}`);
    const sha = createHash("sha256").update(widget.body).digest("hex");
    if (sha !== PIN.served_sha256) throw new Error(`the served widget hashes to ${sha}, the pin says ${PIN.served_sha256}`);
    const landing = await httpGet(`${workerOrigin}${landingPath}`);
    if (landing.status !== 200 || !landing.body.toString("utf8").includes(page.foreground)) {
      throw new Error(`GET ${landingPath} answered ${landing.status} without step 1's command`);
    }
    return `${workerOrigin}: ${landingPath} shows the pinned steps, /_webmcp/${WIDGET_ASSET} is the pinned object`;
  });

  if (IS_WIN) {
    await step("on Windows the bridge's default (forked) daemon exits without a terminal: why step 1 says --foreground", async () => {
      // No --foreground and no shim: what the bridge does when a client or a plain `npx` starts it.
      const env = await bridgeEnvIn(path.join(run.base, "bridge-default"), npmCache, "");
      const commandLine = `npx -y ${BRIDGE_PACKAGE} --port ${deadDaemonPort}`;
      noConfigFlag(commandLine);
      const r = await runToEnd("bridge (default daemon mode)", commandLine, env, 240_000);
      if (!/Server started as daemon with PID/.test(r.out)) throw new Error(`the bridge did not fork a daemon:\n${r.out}`);
      await sleep(5000);
      const pid = daemonPidIn(env["HOME"]!);
      if (pid === null) throw new Error("the forked daemon wrote no PID file");
      if (isAlive(pid) || (await portOpen(deadDaemonPort))) {
        throw new Error(`the forked daemon (pid ${pid}) is still running: upstream changed, so revisit why the landing says --foreground`);
      }
      return `"${commandLine}" forked daemon pid ${pid}, which had exited 5 s later; nothing listens on port ${deadDaemonPort}`;
    });
  }

  const shimPath = path.join(run.base, "stdin-setrawmode-shim.cjs");
  await fs.writeFile(shimPath, WINDOWS_STDIN_SHIM);
  const bridgeDir = path.join(run.base, "bridge");
  // Forward slashes: NODE_OPTIONS treats a backslash in a quoted value as an escape.
  const daemonEnv = await bridgeEnvIn(bridgeDir, npmCache, IS_WIN ? `--require "${shimPath.replace(/\\/g, "/")}"` : "");
  const plainEnv = await bridgeEnvIn(bridgeDir, npmCache, "");

  const startDaemon = async (name: string): Promise<{ daemon: Managed; banner: string; acao: string | null }> => {
    const commandLine = `${page.foreground} --port ${bridgePort}`;
    noConfigFlag(commandLine);
    const daemon = startChild(name, commandLine, [], daemonEnv, true);
    daemon.proc.stdout?.on("data", (d) => run.bridgeLog.push(d));
    daemon.proc.stderr?.on("data", (d) => run.bridgeLog.push(d));
    const res = await waitFor("the daemon to answer on its port", 240_000, async () => {
      if (hasExited(daemon.proc)) throw new Error(`the daemon exited:\n${daemon.log.tail(20)}`);
      const r = await httpGet(`http://localhost:${bridgePort}/`);
      return r.status === 200 ? r : undefined;
    });
    return { daemon, banner: res.body.toString("utf8").trim(), acao: res.headers.get("access-control-allow-origin") };
  };

  await step(`step 1, first run on this (temporary) home: ${page.foreground} --port ${bridgePort}, then Ctrl+C`, async () => {
    // The page says: the first run creates the settings in ~/.webmcp but does not use them yet,
    // so stop it and run the same command again.
    const { daemon } = await startDaemon("bridge daemon, first run (--foreground)");
    const envFile = path.join(plainEnv["HOME"]!, ".webmcp", ".env");
    if (!existsSync(envFile)) throw new Error(`the first run created no ${envFile}`);
    killTree(daemon.proc.pid);
    await waitFor("the first run to stop", 20_000, async () => (!(await portOpen(bridgePort)) ? true : undefined));
    return `created ${path.relative(run.base, envFile)} with the server token, then stopped`;
  });

  await step(`step 1, again: ${page.foreground} --port ${bridgePort}`, async () => {
    const { banner, acao } = await startDaemon("bridge daemon (--foreground)");
    return `pid ${daemonPidIn(plainEnv["HOME"]!)} answers "${banner}" with Access-Control-Allow-Origin ${acao}`;
  });

  await step(`step 2: start the client entry from the page through the MCP SDK (${page.clientEntry.command} ${page.clientEntry.args.join(" ")} --port ${bridgePort})`, async () => {
    const args = [...page.clientEntry.args, "--port", String(bridgePort)];
    noConfigFlag(args);
    const transport = new StdioClientTransport({ command: page.clientEntry.command, args, env: plainEnv, cwd: os.tmpdir(), stderr: "pipe" });
    transport.stderr?.on("data", (d) => run.bridgeLog.push(d));
    run.transport = transport;
    const client = new Client({ name: "cf-webmcp-pairing-e2e", version: "1.0.0" });
    run.client = client;
    await client.connect(transport, { timeout: 120_000 });
    await waitFor("the client's side of the bridge to reach the daemon", 20_000, async () =>
      run.bridgeLog.lines.some((l) => l.includes("Connected to WebSocket server on path: /mcp")) ? true : undefined,
    );
    const server = client.getServerVersion();
    return `connected to ${server?.name ?? "?"} ${server?.version ?? "?"}; it reached the daemon on /mcp`;
  });

  await step(`step 3, second way: ${page.newToken} --port ${bridgePort} prints a token for the daemon`, async () => {
    const commandLine = `${page.newToken} --port ${bridgePort}`;
    noConfigFlag(commandLine);
    const r = await runToEnd("bridge --new", commandLine, plainEnv, 120_000);
    const lines = r.out.split(/\r?\n/).map((l) => l.trim());
    const at = lines.findIndex((l) => l.startsWith("CONNECTION TOKEN"));
    const printed = at >= 0 ? lines.slice(at + 1).find((l) => /^[A-Za-z0-9+/]+=*$/.test(l)) : undefined;
    if (r.code !== 0 || !printed) throw new Error(`no token (exit ${r.code}):\n${r.out}`);
    const decoded = decodeToken(printed);
    if (decoded.server !== `ws://localhost:${bridgePort}`) throw new Error(`the token names ${decoded.server}`);
    return `exit 0, token for ${decoded.server}`;
  });

  let token = "";
  await step("step 3: get a pairing token from the bridge's _webmcp_get-token tool", async () => {
    const { text } = textOf(await run.client!.callTool({ name: "_webmcp_get-token", arguments: {} }));
    token = text.trim().split(/\r?\n/).pop()!.trim();
    const decoded = decodeToken(token);
    if (decoded.server !== `ws://localhost:${bridgePort}` || !decoded.token) {
      throw new Error(`the token does not name ws://localhost:${bridgePort}: ${JSON.stringify({ server: decoded.server })}`);
    }
    return `token for ${decoded.server}`;
  });

  await step("step 4: the widget mounts on the landing in Chrome, shows its step, and takes the token", async () => {
    const executablePath = process.env["CHROME_PATH"];
    try {
      run.browser = await chromium.launch(executablePath ? { executablePath, headless: true } : { channel: "chrome", headless: true });
    } catch (e) {
      throw new Error(
        `could not start Chrome (${e instanceof Error ? e.message.split("\n")[0] : String(e)}). ` +
          `Install Google Chrome or set CHROME_PATH; this script never downloads a browser.`,
      );
    }
    const tab = await run.browser.newPage();
    tab.on("console", (m) => run.browserLog.push(`[console.${m.type()}] ${m.text()}`));
    tab.on("pageerror", (e) => run.browserLog.push(`[pageerror] ${e.message}`));
    await tab.goto(`${workerOrigin}${landingPath}`, { waitUntil: "load" });
    await tab.locator("#state-pair.active").waitFor({ state: "visible", timeout: 10_000 });
    await tab.locator("#webmcp-widget-step").waitFor({ state: "visible", timeout: 10_000 });
    if (await tab.locator("#webmcp-widget-error").isVisible()) throw new Error("the widget failure line is visible");
    await tab.locator("[data-webmcp-widget] .webmcp-trigger").click({ timeout: 10_000 });
    await tab.locator(".webmcp-token-input").fill(token);
    await tab.locator(".webmcp-connect-btn").click();
    await tab.locator(".webmcp-status", { hasText: "Connected to" }).waitFor({ timeout: 20_000 });
    const status = (await tab.locator(".webmcp-status").textContent())?.trim() ?? "";
    const warnings = run.browserLog.lines.filter((l) => l.includes("cf-webmcp: fallback widget"));
    if (warnings.length) throw new Error(`the widget init warned:\n${warnings.join("\n")}`);
    return `pairing state and the widget step shown, no failure line; widget says "${status}"`;
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

  await step("a landing whose widget script fails to load says so and hides the widget step", async () => {
    // A second tab in which the widget object does not arrive, as when R2 answers 503.
    const tab = await run.browser!.newPage();
    const warnings: string[] = [];
    tab.on("console", (m) => {
      if (m.type() === "warning") warnings.push(m.text());
    });
    await tab.route(`**/${WIDGET_ASSET}`, (route) => route.fulfill({ status: 503, body: "widget asset not found" }));
    await tab.goto(`${workerOrigin}${landingPath}`, { waitUntil: "load" });
    const line = tab.locator("#webmcp-widget-error");
    await line.waitFor({ state: "visible", timeout: 10_000 });
    const text = (await line.textContent())?.trim() ?? "";
    if (await tab.locator("#webmcp-widget-step").isVisible()) throw new Error("the widget step is visible although the widget did not load");
    if (!warnings.some((w) => w.includes("cf-webmcp: fallback widget"))) throw new Error(`no console warning: ${warnings.join(" | ")}`);
    await tab.close();
    return `status line "${text}"; widget step hidden; console warned`;
  });
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Every daemon PID the bridge homes name: a forked daemon is in no process tree of ours. */
function daemonPids(): number[] {
  return [...new Set(run.homes.map(daemonPidIn).filter((p): p is number => p !== null))];
}

/** Stops every process tree. Synchronous, so it also runs from the exit handler. */
function killAll(): void {
  if (run.transport?.pid) killTree(run.transport.pid);
  for (const pid of daemonPids()) if (isAlive(pid)) killTree(pid);
  for (const m of [...run.managed].reverse()) if (!hasExited(m.proc)) killTree(m.proc.pid);
}

let cleanedUp = false;
async function cleanup(): Promise<string[]> {
  if (cleanedUp) return [];
  cleanedUp = true;
  const problems: string[] = [];
  const daemons = daemonPids();
  if (run.browser) await run.browser.close().catch((e: unknown) => problems.push(`closing Chrome: ${String(e)}`));
  if (run.client) await Promise.race([run.client.close().catch(() => undefined), sleep(5000)]);
  killAll();
  await sleep(2000);

  const leftovers = run.managed.filter((m) => !hasExited(m.proc)).map((m) => `${m.name} (pid ${m.proc.pid})`);
  for (const pid of daemons) if (isAlive(pid)) leftovers.push(`bridge daemon (pid ${pid})`);
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
    ["bridge (daemon and MCP side)", run.bridgeLog],
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
console.log(`  ${cleanupProblems.length ? "FAIL" : "PASS"}  cleanup: every child process tree stopped, ports closed, src/generated rebuilt from the example-site TOML`);
for (const p of cleanupProblems) console.log(`        ${p}`);
if (failed) printLogs();
const ok = !failed && cleanupProblems.length === 0;
console.log(`\nRESULT: ${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
