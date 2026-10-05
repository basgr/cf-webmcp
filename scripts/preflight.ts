/**
 * Preflight: detect path collisions before deploy.
 *
 * Given a target webmcp.toml, fetches every Worker-claimed path from
 * [origin].base_url and reports OK / merge / COLLISION per path. It also POSTs a
 * JSON-RPC `initialize` to the landing path and warns when an origin MCP server
 * answers there.
 *
 * Usage:
 *   npm run preflight -- --config=templates/example-site/webmcp.toml
 *   npm run preflight -- --config=webmcp.toml --force   # do not exit non-zero
 *   npm run preflight -- --config=webmcp.toml --origin=https://origin.example.com
 *
 * Where it is valid:
 *   Preflight requests [origin].base_url as an ordinary client. It sees the
 *   origin's own answers only while that hostname is NOT routed through the
 *   Worker. Once it is, every request lands on the Worker and preflight reports
 *   the Worker's own responses (landing, manifest, merged files) back as
 *   collisions and merges. Run it before routing the hostname, or point it at a
 *   direct origin hostname with --origin.
 *
 * --origin=<url>:
 *   Overrides only the base URL the probes go to (an http(s) origin, no path, query,
 *   fragment or userinfo). The config, and so the config hash stored in the result,
 *   stays exactly what the build sees, so the result is not flagged stale. The deploy
 *   token headers go to that host and nowhere else; redirects are never followed.
 *
 * Token headers:
 *   If CF_WEBMCP_DEPLOY_TOKEN is set, preflight sends `cf-webmcp-bypass: 1` and
 *   `cf-webmcp-deploy-token`, the same headers the Worker puts on its own origin
 *   fetches, so the publisher's origin WAF rule that allows the Worker also lets
 *   preflight through. The Worker does not read these headers: it has no bypass
 *   mode and forwards nothing to origin because of them.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { ConfigSchema, type Config } from "../src/config-types.js";
import { configHashOf, resolveInherits } from "./build-config.js";

interface Args {
  configPath: string;
  force: boolean;
  /** --origin=<url>, validated later by parseOriginOverride. */
  origin: string | undefined;
}

interface PathCheck {
  label: string;
  url: URL;
  expect: "claim" | "merge";
}

type Outcome =
  | { kind: "ok"; status: number; contentType: string }
  | { kind: "merge"; status: number; contentType: string; hasMarker: boolean }
  | { kind: "collision"; status: number; contentType: string; reason: string }
  | { kind: "error"; reason: string };

export function parseArgs(argv: string[]): Args {
  let configPath = "webmcp.toml";
  let force = false;
  let origin: string | undefined;
  for (const a of argv) {
    if (a === "--force") force = true;
    else if (a.startsWith("--config=")) configPath = a.slice("--config=".length);
    else if (a.startsWith("--origin=")) origin = a.slice("--origin=".length);
  }
  return { configPath, force, origin };
}

/**
 * Validate the --origin value: an http(s) origin and nothing more. A path, query,
 * fragment or userinfo is refused, so the override can only change which host the
 * probes (and the deploy token) go to, never which paths they ask for.
 */
export function parseOriginOverride(value: string): URL {
  const refuse = (): never => {
    throw new Error(
      `--origin must be an http(s) origin without a path, such as https://origin.example.com, got ${JSON.stringify(value)}`,
    );
  };
  if (value.includes("?") || value.includes("#")) return refuse();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return refuse();
  if (!url.hostname || url.username || url.password || url.pathname !== "/") return refuse();
  return url;
}

/**
 * The URL a probe requests: `pathname` on `base`. Config paths cannot start with //
 * (PathString refuses them), but the deploy token goes out with every probe, so a
 * result that left `base`'s origin is an error here too, not a request.
 */
export function probeUrl(base: URL, pathname: string): URL {
  const url = new URL(pathname, base);
  if (url.origin !== base.origin) {
    throw new Error(`probe path ${JSON.stringify(pathname)} resolves to ${url.origin}, not ${base.origin}`);
  }
  return url;
}

async function loadConfig(p: string): Promise<Config> {
  const text = await fs.readFile(p, "utf8");
  const raw = TOML.parse(text) as Record<string, unknown>;
  // Resolve `inherits` exactly as the build does, so preflight inspects the same
  // merged config the Worker is built from and stamps the same config hash.
  const merged = await resolveInherits(raw, path.dirname(p));
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`config validation failed:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

/** The landing paths the router claims: the configured one and, for a directory-form path (/mcp/), the slash-less form it redirects. */
function landingPaths(config: Config): string[] {
  const landing = config.webmcp_landing.path;
  const paths = [landing];
  if (landing.endsWith("/") && landing.length > 1) paths.push(landing.slice(0, -1));
  return paths;
}

function pathsToCheck(config: Config, base: URL): PathCheck[] {
  const out: PathCheck[] = [];
  const claim = (p: string, expect: PathCheck["expect"]) => out.push({ label: p, url: probeUrl(base, p), expect });

  if (config.features.manifest) claim(config.manifest.path, "claim");
  if (config.features.webmcp_landing) {
    // Both forms: the Worker answers GET and HEAD on /mcp (a redirect) as well as on /mcp/.
    for (const p of landingPaths(config)) claim(p, "claim");
  }
  if (config.features.llms_txt && config.llms_txt.mode !== "passthrough") claim(config.llms_txt.path, "merge");
  if (config.features.robots_txt && config.robots_txt.mode !== "passthrough") claim(config.robots_txt.path, "merge");
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    claim(config.agents_md.path, "merge");
    for (const alias of config.agents_md.aliases) claim(alias, "claim");
  }
  if (config.features.api_catalog && config.api_catalog.mode !== "passthrough") claim(config.api_catalog.path, "claim");
  if (config.features.agent_skills && config.agent_skills.mode !== "passthrough") {
    claim(config.agent_skills.path, "merge");
    for (const alias of config.agent_skills.aliases) claim(alias, "claim");
  }
  if (config.features.agent_skills_index && config.agent_skills_index.mode !== "passthrough") {
    claim(config.agent_skills_index.path, "claim");
  }
  // Namespace probe - verifies origin does not serve anything under /_webmcp/.
  claim(`${config.paths.namespace}/__probe`, "claim");
  return out;
}

const MARKER_LLMS = "<!-- cf-webmcp:begin -->";
const MARKER_ROBOTS = "# cf-webmcp:begin";

/** Request headers for every preflight probe: a User-Agent, plus the token pair when a token is set. */
function originHeaders(deployToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": "cf-webmcp-preflight/1.0" };
  if (deployToken) {
    headers["cf-webmcp-bypass"] = "1";
    headers["cf-webmcp-deploy-token"] = deployToken;
  }
  return headers;
}

async function probe(check: PathCheck, deployToken: string | undefined): Promise<Outcome> {
  const headers = originHeaders(deployToken);
  try {
    const res = await fetch(check.url.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 404) {
      return { kind: "ok", status: 404, contentType: ct };
    }
    if (res.status >= 300 && res.status < 400) {
      return { kind: "ok", status: res.status, contentType: ct };
    }
    if (check.expect === "merge") {
      // For mergeable paths: 200 text is a merge, anything else is a collision.
      if (res.status === 200 && /^text\/(plain|markdown)/i.test(ct)) {
        const body = await res.text();
        // Markdown markers used by both llms.txt and agents.md; hash markers for robots.txt.
        const marker = check.label.endsWith("robots.txt") ? MARKER_ROBOTS : MARKER_LLMS;
        return { kind: "merge", status: 200, contentType: ct, hasMarker: body.includes(marker) };
      }
      return {
        kind: "collision",
        status: res.status,
        contentType: ct,
        reason: `expected text/plain or text/markdown for merge, got ${ct || "(unknown)"}`,
      };
    }
    // For claim paths: anything 200 is a collision.
    if (res.status === 200) {
      return {
        kind: "collision",
        status: 200,
        contentType: ct,
        reason: `origin already serves content here`,
      };
    }
    return { kind: "ok", status: res.status, contentType: ct };
  } catch (e) {
    return { kind: "error", reason: (e as Error).message };
  }
}

/** One MCP probe: the path it POSTs to, what came back. */
type McpOutcome =
  | { kind: "mcp"; status: number; contentType: string }
  | { kind: "none"; status: number; contentType: string }
  | { kind: "skipped"; reason: string };

/** The probe must not hang preflight on an origin that never answers a POST. */
const MCP_PROBE_TIMEOUT_MS = 10_000;

/** An MCP server answers an initialize with a JSON body or an event stream. */
const MCP_CONTENT_TYPE = /^(?:application\/json|text\/event-stream)\s*(?:;|$)/i;

/**
 * The landing paths an origin MCP server could be shadowed at: the configured path and,
 * for a directory-form path (/mcp/), the slash-less form the router redirects (/mcp),
 * which is where Cloudflare WebMCP Labs POSTs. Empty when the landing feature is off,
 * because then the Worker leaves the path to origin anyway.
 */
function mcpProbePaths(config: Config): string[] {
  return config.features.webmcp_landing ? landingPaths(config) : [];
}

async function packageVersion(): Promise<string> {
  try {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0";
  } catch {
    return "0";
  }
}

/**
 * POST a minimal JSON-RPC 2.0 `initialize` to `url`. A 200 with a JSON or event-stream
 * content type means an MCP server answers at that path on origin. Anything else, and
 * any network error, is "no MCP server": this probe never fails preflight. The body is
 * cancelled unread, so an event stream that stays open cannot hold the process.
 */
async function probeMcpServer(url: URL, deployToken: string | undefined, version: string): Promise<McpOutcome> {
  const headers = {
    ...originHeaders(deployToken),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "cf-webmcp-preflight", version },
    },
  });
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(MCP_PROBE_TIMEOUT_MS),
    });
    const contentType = res.headers.get("content-type") ?? "";
    await res.body?.cancel().catch(() => {});
    if (res.status === 200 && MCP_CONTENT_TYPE.test(contentType)) {
      return { kind: "mcp", status: res.status, contentType };
    }
    return { kind: "none", status: res.status, contentType };
  } catch (e) {
    return { kind: "skipped", reason: (e as Error).message };
  }
}

function formatMcpRow(label: string, outcome: McpOutcome): string {
  const row = `${label} (POST initialize)`.padEnd(34);
  switch (outcome.kind) {
    case "mcp":
      return `  ${row} ${String(outcome.status).padEnd(3)} ${outcome.contentType.padEnd(28)} → WARNING (an MCP server answers at origin)`;
    case "none":
      return `  ${row} ${String(outcome.status).padEnd(3)} ${outcome.contentType.padEnd(28)} → no MCP server`;
    case "skipped":
      return `  ${row} ERR                              → not checked (${outcome.reason})`;
  }
}

function formatRow(check: PathCheck, outcome: Outcome): string {
  const label = check.label.padEnd(34);
  switch (outcome.kind) {
    case "ok":
      return `  ${label} ${String(outcome.status).padEnd(3)} ${outcome.contentType.padEnd(28)} → claim OK`;
    case "merge":
      return `  ${label} 200 ${outcome.contentType.padEnd(28)} → merge (marker ${outcome.hasMarker ? "present, will replace" : "absent, will append"})`;
    case "collision":
      return `  ${label} ${String(outcome.status).padEnd(3)} ${outcome.contentType.padEnd(28)} → COLLISION (${outcome.reason})`;
    case "error":
      return `  ${label} ERR                              → ERROR (${outcome.reason})`;
  }
}

export interface PreflightOptions {
  /** Directory preflight.json is written to. Default: src/generated. */
  outDir?: string;
  /** Deploy token to send. Default: the CF_WEBMCP_DEPLOY_TOKEN environment variable. */
  deployToken?: string;
  /** Receives each output line. Default: console.log. */
  log?: (line: string) => void;
  /**
   * --origin: probe this http(s) origin instead of [origin].base_url. Validated by
   * parseOriginOverride. Only the probe target changes; the config and its hash do not.
   */
  origin?: string;
}

export async function runPreflight(configPath: string, force: boolean, opts: PreflightOptions = {}): Promise<number> {
  const absPath = path.resolve(configPath);
  // Validate the override first: nothing is read or requested for a bad value.
  const override = opts.origin === undefined ? undefined : parseOriginOverride(opts.origin);
  const config = await loadConfig(absPath);
  // Where the probes go. The config itself is never changed, so its hash is the build's.
  const base = override ?? new URL(config.origin.base_url);
  const checks = pathsToCheck(config, base);
  const deployToken = opts.deployToken ?? process.env["CF_WEBMCP_DEPLOY_TOKEN"];
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((line: string) => console.log(line));

  log(`preflight  ${base.host}  (token: ${deployToken ? "present" : "absent"})`);
  if (override) {
    log(`  --origin: probing ${override.origin} instead of [origin].base_url (${new URL(config.origin.base_url).origin}); the config hash is unchanged`);
  }

  let hardCollisions = 0;
  const collisions: string[] = [];
  const warnings: string[] = [];
  for (const check of checks) {
    const outcome = await probe(check, deployToken);
    log(formatRow(check, outcome));
    if (outcome.kind === "collision") {
      hardCollisions++;
      collisions.push(`${check.label}: ${outcome.reason}`);
    } else if (outcome.kind === "merge" && !outcome.hasMarker) {
      warnings.push(`${check.label}: merge marker absent at origin, will append on first deploy`);
    } else if (outcome.kind === "error") {
      warnings.push(`${check.label}: ${outcome.reason}`);
    }
  }

  // An origin MCP server at the landing path is not a collision: GET and HEAD requests
  // get the landing page unless their Accept header asks for text/event-stream, and
  // every other method goes to origin, so the server stays reachable for MCP clients.
  // It is worth a warning, because that is a change from the days the landing answered
  // every method.
  const version = await packageVersion();
  for (const landingPath of mcpProbePaths(config)) {
    const outcome = await probeMcpServer(probeUrl(base, landingPath), deployToken, version);
    log(formatMcpRow(landingPath, outcome));
    if (outcome.kind === "mcp") {
      warnings.push(
        `${landingPath}: an MCP server answers here at origin (POST initialize returned 200 ${outcome.contentType}). ` +
          `On the Worker, GET and HEAD requests get the landing page unless their Accept header asks for text/event-stream; ` +
          `every other method goes to origin, so MCP clients keep reaching that server.`,
      );
    }
  }

  // Persist the result so build-config.ts can embed it into the generated
  // config module. The Worker surfaces this on /_webmcp/health.preflight.
  // The hash comes from the build's own function over the same resolved config.
  await writePreflightResult(
    {
      ran_at: new Date().toISOString(),
      collisions,
      warnings,
      config_hash: configHashOf(config),
    },
    opts.outDir,
  );

  log("");
  if (hardCollisions === 0) {
    log(`preflight  OK`);
    return 0;
  }
  if (force) {
    log(`preflight  ${hardCollisions} hard collision(s), continuing anyway (--force)`);
    return 0;
  }
  log(`preflight  ${hardCollisions} hard collision(s), exit non-zero. Override with --force.`);
  return 1;
}

async function writePreflightResult(
  result: {
    ran_at: string;
    collisions: string[];
    warnings: string[];
    config_hash: string;
  },
  outDirOverride?: string,
): Promise<void> {
  const outDir =
    outDirOverride ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "generated");
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "preflight.json"), JSON.stringify(result, null, 2) + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const code = await runPreflight(args.configPath, args.force, { origin: args.origin });
  process.exit(code);
}

const __thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === __thisFile) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
}
