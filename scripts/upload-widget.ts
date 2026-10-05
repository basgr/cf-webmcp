/**
 * Upload the pinned widget to the R2 bucket of the CF_WEBMCP_ASSETS binding.
 *
 * Usage:
 *   npm run upload-widget            # remote bucket from wrangler.toml (deploys)
 *   npm run upload-widget -- --local # local R2 state of wrangler.dev.toml, so
 *                                    # `npm run dev:worker` (wrangler dev --config
 *                                    # wrangler.dev.toml) sees it
 *
 * CF_WEBMCP_WRANGLER_CONFIG names another wrangler config for either target. The
 * bucket name is read from that config and the same file is passed to wrangler
 * as --config, so both name the same bucket and the same local state.
 *
 * Run after `npm run update-widget` (and after any change of the pin) and BEFORE
 * `wrangler deploy`: the deployed Worker advertises widget.<hash>.js on the
 * landing page and answers 503 until that object exists.
 *
 * Everything comes from vendor/webmcp/current.json, not from generated output:
 *   - the object is ONE composed file, LICENSE_PREAMBLE + the vendored webmcp.js bytes;
 *   - its key is widget.<first 16 hex of served_sha256>.js;
 *   - before uploading, the raw file and the composed bytes are verified against
 *     the pin (sha256, served_sha256, served_sri). A mismatch aborts the upload.
 * The Worker serves the object as-is, so the SRI hash on the landing page's
 * <script> covers exactly what is stored.
 *
 * Do not `wrangler r2 object put` the plain webmcp.js by hand: it lacks the
 * preamble, so browsers block the script with an SRI mismatch.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { LICENSE_PREAMBLE } from "../src/widget-preamble.js";
import {
  composeWidget,
  sha256Hex,
  sriSha384,
  widgetAssetName,
  type WidgetPin,
} from "./widget-pin.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Check the vendored bytes against the pin and return the composed object to
 * upload. Throws unless all of these hold:
 *   sha256(raw)      == pin.sha256
 *   sha256(composed) == pin.served_sha256
 *   sha384(composed) == pin.served_sri
 * where composed = preamble + raw. Pure: no file or network access.
 */
export function verifyComposedWidget(raw: Uint8Array, preamble: string, pin: WidgetPin): Uint8Array {
  if (!pin.served_sha256 || !pin.served_sri) {
    throw new Error(
      "[upload-widget] vendor/webmcp/current.json has no served_sha256/served_sri; run `npm run update-widget` to record them",
    );
  }
  const rawHash = sha256Hex(raw);
  if (rawHash !== pin.sha256.toLowerCase()) {
    throw new Error(
      `[upload-widget] vendored webmcp.js sha256 ${rawHash} does not match the pinned sha256 ${pin.sha256}; run \`npm run update-widget\` to re-pin`,
    );
  }
  const composed = composeWidget(raw, preamble);
  const composedHash = sha256Hex(composed);
  if (composedHash !== pin.served_sha256) {
    throw new Error(
      `[upload-widget] preamble + widget sha256 ${composedHash} does not match the pinned served_sha256 ${pin.served_sha256} (the license preamble changed since the pin was written); run \`npm run update-widget\``,
    );
  }
  const composedSri = sriSha384(composed);
  if (composedSri !== pin.served_sri) {
    throw new Error(
      `[upload-widget] preamble + widget SRI ${composedSri} does not match the pinned served_sri ${pin.served_sri}; run \`npm run update-widget\``,
    );
  }
  return composed;
}

/** R2 object key for the pin, derived from the pin alone. */
export function objectKeyFor(pin: WidgetPin): string {
  if (!pin.served_sha256) {
    throw new Error(
      "[upload-widget] vendor/webmcp/current.json has no served_sha256; run `npm run update-widget` to record it",
    );
  }
  return widgetAssetName(pin.served_sha256);
}

export async function readVendoredWidget(filePath: string): Promise<Uint8Array> {
  try {
    return new Uint8Array(await fs.readFile(filePath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`[upload-widget] vendored widget missing, run update-widget (expected ${filePath})`);
    }
    throw err;
  }
}

/**
 * The wrangler config the upload reads the bucket from and hands to wrangler:
 * CF_WEBMCP_WRANGLER_CONFIG (relative to the repo root) when set, else
 * wrangler.dev.toml for a --local upload (the config `npm run dev:worker` runs
 * `wrangler dev` with) and wrangler.toml for a deploy upload.
 */
export function wranglerConfigPath(opts: { local: boolean; root: string; env: Record<string, string | undefined> }): string {
  const override = opts.env["CF_WEBMCP_WRANGLER_CONFIG"];
  if (override) return path.resolve(opts.root, override);
  return path.join(opts.root, opts.local ? "wrangler.dev.toml" : "wrangler.toml");
}

/**
 * Arguments for `wrangler r2 object put`. Wrangler 4 defaults `r2 object` to
 * LOCAL storage when neither flag is given, so the target is always explicit:
 * a deploy upload must say --remote or it would never reach the real bucket.
 * --config is the file the bucket name came from, so a --local upload lands in
 * the local state `wrangler dev` reads for that same config.
 */
export function wranglerPutArgs(opts: { bucket: string; key: string; file: string; local: boolean; config: string }): string[] {
  return [
    "r2",
    "object",
    "put",
    `${opts.bucket}/${opts.key}`,
    "--file",
    opts.file,
    "--content-type",
    "application/javascript",
    "--config",
    opts.config,
    opts.local ? "--local" : "--remote",
  ];
}

/** Quote one argument for the shell spawnSync starts (needed for wrangler.cmd on Windows). */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

async function main(): Promise<void> {
  const local = process.argv.slice(2).includes("--local");

  const pin: WidgetPin = JSON.parse(
    await fs.readFile(path.join(ROOT, "vendor", "webmcp", "current.json"), "utf8"),
  );
  if (pin.version === "unpinned") {
    throw new Error("[upload-widget] no widget pinned yet; run `npm run update-widget` first");
  }

  const filePath = path.join(ROOT, "vendor", "webmcp", pin.version, "webmcp.js");
  const raw = await readVendoredWidget(filePath);
  const composed = verifyComposedWidget(raw, LICENSE_PREAMBLE, pin);
  const objectKey = objectKeyFor(pin);

  // Read the bucket name from the wrangler config: wrangler.dev.toml for --local,
  // wrangler.toml for a deploy. CF_WEBMCP_WRANGLER_CONFIG lets out-of-tree deploys
  // (the publisher's own repo) point at their own file.
  const wranglerPath = wranglerConfigPath({ local, root: ROOT, env: process.env });
  const wranglerToml = await fs.readFile(wranglerPath, "utf8");
  const bucketMatch = wranglerToml.match(/binding\s*=\s*"CF_WEBMCP_ASSETS"[\s\S]*?bucket_name\s*=\s*"([^"]+)"/);
  if (!bucketMatch || !bucketMatch[1]) {
    throw new Error(`[upload-widget] CF_WEBMCP_ASSETS R2 binding not found in ${wranglerPath}`);
  }
  const bucket = bucketMatch[1];

  // wrangler uploads from a file, so write the verified composed bytes to a temp one.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-widget-"));
  try {
    const tmpFile = path.join(tmpDir, objectKey);
    await fs.writeFile(tmpFile, composed);

    // eslint-disable-next-line no-console
    console.log(
      `[upload-widget] uploading ${pin.version} (license preamble + webmcp.js, ${composed.length} bytes) to ${bucket}/${objectKey} (${local ? "local" : "remote"}, ${path.relative(ROOT, wranglerPath) || wranglerPath})`,
    );
    const args = wranglerPutArgs({ bucket, key: objectKey, file: tmpFile, local, config: wranglerPath });
    // One quoted command string: wrangler resolves to wrangler.cmd on Windows, which needs a shell.
    const result = spawnSync(["wrangler", ...args.map(shellQuote)].join(" "), { stdio: "inherit", shell: true });
    if (result.status !== 0) throw new Error("wrangler r2 object put failed");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// CLI entry. Guarded so the tests can import the pure functions above.
const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === thisFile) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
