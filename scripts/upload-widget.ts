/**
 * Upload the currently-pinned widget to the R2 bucket configured in wrangler.toml.
 * Run once after `npm run update-widget` and before `wrangler deploy`.
 *
 * Reads the pin from vendor/webmcp/current.json, reads src/generated/hash.ts
 * for the widget asset name (widget.<config_hash>.js), and uploads.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface Pin {
  version: string;
  sha256: string;
}

async function main(): Promise<void> {
  const pin: Pin = JSON.parse(
    await fs.readFile(path.join(ROOT, "vendor", "webmcp", "current.json"), "utf8"),
  );
  if (pin.version === "unpinned") {
    throw new Error("[upload-widget] no widget pinned yet; run `npm run update-widget` first");
  }

  const filePath = path.join(ROOT, "vendor", "webmcp", pin.version, "webmcp.js");
  await fs.access(filePath);

  // Read generated asset name.
  const hashTs = await fs.readFile(path.join(ROOT, "src", "generated", "hash.ts"), "utf8");
  const match = hashTs.match(/WIDGET_ASSET\s*=\s*"([^"]+)"/);
  if (!match || !match[1]) throw new Error("[upload-widget] WIDGET_ASSET not found in generated/hash.ts");
  const objectKey = match[1];

  // Read bucket name from wrangler.toml. Honor CF_WEBMCP_WRANGLER_CONFIG so
  // out-of-tree deploys (the publisher's own repo) can point at their own file.
  const wranglerPath = process.env.CF_WEBMCP_WRANGLER_CONFIG
    ? path.resolve(ROOT, process.env.CF_WEBMCP_WRANGLER_CONFIG)
    : path.join(ROOT, "wrangler.toml");
  const wranglerToml = await fs.readFile(wranglerPath, "utf8");
  const bucketMatch = wranglerToml.match(/binding\s*=\s*"CF_WEBMCP_ASSETS"[\s\S]*?bucket_name\s*=\s*"([^"]+)"/);
  if (!bucketMatch || !bucketMatch[1]) {
    throw new Error(`[upload-widget] CF_WEBMCP_ASSETS R2 binding not found in ${wranglerPath}`);
  }
  const bucket = bucketMatch[1];

  // eslint-disable-next-line no-console
  console.log(`[upload-widget] uploading ${pin.version}/webmcp.js to ${bucket}/${objectKey}`);
  const result = spawnSync(
    "wrangler",
    ["r2", "object", "put", `${bucket}/${objectKey}`, "--file", filePath, "--content-type", "application/javascript"],
    { stdio: "inherit", shell: true },
  );
  if (result.status !== 0) throw new Error("wrangler r2 object put failed");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
