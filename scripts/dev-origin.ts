/**
 * Tiny static file server used as the "origin" during local dev.
 * Serves templates/example-site/origin/ on http://localhost:8081.
 *
 * Worker proxies to this server, fetches sitemap/feed/HTML for executors,
 * and injects the bootstrapper into HTML responses.
 */

import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DIR = path.join(ROOT, "templates", "example-site", "origin");
const SERVE_DIR = path.resolve(ROOT, process.env["ORIGIN_DIR"] ?? DEFAULT_DIR);
const PORT = Number(process.env["ORIGIN_PORT"] ?? 8081);

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".xml":  "application/xml; charset=utf-8",
  ".txt":  "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const server = http.createServer(async (req, res) => {
  const reqPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");

  // Resolve to a file path under SERVE_DIR. Reject any traversal.
  let target = reqPath;
  if (target.endsWith("/")) target += "index.html";

  const filePath = path.normalize(path.join(SERVE_DIR, target));
  if (!filePath.startsWith(SERVE_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  try {
    let body = await readMaybeWithExt(filePath);
    let servedPath = filePath;
    if (body === null) {
      // Try `.html` extension fallback so /about resolves to about.html
      const altPath = filePath + ".html";
      body = await readMaybeWithExt(altPath);
      if (body !== null) servedPath = altPath;
    }
    if (body === null) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const ext = path.extname(servedPath).toLowerCase();
    // Special case for RFC 9727 well-known catalog: the convention is an
    // extensionless filename, content-type application/linkset+json.
    const wellKnownCatalog = servedPath.replace(/\\/g, "/").endsWith("/.well-known/api-catalog");
    const ct = wellKnownCatalog
      ? "application/linkset+json"
      : (TYPES[ext] ?? "application/octet-stream");
    res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
    res.end(body);
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(e instanceof Error ? e.message : e));
  }
});

async function readMaybeWithExt(p: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[dev-origin] serving ${path.relative(ROOT, SERVE_DIR)} at http://localhost:${PORT}`);
});
