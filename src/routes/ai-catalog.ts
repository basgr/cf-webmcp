/**
 * GET /.well-known/ard.json handler (ARD v0.91 manifest), plus the 301 from its
 * aliases (the predecessor /.well-known/ai-catalog.json by default).
 *
 * Serves the Agentic Resource Discovery (ARD) manifest for AI agents. The config
 * key stays [ai_catalog]. Modes:
 *   - synthesize: serve the manifest built from TOML (AI_CATALOG_JSON generated asset)
 *   - merge:      fetch origin's manifest and add our entry to it
 *   - passthrough: route not registered (handled at router/feature toggle)
 *
 * Merge, in order:
 *   1. Fetch [ai_catalog].path at origin. On a 404 there, fetch the predecessor
 *      path /.well-known/ai-catalog.json at origin instead, so a publisher whose
 *      document still lives there keeps it merged.
 *   2. A 200 declared as JSON (application/json, application/ai-catalog+json or
 *      no content type) that passes the v0.91 check gets our entry appended. An
 *      origin entry with the same identifier wins: ours is not added twice.
 *   3. A 200 declared as JSON that fails the check (unparseable, or not an object
 *      with an entries array of objects with a string identifier), and any other
 *      200 (HTML, text), is relayed unchanged with noindex. It is origin's
 *      document, not ours to replace.
 *   4. Anything else (a 404 at both paths, a relayed redirect, a 4xx, a 5xx, the
 *      proxy's 502 or 504) gets the generated document.
 *
 * No replace mode: unlike api-catalog, the document is synthesized from config.
 */

import type { Config } from "../config-types";
import { buildCacheControl } from "../cache";
import { ARD_PREDECESSOR_PATH, isArdContentType, isArdDocument, type ArdEntryLike } from "../ard";

export async function aiCatalogResponse(
  _request: Request,
  config: Config,
  synthesizedBody: string,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<Response> {
  if (config.ai_catalog.mode === "merge") {
    const merged = await mergeWithOrigin(config, synthesizedBody, proxyToOrigin);
    if (merged.kind === "relay") return withNoindex(merged.upstream);
    if (merged.kind === "body") return ardResponse(config, merged.text);
  }
  // synthesize (or any other mode), and merge without a usable origin answer.
  return ardResponse(config, synthesizedBody);
}

/**
 * 301 from an [ai_catalog].aliases path (the predecessor ai-catalog.json by
 * default) to the canonical [ai_catalog].path. Cached like the manifest itself;
 * noindex because the aliases live under /.well-known/.
 */
export function ardRedirect(config: Config): Response {
  return new Response(null, {
    status: 301,
    headers: {
      location: config.ai_catalog.path,
      "cache-control": ardCacheControl(config),
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}

function ardResponse(config: Config, body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      // ARD v0.91 names no media type of its own for the manifest: it is a JSON document.
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": ardCacheControl(config),
      "x-content-type-options": "nosniff",
      // Agent-discovery surface served under /.well-known/, not search-engine
      // content. See docs/scope.md and the x-robots coverage test.
      "x-robots-tag": "noindex",
    },
  });
}

function ardCacheControl(config: Config): string {
  return buildCacheControl({
    max_age: config.cache.ai_catalog_max_age,
    s_maxage: config.cache.ai_catalog_s_maxage,
    swr: config.cache.ai_catalog_swr,
    sie: config.cache.ai_catalog_sie,
  });
}

/** What merge mode does with origin's answer: serve a merged body, relay origin's response, or serve the generated document. */
type MergeOutcome = { kind: "body"; text: string } | { kind: "relay"; upstream: Response } | { kind: "generated" };

async function mergeWithOrigin(
  config: Config,
  synthesizedBody: string,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<MergeOutcome> {
  let upstream = await proxyToOrigin(new URL(config.ai_catalog.path, config.origin.base_url));
  if (upstream.status === 404 && config.ai_catalog.path !== ARD_PREDECESSOR_PATH) {
    upstream = await proxyToOrigin(new URL(ARD_PREDECESSOR_PATH, config.origin.base_url));
  }
  if (upstream.status !== 200) return { kind: "generated" };
  if (!isArdContentType(upstream.headers.get("content-type"))) {
    // HTML or text at the path - relay unchanged with noindex.
    return { kind: "relay", upstream };
  }
  const text = await upstream.text();
  const merged = tryMergeAiCatalog(text, synthesizedBody);
  if (merged === null) {
    // JSON that is not an ARD document: origin's, relayed as it came (the body is
    // already read, so it is rebuilt from the text).
    return {
      kind: "relay",
      upstream: new Response(text, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers }),
    };
  }
  return { kind: "body", text: merged };
}

/**
 * Parse origin's ARD document and append our entries to it. An origin entry
 * with the same identifier as one of ours is kept and ours is not added, so
 * nothing is duplicated and the publisher's own description wins. Origin's other
 * top-level members are kept as they are. Returns null when the origin document
 * is unparseable or fails the v0.91 check.
 */
export function tryMergeAiCatalog(originText: string, synthesizedBody: string): string | null {
  let origin: unknown;
  try {
    origin = JSON.parse(originText);
  } catch {
    return null;
  }
  if (!isArdDocument(origin)) return null;

  const merged: ArdEntryLike[] = origin.entries.slice();
  for (const ours of ourEntries(synthesizedBody)) {
    if (!merged.some((e) => e.identifier === ours.identifier)) merged.push(ours);
  }
  return stringify({ ...origin, entries: merged });
}

/** The entries of our own generated document; none when it has none (agent_skills off) or cannot be read. */
function ourEntries(synthesizedBody: string): ArdEntryLike[] {
  try {
    const ours: unknown = JSON.parse(synthesizedBody);
    return isArdDocument(ours) ? ours.entries : [];
  } catch {
    return [];
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
 * Clone a response and add `X-Robots-Tag: noindex`. Used when relaying an
 * origin response from a /.well-known/* route - the origin's headers may not
 * include the noindex tag, but the protected-prefix rule requires it.
 */
function withNoindex(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
