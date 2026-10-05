/**
 * Pin a release of jasonjmcghee/WebMCP into vendor/webmcp/<version>/.
 *
 * Usage:
 *   npm run update-widget -- --version=v0.1.5 --sha256=<expected> [--release-url=https://...]
 *
 * The default download URL is src/webmcp.js at the version's tag
 * (defaultReleaseUrl), e.g.
 * https://raw.githubusercontent.com/jasonjmcghee/WebMCP/v0.1.13/src/webmcp.js
 * Release v0.1.13 attaches no webmcp.js asset, so the release-asset URL answers
 * 404 for it. Earlier releases attach a minified build under that name, which is
 * a different file (a different sha256) from src/webmcp.js. --release-url
 * overrides the default.
 *
 * Writes:
 *   vendor/webmcp/<version>/webmcp.js
 *   vendor/webmcp/<version>/webmcp.js.sha256
 *   vendor/webmcp/<version>/LICENSE  (a stub, replaced by the real one when available)
 *   vendor/webmcp/current.json       (the pin, see below)
 *
 * Verifies the downloaded file's sha256 matches the expected value. Fails the
 * pin if it does not.
 *
 * current.json records the raw sha256 plus what a browser will actually receive,
 * which is the MIT preamble (src/widget-preamble.ts) followed by the file bytes:
 *   served_sha256    hex sha256 of preamble + file bytes (names the R2 object and the URL)
 *   served_sri       "sha384-" + base64(sha384(preamble + file bytes)) (the <script integrity>)
 *   preamble_sha256  hex sha256 of the preamble the two values above were computed with
 * `npm run upload-widget` uploads that composed object; the build reads only this
 * file. Re-run this script whenever the preamble text changes.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LICENSE_PREAMBLE } from "../src/widget-preamble.js";
import { bridgeNpmVersion, makePin, sha256Hex } from "./widget-pin.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Args {
  version: string;
  sha256: string;
  releaseUrl?: string;
}

/** Where the widget of a release lives upstream: src/webmcp.js at the release tag. */
export function defaultReleaseUrl(version: string): string {
  return `https://raw.githubusercontent.com/jasonjmcghee/WebMCP/${encodeURIComponent(version)}/src/webmcp.js`;
}

/**
 * The command line, checked before anything is downloaded. --version must be a release tag
 * vX.Y.Z: the build names the bridge CLI from it (bridgeNpmVersion) and disables the widget for
 * any other version, so a pin that cannot be used is refused here, not discovered at build time.
 */
export function parseArgs(argv: string[]): Args {
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
  if (bridgeNpmVersion(args["version"]) === null) {
    throw new Error(
      `--version=${JSON.stringify(args["version"])} is not a release tag. Use the upstream tag in the form vX.Y.Z ` +
        `(for example v0.1.13): the landing page names the bridge CLI of the same release, @jason.today/webmcp@X.Y.Z.`,
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
  const url = args.releaseUrl ?? defaultReleaseUrl(args.version);

  // eslint-disable-next-line no-console
  console.log(`[update-widget] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());

  const actual = sha256Hex(buf);
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

  // Write/update the pin at vendor/webmcp/current.json: the build names the
  // asset and the SRI hash from it, upload-widget uploads the object it names.
  const pin = makePin(args.version, buf, LICENSE_PREAMBLE);
  await fs.writeFile(
    path.join(ROOT, "vendor", "webmcp", "current.json"),
    JSON.stringify(pin, null, 2) + "\n",
  );

  // eslint-disable-next-line no-console
  console.log(
    `[update-widget] OK, pinned ${args.version} (${actual.slice(0, 12)}...), served ${pin.served_sha256.slice(0, 16)}. ` +
      `Next: npm run upload-widget, then deploy.`,
  );
}

// CLI entry. Guarded so the module can be imported without side effects.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
