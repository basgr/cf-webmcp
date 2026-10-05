/**
 * GET /.well-known/api-catalog handler (RFC 9727).
 *
 * Returns an RFC 9264 Linkset advertising the WebMCP manifest. Modes match the
 * other discovery routes:
 *   - merge:      fetch origin's catalog, splice our entry into the linkset
 *                 (idempotent on re-run via {anchor, href} match)
 *   - synthesize: emit a fresh catalog from TOML only, ignore origin
 *   - replace:    same as synthesize - cf-webmcp emits exactly one entry,
 *                 so there is no multi-entry case where the two would differ.
 *                 Kept for parity with the other discovery routes' mode enum.
 *   - passthrough: route not registered (handled at the router/feature toggle)
 *
 * Scope is one entry pointing at config.manifest.path. RFC 9727 section 4.1 requires an API
 * catalog to link to API endpoints, so with [features].manifest off there is nothing to publish
 * and the router does not serve this route in any mode (src/served.ts); this handler is only
 * reached with the manifest on. cf-webmcp does not generate OpenAPI, does not discover other
 * APIs on the publisher's origin, and does not impose any schema on the rest of the linkset.
 *
 * Merge reads origin's catalog through a 1 MiB cap (src/routes/read-capped.ts): a larger one
 * is relayed as origin sent it, with noindex; one whose body fails mid-read is answered with
 * the synthesized catalog, as when origin has no file, but cached for a minute only.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { ORIGIN_FAILURE_CACHE_CONTROL, readTextCapped } from "./read-capped";

interface LinkObject {
  href: string;
  type?: string;
  [key: string]: unknown;
}

interface LinksetEntry {
  anchor: string;
  [rel: string]: string | LinkObject[] | unknown;
}

interface Linkset {
  linkset: LinksetEntry[];
}

/**
 * RFC 9727 section 4.2: the catalog is a Linkset served as application/linkset+json, and it
 * SHOULD carry the profile parameter with the RFC's profile URI (appendix A.1 shows the header).
 */
export const API_CATALOG_CONTENT_TYPE = 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

const WEBMCP_REL = "webmcp";
const WEBMCP_LINK_TYPE = "application/json";

export async function apiCatalogResponse(
  _request: Request,
  config: Config,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  const ourEntry = buildOurEntry(config);
  let body: string;
  let cacheControl = buildCacheControl({
    max_age: config.cache.api_catalog_max_age,
    s_maxage: config.cache.api_catalog_s_maxage,
    swr: config.cache.api_catalog_swr,
    sie: config.cache.api_catalog_sie,
  });

  if (config.api_catalog.mode === "synthesize" || config.api_catalog.mode === "replace") {
    body = stringify({ linkset: [ourEntry] });
  } else {
    // merge
    const target = new URL(config.api_catalog.path, config.origin.base_url);
    const upstream = await proxyToOrigin(target);
    if (upstream.status === 404) {
      body = stringify({ linkset: [ourEntry] });
    } else if (upstream.status === 200 && isLinksetContentType(upstream.headers.get("content-type"))) {
      const read = await readTextCapped(upstream);
      if (read.kind === "relay") {
        // Over the 1 MiB cap: origin's catalog, not ours to merge into. Noindex, as every answer here.
        return withNoindex(read.upstream);
      }
      if (read.kind === "failed") {
        // The body failed mid-read: the catalog without origin's entries, for a minute.
        body = stringify({ linkset: [ourEntry] });
        cacheControl = ORIGIN_FAILURE_CACHE_CONTROL;
      } else {
        const merged = tryMerge(read.text, ourEntry);
        if (merged === null) {
          // Origin file unparseable or not a linkset; fall back to synthesize.
          body = stringify({ linkset: [ourEntry] });
        } else {
          body = merged;
        }
      }
    } else {
      // Origin returned something we cannot interpret as a catalog (HTML, etc).
      // Be conservative: pass it through unchanged rather than overwrite. Add
      // the noindex tag because the path lives under /.well-known/*.
      return withNoindex(upstream);
    }
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": API_CATALOG_CONTENT_TYPE,
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      // Agent-discovery surface served under /.well-known/, not search-engine
      // content. See docs/scope.md and the x-robots coverage test.
      "x-robots-tag": "noindex",
    },
  });
}

function buildOurEntry(config: Config): LinksetEntry {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const anchor = `${base}/`;
  const manifestUrl = `${base}${config.manifest.path}`;
  return {
    anchor,
    [WEBMCP_REL]: [{ href: manifestUrl, type: WEBMCP_LINK_TYPE }],
  };
}

/**
 * The entries of origin's catalog, or null when the document is unparseable or does not look
 * like an RFC 9264 linkset (an object with a `linkset` array of objects with a string `anchor`).
 * Preflight judges origin's file with this test too.
 */
export function parseLinkset(originText: string): LinksetEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(originText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const linkset = (parsed as { linkset?: unknown }).linkset;
  if (!Array.isArray(linkset)) return null;
  for (const entry of linkset) {
    if (!entry || typeof entry !== "object" || typeof (entry as LinksetEntry).anchor !== "string") {
      return null;
    }
  }
  return linkset as LinksetEntry[];
}

/**
 * Parse origin's catalog and merge our entry in. Returns null when the origin
 * document is unparseable or does not look like an RFC 9264 linkset.
 */
export function tryMerge(originText: string, ourEntry: LinksetEntry): string | null {
  const parsedEntries = parseLinkset(originText);
  if (parsedEntries === null) return null;
  const entries = parsedEntries.slice();
  const ourAnchor = ourEntry.anchor;
  const ourLinks = (ourEntry[WEBMCP_REL] as LinkObject[]) ?? [];
  const ourLink = ourLinks[0];
  if (!ourLink) return null;

  const idx = entries.findIndex((e) => e.anchor === ourAnchor);
  if (idx === -1) {
    entries.push(ourEntry);
  } else {
    const existing = entries[idx]!;
    const existingLinks = Array.isArray(existing[WEBMCP_REL]) ? (existing[WEBMCP_REL] as LinkObject[]) : [];
    const alreadyPresent = existingLinks.some(
      (l) => l && typeof l.href === "string" && l.href === ourLink.href,
    );
    if (!alreadyPresent) {
      entries[idx] = { ...existing, [WEBMCP_REL]: [...existingLinks, ourLink] };
    }
  }

  return stringify({ linkset: entries });
}

/**
 * Canonical JSON output: 2-space indent, sorted object keys, trailing newline.
 * Ensures re-running merge against our own output produces byte-identical
 * bytes (idempotency).
 */
function stringify(obj: unknown): string {
  return JSON.stringify(obj, sortReplacer, 2) + "\n";
}

function sortReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * The content types the API catalog route merges into: preflight judges origin's file with this
 * very test (a 200 without a Content-Type counts).
 */
export function isLinksetContentType(ct: string | null): boolean {
  if (!ct) return true;
  return /^application\/(linkset\+)?json/i.test(ct);
}

/**
 * Clone a response and add `X-Robots-Tag: noindex`. Used when relaying an
 * origin response from a /.well-known/* route - the origin's headers may not
 * include the noindex tag, but the protected-prefix rule requires it.
 */
function withNoindex(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
