/**
 * Preflight: detect path collisions before deploy.
 *
 * Given a target webmcp.toml, fetches every Worker-claimed path directly from
 * origin (bypassing the Worker) and reports OK / merge / COLLISION per path.
 *
 * Usage:
 *   npm run preflight -- --config=templates/example-site/webmcp.toml
 *   npm run preflight -- --config=webmcp.toml --force   # do not exit non-zero
 *
 * Bypass mechanism:
 *   - If CF_WEBMCP_DEPLOY_TOKEN is set, sends `cf-webmcp-bypass: 1` plus the
 *     token header so the Worker forwards the request to origin unmodified.
 *   - If not set, fetches the origin's [origin].base_url directly (typical
 *     for initial deploys before DNS is routed through CF).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";
import { ConfigSchema, type Config } from "../src/config-types.js";

interface Args {
  configPath: string;
  force: boolean;
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

function parseArgs(argv: string[]): Args {
  let configPath = "webmcp.toml";
  let force = false;
  for (const a of argv) {
    if (a === "--force") force = true;
    else if (a.startsWith("--config=")) configPath = a.slice("--config=".length);
  }
  return { configPath, force };
}

async function loadConfig(p: string): Promise<Config> {
  const text = await fs.readFile(p, "utf8");
  const raw = TOML.parse(text) as Record<string, unknown>;
  // Strip `inherits` (preflight does not resolve inheritance; it inspects
  // declared paths in the target file).
  delete raw["inherits"];
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`config validation failed:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}

function pathsToCheck(config: Config): PathCheck[] {
  const base = new URL(config.origin.base_url);
  const out: PathCheck[] = [];

  if (config.features.manifest) {
    out.push({ label: config.manifest.path, url: new URL(config.manifest.path, base), expect: "claim" });
  }
  if (config.features.webmcp_landing) {
    out.push({ label: config.webmcp_landing.path, url: new URL(config.webmcp_landing.path, base), expect: "claim" });
  }
  if (config.features.llms_txt && config.llms_txt.mode !== "passthrough") {
    out.push({ label: config.llms_txt.path, url: new URL(config.llms_txt.path, base), expect: "merge" });
  }
  if (config.features.robots_txt && config.robots_txt.mode !== "passthrough") {
    out.push({ label: config.robots_txt.path, url: new URL(config.robots_txt.path, base), expect: "merge" });
  }
  if (config.features.agents_md && config.agents_md.mode !== "passthrough") {
    out.push({ label: config.agents_md.path, url: new URL(config.agents_md.path, base), expect: "merge" });
    for (const alias of config.agents_md.aliases) {
      out.push({ label: alias, url: new URL(alias, base), expect: "claim" });
    }
  }
  // Namespace probe - verifies origin does not serve anything under /_webmcp/.
  out.push({
    label: `${config.paths.namespace}/__probe`,
    url: new URL(`${config.paths.namespace}/__probe`, base),
    expect: "claim",
  });
  return out;
}

const MARKER_LLMS = "<!-- cf-webmcp:begin -->";
const MARKER_ROBOTS = "# cf-webmcp:begin";

async function probe(check: PathCheck, deployToken: string | undefined): Promise<Outcome> {
  const headers: Record<string, string> = { "user-agent": "cf-webmcp-preflight/1.0" };
  if (deployToken) {
    headers["cf-webmcp-bypass"] = "1";
    headers["cf-webmcp-deploy-token"] = deployToken;
  }
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

export async function runPreflight(configPath: string, force: boolean): Promise<number> {
  const absPath = path.resolve(configPath);
  const config = await loadConfig(absPath);
  const checks = pathsToCheck(config);
  const deployToken = process.env["CF_WEBMCP_DEPLOY_TOKEN"];

  // eslint-disable-next-line no-console
  console.log(`preflight  ${new URL(config.origin.base_url).host}  (token: ${deployToken ? "present" : "absent"})`);

  let hardCollisions = 0;
  for (const check of checks) {
    const outcome = await probe(check, deployToken);
    // eslint-disable-next-line no-console
    console.log(formatRow(check, outcome));
    if (outcome.kind === "collision") hardCollisions++;
  }

  // eslint-disable-next-line no-console
  console.log("");
  if (hardCollisions === 0) {
    // eslint-disable-next-line no-console
    console.log(`preflight  OK`);
    return 0;
  }
  if (force) {
    // eslint-disable-next-line no-console
    console.log(`preflight  ${hardCollisions} hard collision(s), continuing anyway (--force)`);
    return 0;
  }
  // eslint-disable-next-line no-console
  console.log(`preflight  ${hardCollisions} hard collision(s), exit non-zero. Override with --force.`);
  return 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const code = await runPreflight(args.configPath, args.force);
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
