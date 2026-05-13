/**
 * Pin a release of jasonjmcghee/WebMCP into vendor/webmcp/<version>/.
 *
 * Usage:
 *   npm run update-widget -- --version=v0.1.5 --sha256=<expected>
 *
 * Writes:
 *   vendor/webmcp/<version>/webmcp.js
 *   vendor/webmcp/<version>/webmcp.js.sha256
 *   vendor/webmcp/<version>/LICENSE  (a stub, replaced by the real one when available)
 *
 * Verifies the downloaded file's sha256 matches the expected value. Fails the
 * pin if it does not. The MIT LICENSE is stored alongside and prepended to the
 * served JS at request time.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  version: string;
  sha256: string;
  releaseUrl?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)=(.+)$/.exec(a);
    if (m && m[1] && m[2]) args[m[1]] = m[2];
  }
  if (!args["version"] || !args["sha256"]) {
    throw new Error(
      `usage: npm run update-widget -- --version=vX.Y.Z --sha256=<hex> [--release-url=https://...]`,
    );
  }
  return {
    version: args["version"],
    sha256: args["sha256"],
    ...(args["release-url"] !== undefined ? { releaseUrl: args["release-url"] } : {}),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url =
    args.releaseUrl ??
    `https://github.com/jasonjmcghee/WebMCP/releases/download/${args.version}/webmcp.js`;

  // eslint-disable-next-line no-console
  console.log(`[update-widget] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  const actual = createHash("sha256").update(buf).digest("hex");
  if (actual.toLowerCase() !== args.sha256.toLowerCase()) {
    throw new Error(`sha256 mismatch: expected ${args.sha256}, got ${actual}`);
  }

  const outDir = path.join(ROOT, "vendor", "webmcp", args.version);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, "webmcp.js"), buf);
  await fs.writeFile(path.join(outDir, "webmcp.js.sha256"), `${actual}  webmcp.js\n`);

  const licenseStub = `MIT License - jasonjmcghee/WebMCP ${args.version}
This file is a placeholder. Replace with the upstream LICENSE on every update.
See https://github.com/jasonjmcghee/WebMCP/blob/main/LICENSE
`;
  const licensePath = path.join(outDir, "LICENSE");
  try {
    await fs.access(licensePath);
  } catch {
    await fs.writeFile(licensePath, licenseStub);
  }

  // Write/update a pointer file at vendor/webmcp/current.json so the build
  // pipeline knows which version to ship.
  const pointer = { version: args.version, sha256: actual };
  await fs.writeFile(
    path.join(ROOT, "vendor", "webmcp", "current.json"),
    JSON.stringify(pointer, null, 2) + "\n",
  );

  // eslint-disable-next-line no-console
  console.log(`[update-widget] OK, pinned ${args.version} (${actual.slice(0, 12)}...)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
