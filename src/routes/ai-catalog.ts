/**
 * GET /.well-known/ai-catalog.json handler (ARD Publisher Catalog).
 *
 * Serves the Agentic Resource Discovery (ARD) catalog for AI agents.
 * Modes:
 *   - synthesize: emit catalog from TOML only (AI_CATALOG_JSON generated asset)
 *   - merge:      fetch origin's catalog and merge (splice our entry in)
 *   - passthrough: route not registered (handled at router/feature toggle)
 *
 * No replace mode: unlike api-catalog, ai-catalog has no equivalent concept
 * since the entire document is synthesized from config.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";

interface ArdEntry {
  identifier: string;
  [key: string]: unknown;
}

interface ArdCatalog {
  entries: ArdEntry[];
  [key: string]: unknown;
}

export async function aiCatalogResponse(
  _request: Request,
  config: Config,
  synthesizedBody: string,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  let body: string;

  if (config.ai_catalog.mode === "merge") {
    const upstream = await proxyToOrigin(new URL(config.ai_catalog.path, config.origin.base_url));
    if (upstream.status === 404) {
      body = synthesizedBody;
    } else if (upstream.status === 200 && isAiCatalogContentType(upstream.headers.get("content-type"))) {
      const merged = tryMergeAiCatalog(await upstream.text(), synthesizedBody);
      body = merged ?? synthesizedBody;
    } else if (upstream.status === 200) {
      // Non-JSON origin response (e.g. HTML) - relay unchanged with noindex.
      return withNoindex(upstream);
    } else {
      body = synthesizedBody;
    }
  } else {
    // synthesize (or any other mode): serve synthesizedBody as-is.
    body = synthesizedBody;
  }

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/ai-catalog+json",
      "access-control-allow-origin": "*",
      "cache-control": buildCacheControl({
        max_age: config.cache.ai_catalog_max_age,
        s_maxage: config.cache.ai_catalog_s_maxage,
        swr: config.cache.ai_catalog_swr,
        sie: config.cache.ai_catalog_sie,
      }),
      "x-content-type-options": "nosniff",
      // Agent-discovery surface served under /.well-known/, not search-engine
      // content. See docs/scope.md and the x-robots coverage test.
      "x-robots-tag": "noindex",
    },
  });
}

/**
 * Parse origin's ARD catalog and splice our entry in. Returns null when the
 * origin document is unparseable or does not look like a valid ARD catalog.
 */
export function tryMergeAiCatalog(originText: string, synthesizedBody: string): string | null {
  try {
    // Parse our own synthesized doc to get our entry.
    let ourDoc: ArdCatalog;
    try {
      ourDoc = JSON.parse(synthesizedBody) as ArdCatalog;
    } catch {
      return null;
    }
    const ourEntry = ourDoc.entries?.[0];
    if (!ourEntry) return null;

    // Parse origin doc.
    let origin: unknown;
    try {
      origin = JSON.parse(originText);
    } catch {
      return null;
    }

    // Validate: must be a non-null object with an entries array where every
    // member is a non-null object with a string identifier.
    if (!origin || typeof origin !== "object") return null;
    const entries = (origin as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return null;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof (entry as ArdEntry).identifier !== "string") {
        return null;
      }
    }

    // Splice: replace in-place if our identifier already exists, else append.
    const merged = (entries as ArdEntry[]).slice();
    const idx = merged.findIndex((e) => e.identifier === ourEntry.identifier);
    if (idx === -1) {
      merged.push(ourEntry);
    } else {
      merged[idx] = ourEntry;
    }

    return stringify({ ...(origin as object), entries: merged });
  } catch {
    return null;
  }
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
 * Accept only application/json and application/ai-catalog+json (anchored,
 * mirroring isLinksetContentType in api-catalog.ts). Rejects text/json and
 * other non-application types so they fall through to the relay path.
 */
function isAiCatalogContentType(ct: string | null): boolean {
  if (!ct) return true;
  return /^application\/(ai-catalog\+)?json/i.test(ct);
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
