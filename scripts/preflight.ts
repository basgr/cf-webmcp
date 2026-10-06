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
 *   npm run preflight -- --config webmcp.toml --origin https://origin.example.com   # same, with spaces
 *
 * Arguments: --config, --origin and --force, nothing else. --config and --origin take a
 * value, written `--flag=value` or `--flag value`. An unknown flag, a stray argument, a flag
 * without a value and a flag given twice are usage errors: the message goes to stderr and the
 * exit code is 2, before any config is read or request sent. Exit codes: 0 OK (or --force),
 * 1 hard collisions, 2 usage or config error.
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
 *   token headers go to that host and nowhere else, and only when [origin].allowed_origins
 *   lists it; redirects are never followed.
 *
 * Token headers:
 *   If CF_WEBMCP_DEPLOY_TOKEN is set, preflight sends `cf-webmcp-bypass: 1` and
 *   `cf-webmcp-deploy-token`, the same headers the Worker puts on its own origin
 *   fetches, so the publisher's origin WAF rule that allows the Worker also lets
 *   preflight through. The Worker does not read these headers: it has no bypass
 *   mode and forwards nothing to origin because of them. Like the Worker, preflight
 *   sends them only to an origin in [origin].allowed_origins: a base_url outside the list
 *   fails with the build's own error before any request, and an --origin host outside it
 *   is probed without them. It warns when they would go over plain http to a host that is
 *   not localhost, and when the token is one the Worker cannot reliably take out of its
 *   answers: under 32 characters, or with a character outside A-Z, a-z, 0-9, _ and -
 *   (deployTokenWeakness).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { ConfigSchema, type Config } from "../src/config-types.js";
import { ARD_PREDECESSOR_PATH, isArdContentType, isArdDocument } from "../src/ard.js";
import { MERGE_MAX_BYTES, declaredLength, readCapped } from "../src/routes/read-capped.js";
import { isTextish as isLlmsContentType } from "../src/routes/llms-txt.js";
import { isTextish as isAgentsContentType } from "../src/routes/agents-md.js";
import { isTextish as isRobotsContentType } from "../src/routes/robots-txt.js";
import { isMarkdownish as isSkillContentType } from "../src/routes/agent-skills.js";
import { isLinksetContentType, parseLinkset } from "../src/routes/api-catalog.js";
import { apiCatalogServed, skillsIndexServed } from "../src/served.js";
import { MIN_REDACTED_LENGTH } from "../src/redact.js";
import { MAX_JSON_DEPTH, parseOriginJson } from "../src/origin-json.js";
import { preflightUserAgent } from "../src/user-agent.js";
import { checkBaseUrlAllowed, configHashOf, resolveInherits } from "./build-config.js";

interface Args {
  configPath: string;
  force: boolean;
  /** --origin=<url>, validated later by parseOriginOverride. */
  origin: string | undefined;
}

interface PathCheck {
  label: string;
  url: URL;
  /**
   * claim: any 200 is a collision (the Worker answers there, or redirects). merge: a 200 text
   * file the Worker merges into, judged with `text`. merge_json: a 200 ARD document the Worker
   * merges into (the ARD manifest in merge mode). merge_linkset: a 200 RFC 9264 linkset the
   * Worker merges into (the API catalog in merge mode).
   *
   * A document is a merge row only in a mode where the Worker fetches origin's file to merge into
   * it: merge mode, and always for robots.txt. In synthesize and replace mode the Worker answers
   * without fetching, so a file at origin is shadowed: a claim.
   */
  expect: "claim" | "merge" | "merge_json" | "merge_linkset";
  /** For `merge`: the Worker's own content-type test for the route, what it names, and the marker of its block. */
  text?: TextMerge;
  /**
   * The ARD manifest in merge mode: its canonical path, or the predecessor path
   * the merge reads only after a 404 at the canonical one (`redirected`: the
   * predecessor is also an alias the Worker 301s to the canonical path).
   */
  ard?: { role: "canonical" } | { role: "predecessor"; canonical: string; redirected: boolean };
}

/** How one text merge route reads origin's file: the Worker's own test, so preflight cannot judge differently. */
interface TextMerge {
  accepts: (contentType: string | null) => boolean;
  /** The content types it merges into, for the collision message. */
  accepted: string;
  marker: string;
}

const MARKER_LLMS = "<!-- cf-webmcp:begin -->";
const MARKER_ROBOTS = "# cf-webmcp:begin";

const TEXT_LLMS: TextMerge = { accepts: isLlmsContentType, accepted: "text/plain or text/markdown", marker: MARKER_LLMS };
const TEXT_AGENTS: TextMerge = { accepts: isAgentsContentType, accepted: "text/plain or text/markdown", marker: MARKER_LLMS };
const TEXT_ROBOTS: TextMerge = { accepts: isRobotsContentType, accepted: "text/plain", marker: MARKER_ROBOTS };
const TEXT_SKILL: TextMerge = {
  accepts: isSkillContentType,
  accepted: "text/plain, text/markdown or text/x-markdown",
  marker: MARKER_LLMS,
};

type Outcome =
  | { kind: "ok"; status: number; contentType: string }
  | { kind: "merge"; status: number; contentType: string; hasMarker: boolean }
  | { kind: "merge_json"; status: number; contentType: string; valid: boolean }
  | { kind: "merge_linkset"; status: number; contentType: string; valid: boolean }
  /** merge_json path answering neither 200, 404 nor 3xx: the Worker serves its generated document. */
  | { kind: "fallback"; status: number; contentType: string }
  /**
   * A mergeable 200 over the Worker's 1 MiB merge cap (MERGE_MAX_BYTES): the Worker relays it
   * unchanged and adds nothing, whatever it holds. `what` names it in the warning.
   */
  | { kind: "too_large"; status: number; contentType: string; what: "document" | "file" }
  /** The ARD predecessor path, not read because origin answers at the canonical path. */
  | { kind: "not_merged"; status: number; contentType: string; canonical: string; redirected: boolean }
  | { kind: "collision"; status: number; contentType: string; reason: string }
  | { kind: "error"; reason: string };

/** The accepted arguments, named in every usage error. */
const USAGE = "usage: preflight [--config=<path> | --config <path>] [--origin=<url> | --origin <url>] [--force]";

/**
 * The command line: `--config`, `--origin` and `--force`, and nothing else. A value is
 * written `--flag=value` or `--flag value`; a next argument that starts with `--` is never
 * taken as a value, so a flag left without one is an error and not a swallowed neighbour.
 * An unknown flag, a positional argument, an empty value and a flag given twice all throw
 * (the CLI exits 2 on any throw): a mistyped flag must not run a preflight against the
 * default config or origin and report that as the answer.
 */
export function parseArgs(argv: string[]): Args {
  let configPath: string | undefined;
  let force = false;
  let origin: string | undefined;
  const fail = (message: string): never => {
    throw new Error(`${message}\n${USAGE}`);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--force") {
      if (force) return fail("--force was given more than once");
      force = true;
      continue;
    }
    const flag = arg === "--config" || arg.startsWith("--config=") ? "--config" : arg === "--origin" || arg.startsWith("--origin=") ? "--origin" : null;
    if (flag === null) return fail(`unknown argument ${JSON.stringify(arg)}`);
    let value: string | undefined;
    if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value === "") return fail(`${flag} needs a value: ${flag}=<value> or ${flag} <value>`);
    if ((flag === "--config" ? configPath : origin) !== undefined) return fail(`${flag} was given more than once`);
    if (flag === "--config") configPath = value;
    else origin = value;
  }
  return { configPath: configPath ?? "webmcp.toml", force, origin };
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

/** localhost, a name under .localhost, or a loopback address: where plain http does not cross a network. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
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
  // A text file is a merge row only in merge mode (robots.txt, which has no other served mode, always).
  const text = (p: string, merge: boolean, how: TextMerge) =>
    merge ? out.push({ label: p, url: probeUrl(base, p), expect: "merge", text: how }) : claim(p, "claim");

  if (config.features.llms_txt && config.llms_txt.mode !== "passthrough") {
    text(config.llms_txt.path, config.llms_txt.mode === "merge", TEXT_LLMS);
  }
  if (config.features.robots_txt && config.robots_txt.mode !== "passthrough") text(config.robots_txt.path, true, TEXT_ROBOTS);
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    text(config.agents_md.path, config.agents_md.mode === "merge", TEXT_AGENTS);
    for (const alias of config.agents_md.aliases) claim(alias, "claim");
  }
  // Not served (so not probed) with the manifest off: src/served.ts.
  if (apiCatalogServed(config)) {
    if (config.api_catalog.mode === "merge") {
      out.push({ label: config.api_catalog.path, url: probeUrl(base, config.api_catalog.path), expect: "merge_linkset" });
    } else {
      claim(config.api_catalog.path, "claim");
    }
  }
  if (config.features.ai_catalog && config.ai_catalog.mode !== "passthrough") {
    // In merge mode the Worker merges into origin's ARD document at the path, or
    // at the predecessor path when origin answers 404 at the path, so a JSON
    // document at either is a merge. Every other alias is only ever redirected: a
    // claim. The canonical path is probed first: the predecessor's row depends on it.
    const { path: canonical, aliases } = config.ai_catalog;
    const merge = config.ai_catalog.mode === "merge";
    const paths = new Set([canonical, ...aliases]);
    if (merge) paths.add(ARD_PREDECESSOR_PATH);
    for (const p of paths) {
      if (!merge || (p !== canonical && p !== ARD_PREDECESSOR_PATH)) {
        claim(p, "claim");
        continue;
      }
      out.push({
        label: p,
        url: probeUrl(base, p),
        expect: "merge_json",
        ard:
          p === canonical
            ? { role: "canonical" }
            : { role: "predecessor", canonical, redirected: aliases.includes(ARD_PREDECESSOR_PATH) },
      });
    }
  }
  if (config.features.agent_skills && config.agent_skills.mode !== "passthrough") {
    text(config.agent_skills.path, config.agent_skills.mode === "merge", TEXT_SKILL);
    for (const alias of config.agent_skills.aliases) claim(alias, "claim");
  }
  // Not served (so not probed) without a digest to list: src/served.ts.
  if (skillsIndexServed(config)) claim(config.agent_skills_index.path, "claim");
  // Namespace probe - verifies origin does not serve anything under /_webmcp/.
  claim(`${config.paths.namespace}/__probe`, "claim");
  return out;
}

/**
 * Request headers for every preflight probe: a User-Agent naming cf-webmcp's package version
 * (the Worker's own is cf-webmcp/<version>), plus the token pair when a token is set.
 */
function originHeaders(deployToken: string | undefined, version: string): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": preflightUserAgent(version) };
  if (deployToken) {
    headers["cf-webmcp-bypass"] = "1";
    headers["cf-webmcp-deploy-token"] = deployToken;
  }
  return headers;
}

/**
 * A 200 body for a merge row: its bytes, or "too_large" when it is over the Worker's cap. The
 * test is the Worker's own (declaredLength, then readCapped from src/routes/read-capped.ts):
 * a Content-Length over the cap decides without reading, otherwise the body is read until it
 * passes the cap. Either way the rest of an oversize body is cancelled unread.
 */
async function readForMerge(res: Response): Promise<Uint8Array | "too_large"> {
  if (declaredLength(res) > MERGE_MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    return "too_large";
  }
  const read = await readCapped(res.body, MERGE_MAX_BYTES);
  if (read.kind === "too_large") {
    await read.rest.cancel().catch(() => {});
    return "too_large";
  }
  return read.bytes;
}

/**
 * How long one GET probe may take, its body included: an origin that never answers, or sends its
 * headers and then never finishes the body, must not hang preflight. The row is an error then.
 */
const PROBE_TIMEOUT_MS = 10_000;

/** Whether `e` is the rejection of a request whose AbortSignal.timeout fired. */
function isTimeout(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "TimeoutError";
}

async function probe(check: PathCheck, deployToken: string | undefined, version: string): Promise<Outcome> {
  const headers = originHeaders(deployToken, version);
  try {
    const res = await fetch(check.url.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      // Also ends a body read that stalls: the body stream errors when the signal fires.
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    const ct = res.headers.get("content-type") ?? "";
    if (res.status === 404) {
      return { kind: "ok", status: 404, contentType: ct };
    }
    if (res.status >= 300 && res.status < 400) {
      return { kind: "ok", status: res.status, contentType: ct };
    }
    if (check.expect === "merge_json") {
      // The Worker's own rule (src/routes/ai-catalog.ts): a 200 declared as JSON is
      // merged into when it is an ARD document and relayed unchanged when it is
      // not; any other 200 is relayed. Text or HTML here is a collision.
      if (res.status === 200 && isArdContentType(ct)) {
        // Size first, as in the Worker: a document over the cap is relayed whatever it holds.
        const bytes = await readForMerge(res);
        if (bytes === "too_large") return { kind: "too_large", status: 200, contentType: ct, what: "document" };
        // Parsed as the Worker parses it (src/origin-json.ts): JSON nested more than 64 levels
        // deep is relayed unchanged, like JSON that is not an ARD document.
        const json = parseOriginJson(new TextDecoder().decode(bytes));
        if (!json.ok && json.reason === "syntax") {
          return {
            kind: "collision",
            status: 200,
            contentType: ct,
            reason: `origin answers 200 ${ct || "(no content type)"} but the body is not JSON`,
          };
        }
        return { kind: "merge_json", status: 200, contentType: ct, valid: json.ok && isArdDocument(json.value) };
      }
      if (res.status !== 200) {
        // Not a document of origin's the Worker would shadow: on any other answer
        // the merge falls back to the generated document. A warning, not a collision.
        return { kind: "fallback", status: res.status, contentType: ct };
      }
      return {
        kind: "collision",
        status: res.status,
        contentType: ct,
        reason: `expected an application/json ARD document for merge, got ${ct || "(unknown)"}`,
      };
    }
    if (check.expect === "merge_linkset") {
      // The Worker's own rule (src/routes/api-catalog.ts): a 200 declared as a linkset (or as JSON, or
      // with no content type) is merged into when it parses as one, and replaced by the generated
      // catalog when it does not; any other answer is relayed, so our entry never appears.
      if (res.status === 200 && isLinksetContentType(ct)) {
        const bytes = await readForMerge(res);
        if (bytes === "too_large") return { kind: "too_large", status: 200, contentType: ct, what: "document" };
        return { kind: "merge_linkset", status: 200, contentType: ct, valid: parseLinkset(new TextDecoder().decode(bytes)) !== null };
      }
      return {
        kind: "collision",
        status: res.status,
        contentType: ct,
        reason: `expected a linkset (application/linkset+json or application/json) for merge, got ${ct || "(unknown)"}`,
      };
    }
    if (check.expect === "merge" && check.text) {
      // For mergeable paths: a 200 of a type the Worker merges into is a merge, anything else is a collision.
      if (res.status === 200 && check.text.accepts(ct)) {
        const bytes = await readForMerge(res);
        if (bytes === "too_large") return { kind: "too_large", status: 200, contentType: ct, what: "file" };
        const body = new TextDecoder().decode(bytes);
        return { kind: "merge", status: 200, contentType: ct, hasMarker: body.includes(check.text.marker) };
      }
      return {
        kind: "collision",
        status: res.status,
        contentType: ct,
        reason: `expected ${check.text.accepted} for merge, got ${ct || "(unknown)"}`,
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
    if (isTimeout(e)) return { kind: "error", reason: `no answer within ${PROBE_TIMEOUT_MS / 1000} s` };
    return { kind: "error", reason: (e as Error).message };
  }
}

/**
 * Whether the merge stops at this answer from the canonical ARD path, so the
 * predecessor path is never read: anything but a 404 (a redirect is followed by
 * the Worker and may end in one, so it counts as unknown).
 */
function isAnswerTheMergeKeeps(status: number): boolean {
  return status !== 404 && !(status >= 300 && status < 400);
}

/**
 * The predecessor path's outcome when the merge does not read it. A collision,
 * merge or fallback there means nothing then: the row says it is not merged.
 * Nothing at all there (404, a redirect, a failed probe) stays as it was.
 */
function notMerged(outcome: Outcome, ard: { canonical: string; redirected: boolean }): Outcome {
  if (outcome.kind === "error" || outcome.kind === "ok") return outcome;
  return { kind: "not_merged", status: outcome.status, contentType: outcome.contentType, canonical: ard.canonical, redirected: ard.redirected };
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
    ...originHeaders(deployToken, version),
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
    case "merge_json":
      return `  ${label} 200 ${outcome.contentType.padEnd(28)} → ${outcome.valid ? "merge (ARD manifest, our entry is added unless origin lists its identifier or url)" : "merge refused (not an ARD manifest, relayed unchanged)"}`;
    case "merge_linkset":
      return `  ${label} 200 ${outcome.contentType.padEnd(28)} → ${outcome.valid ? "merge (linkset, our entry is added)" : "WARNING (not an RFC 9264 linkset, the Worker serves the generated catalog instead)"}`;
    case "fallback":
      return `  ${label} ${String(outcome.status).padEnd(3)} ${outcome.contentType.padEnd(28)} → WARNING (the Worker serves the generated document)`;
    case "too_large":
      return `  ${label} ${String(outcome.status).padEnd(3)} ${outcome.contentType.padEnd(28)} → WARNING (too large to merge, relayed unchanged)`;
    case "not_merged":
      return `  ${label} ${String(outcome.status).padEnd(3)} ${outcome.contentType.padEnd(28)} → ${
        outcome.redirected
          ? `redirected to ${outcome.canonical}, not merged`
          : `not merged (not read, origin answers at ${outcome.canonical})`
      }`;
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

/**
 * Why `token` is a poor deploy token for the Worker's redaction (src/redact.ts), as a phrase
 * after "CF_WEBMCP_DEPLOY_TOKEN", or null when it is a good one or there is none. Good: 32 or
 * more characters of A-Z, a-z, 0-9, _ and -, the characters that percent-encoding, JSON, the
 * URL parser and HTML leave as they are, so the value as written is the only form an echo of it
 * can take. Never names the token or its length.
 */
export function deployTokenWeakness(token: string | undefined): string | null {
  if (!token) return null;
  const reasons: string[] = [];
  if (token.length < 32) reasons.push("is shorter than 32 characters");
  if (!/^[A-Za-z0-9_-]*$/.test(token)) reasons.push("has characters outside A-Z, a-z, 0-9, _ and -");
  return reasons.length === 0 ? null : reasons.join(" and ");
}

export async function runPreflight(configPath: string, force: boolean, opts: PreflightOptions = {}): Promise<number> {
  const absPath = path.resolve(configPath);
  // Validate the override first: nothing is read or requested for a bad value.
  const override = opts.origin === undefined ? undefined : parseOriginOverride(opts.origin);
  const config = await loadConfig(absPath);
  // The build refuses a base_url outside allowed_origins, and so does preflight, with the same
  // error and before any request: the Worker would never send the token there.
  checkBaseUrlAllowed(config);
  // Where the probes go. The config itself is never changed, so its hash is the build's.
  const base = override ?? new URL(config.origin.base_url);
  const checks = pathsToCheck(config, base);
  const configuredToken = opts.deployToken ?? process.env["CF_WEBMCP_DEPLOY_TOKEN"];
  // The token goes only to an origin the Worker may send it to: an --origin host that
  // allowed_origins does not list is probed without it.
  const listed = config.origin.allowed_origins.some((u) => new URL(u).origin === base.origin);
  const deployToken = configuredToken && listed ? configuredToken : undefined;
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((line: string) => console.log(line));

  const version = await packageVersion();
  const tokenState = deployToken ? "present" : configuredToken ? "withheld" : "absent";
  log(`preflight  ${base.host}  (token: ${tokenState})`);
  if (override) {
    log(`  --origin: probing ${override.origin} instead of [origin].base_url (${new URL(config.origin.base_url).origin}); the config hash is unchanged`);
  }
  if (tokenState === "withheld") {
    log(
      `  token: withheld, because ${base.origin} is not in [origin].allowed_origins; the probes go without the deploy-token ` +
        `headers. List the origin there if it should get them.`,
    );
  }
  if (deployToken && base.protocol === "http:" && !isLoopbackHost(base.hostname)) {
    log(
      `  WARNING: the deploy token goes to ${base.host} over plain http, readable on the way. Use https, ` +
        `or run preflight against localhost.`,
    );
  }
  // About the token itself, so also when it is withheld here: the Worker sends the same one.
  const weakness = deployTokenWeakness(configuredToken);
  if (weakness !== null) {
    log(
      `  WARNING: CF_WEBMCP_DEPLOY_TOKEN ${weakness}. The Worker takes the token out of what it answers only as ` +
        `written and as JSON writes it, and not at all under ${MIN_REDACTED_LENGTH} characters, so an origin that ` +
        `echoes it percent-encoded, with a \\/ escape or in a URL the Worker writes again can hand it to a client. ` +
        `Use 32 or more characters of A-Z, a-z, 0-9, _ and -, which no such encoding changes: \`openssl rand -hex 32\`.`,
    );
  }

  let hardCollisions = 0;
  const collisions: string[] = [];
  const warnings: string[] = [];
  // The merge reads the ARD predecessor path only after a 404 at the canonical
  // path; the canonical check comes first in `checks`.
  let ardCanonicalStatus: number | null = null;
  for (const check of checks) {
    let outcome = await probe(check, deployToken, version);
    if (check.ard?.role === "canonical") {
      ardCanonicalStatus = outcome.kind === "error" ? null : outcome.status;
    } else if (check.ard?.role === "predecessor" && ardCanonicalStatus !== null && isAnswerTheMergeKeeps(ardCanonicalStatus)) {
      outcome = notMerged(outcome, check.ard);
    }
    log(formatRow(check, outcome));
    if (outcome.kind === "collision") {
      hardCollisions++;
      collisions.push(`${check.label}: ${outcome.reason}`);
    } else if (outcome.kind === "merge" && !outcome.hasMarker) {
      warnings.push(`${check.label}: merge marker absent at origin, will append on first deploy`);
    } else if (outcome.kind === "merge_json" && !outcome.valid) {
      warnings.push(
        `${check.label}: origin's JSON is not an ARD manifest (an object with an entries array of objects with a string identifier, ` +
          `nested at most ${MAX_JSON_DEPTH} levels deep); the Worker relays it unchanged and adds no entry`,
      );
    } else if (outcome.kind === "merge_linkset" && !outcome.valid) {
      warnings.push(
        `${check.label}: origin's JSON is not an RFC 9264 linkset (an object with a linkset array of objects with a string anchor, ` +
          `nested at most ${MAX_JSON_DEPTH} levels deep); the Worker serves its generated catalog instead of it`,
      );
    } else if (outcome.kind === "too_large") {
      warnings.push(
        `${check.label}: origin's ${outcome.what} is over 1 MiB, too large to merge, relayed unchanged; ` +
          `the Worker adds no ${outcome.what === "document" ? "entry" : "block"}`,
      );
    } else if (outcome.kind === "fallback") {
      warnings.push(`${check.label}: origin answers ${outcome.status}; in merge mode the Worker serves the generated document instead`);
    } else if (outcome.kind === "not_merged" && outcome.redirected && outcome.status === 200) {
      warnings.push(
        `${check.label}: origin serves a document here too, but the Worker redirects this path to ${outcome.canonical} ` +
          `and does not merge it`,
      );
    } else if (outcome.kind === "error") {
      warnings.push(`${check.label}: ${outcome.reason}`);
    }
  }

  // An origin MCP server at the landing path is not a collision: GET and HEAD requests
  // get the landing page unless their Accept header asks for text/event-stream, and
  // every other method goes to origin, so the server stays reachable for MCP clients.
  // It is worth a warning, because that is a change from the days the landing answered
  // every method.
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
