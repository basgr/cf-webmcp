import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The User-Agent of cf-webmcp's requests to origin names the package version, and is built in
 * ONE place: src/user-agent.ts (userAgent and preflightUserAgent). Every other source file takes
 * the string from there. A User-Agent put together anywhere else, from a literal version, a
 * template, a constant or a concatenation, is how "cf-webmcp/1.0" outlived four releases:
 *
 *   const VERSION = "1.0";
 *   "user-agent": `cf-webmcp/${VERSION}`
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SINGLE_SOURCE = path.join("src", "user-agent.ts");

/**
 * Lines that build a cf-webmcp User-Agent by hand: `cf-webmcp/` or `cf-webmcp-preflight/` followed
 * by a digit (a literal version), a `${` (a template), or a quote and a `+` (a concatenation), and
 * the name split from its slash by a concatenation. `transport: "cf-webmcp/1"` is the manifest's
 * transport id, not a User-Agent.
 */
export function handBuiltUserAgents(text: string): string[] {
  const forms = [
    /cf-webmcp(?:-preflight)?\/(?:\d|\$\{|["'`]\s*\+)/,
    /cf-webmcp(?:-preflight)?["'`]\s*\+\s*["'`]\//,
  ];
  return text
    .split("\n")
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => forms.some((f) => f.test(line)) && !/transport/.test(line))
    .map(({ line, n }) => `${n}: ${line}`);
}

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "generated" || entry.name === "e2e") continue;
      out.push(...(await sources(rel)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(rel);
    }
  }
  return out;
}

describe("the detector", () => {
  it.each([
    ["a literal version", '"user-agent": "cf-webmcp/1.0",'],
    ["the form of the original bug, a template over a constant", '"user-agent": `cf-webmcp/${VERSION}`,'],
    ["a template over a variable", "headers[\"user-agent\"] = `cf-webmcp-preflight/${version}`;"],
    ["a concatenation after the slash", "const ua = 'cf-webmcp/' + version;"],
    ["a concatenation in double quotes", 'const ua = "cf-webmcp-preflight/" + v;'],
    ["a name split from its slash", 'const ua = "cf-webmcp" + "/" + version;'],
    ["a backtick concatenation", "const ua = `cf-webmcp/` + version;"],
  ])("flags %s", (_label, line) => {
    expect(handBuiltUserAgents(`const x = 1;\n${line}\n`)).toHaveLength(1);
  });

  it("flags the parent commit's executors/common.ts form, as a whole file", () => {
    const common = [
      'import { err } from "../envelope";',
      "",
      'const VERSION = "1.0";',
      "",
      "export function originFetch() {",
      "  const headers: Record<string, string> = {",
      "    \"user-agent\": `cf-webmcp/${VERSION}`,",
      "  };",
      "}",
    ].join("\n");
    expect(handBuiltUserAgents(common)).toEqual(['7: "user-agent": `cf-webmcp/${VERSION}`,']);
  });

  it.each([
    ["the manifest's transport id", 'transport: "cf-webmcp/1",'],
    ["a call of the one builder", '"user-agent": userAgent(ctx.version),'],
    ["a comment naming the shape", " * set a stable User-Agent (cf-webmcp/<package version>), attach the token"],
    ["a header name", 'headers["cf-webmcp-bypass"] = "1";'],
    ["the name without a slash", 'console.error(`cf-webmcp: proxy origin fetch failed`);'],
    ["the cache key path", "`https://${domain}/__webmcp-cache/${segments}`"],
  ])("leaves %s alone", (_label, line) => {
    expect(handBuiltUserAgents(line)).toEqual([]);
  });
});

describe("User-Agent", () => {
  it("is built in src/user-agent.ts only, in every other source file", async () => {
    const files = [...(await sources("src")), ...(await sources("scripts"))].filter((f) => f !== SINGLE_SOURCE);
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(path.join(root, file), "utf8");
      for (const hit of handBuiltUserAgents(text)) offenders.push(`${file}:${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it("is produced by the one module in the Worker and in preflight, with the package version", async () => {
    const userAgentTs = await fs.readFile(path.join(root, SINGLE_SOURCE), "utf8");
    const common = await fs.readFile(path.join(root, "src", "executors", "common.ts"), "utf8");
    const handler = await fs.readFile(path.join(root, "src", "handler.ts"), "utf8");
    const preflight = await fs.readFile(path.join(root, "scripts", "preflight.ts"), "utf8");
    // The one place that builds them.
    expect(handBuiltUserAgents(userAgentTs)).toHaveLength(2);
    expect(common).toContain("userAgent(ctx.version)");
    expect(handler).toContain("userAgent(meta.CF_WEBMCP_VERSION)");
    expect(preflight).toContain("preflightUserAgent(version)");
    expect(preflight).toContain('"package.json"');
  });
});
