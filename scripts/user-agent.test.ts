import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The User-Agent of cf-webmcp's requests to origin names the package version, from one place
 * (src/user-agent.ts for the Worker, scripts/preflight.ts reading package.json). A literal
 * version in any other source file is how "cf-webmcp/1.0" outlived four releases.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

describe("User-Agent", () => {
  it("is built from a version variable, never from a literal, in every source file", async () => {
    const files = [...(await sources("src")), ...(await sources("scripts"))];
    expect(files.length).toBeGreaterThan(20);
    const literal = /cf-webmcp(-preflight)?\/\d/;
    const offenders: string[] = [];
    for (const file of files) {
      const text = await fs.readFile(path.join(root, file), "utf8");
      text.split("\n").forEach((line, i) => {
        // `transport: "cf-webmcp/1"` is the manifest's transport id, not a User-Agent.
        if (literal.test(line) && !/transport/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("is produced by userAgent() in the Worker and read from package.json in preflight", async () => {
    const common = await fs.readFile(path.join(root, "src", "executors", "common.ts"), "utf8");
    const handler = await fs.readFile(path.join(root, "src", "handler.ts"), "utf8");
    const preflight = await fs.readFile(path.join(root, "scripts", "preflight.ts"), "utf8");
    expect(common).toContain("userAgent(ctx.version)");
    expect(handler).toContain("userAgent(meta.CF_WEBMCP_VERSION)");
    expect(preflight).toContain("cf-webmcp-preflight/${version}");
    expect(preflight).toContain('"package.json"');
  });
});
