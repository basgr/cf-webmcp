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
 *   2. A 200 declared as JSON (application/json, any application/<x>+json, or no
 *      content type) of at most 1 MiB that passes the structural check (an
 *      object with an entries array of objects with a string identifier) gets
 *      our entry appended, unless origin already has an entry with our
 *      identifier or our url: origin's entry wins and ours is not added.
 *   3. A 200 declared as JSON that fails the check, one over 1 MiB, and any
 *      other 200 (HTML, text) is relayed unchanged (origin's bytes and headers)
 *      with noindex. It is origin's document, not ours to replace.
 *   4. A 404 at both paths gets the generated document with the normal cache.
 *      Any other final answer (a relayed redirect, a 4xx, a 5xx, the proxy's 502
 *      or 504) and a body that fails while it is read mean origin failed: the
 *      generated document stands in with a short cache.
 *
 * No replace mode: unlike api-catalog, the document is synthesized from config.
 */

import type { Config } from "../config-types";
import { buildCacheControl, sha256Hex } from "../cache";
import { ARD_PREDECESSOR_PATH, isArdContentType, isArdDocument, type ArdEntryLike } from "../ard";
import { MERGE_MAX_BYTES, ORIGIN_FAILURE_CACHE_CONTROL, declaredLength, readCapped, type CappedRead } from "./read-capped";

/** Origin documents over this many bytes are relayed, not merged (the cap every merge route shares). */
export const ARD_MERGE_MAX_BYTES = MERGE_MAX_BYTES;

/**
 * Cache-Control of the generated document when it stands in for an origin that
 * failed, so origin's own document is back within a minute once origin is.
 */
export const ARD_FAILURE_CACHE_CONTROL = ORIGIN_FAILURE_CACHE_CONTROL;

/**
 * `synthesizedEtag` is the strong ETag of `synthesizedBody`, computed at build time
 * (ARD_ETAG). A merged document exists only at request time, so its ETag is hashed
 * then, over the merged bytes: the merge reads origin's whole document anyway, and the
 * tag then changes exactly when the merged bytes do, origin edits included. A relayed
 * origin document keeps origin's own headers, its ETag among them.
 */
export async function aiCatalogResponse(
  _request: Request,
  config: Config,
  synthesizedBody: string,
  proxyToOrigin: (url: URL) => Promise<Response>,
  synthesizedEtag?: string,
): Promise<Response> {
  if (config.ai_catalog.mode === "merge") {
    const merged = await mergeWithOrigin(config, synthesizedBody, proxyToOrigin);
    if (merged.kind === "relay") return withNoindex(merged.upstream);
    if (merged.kind === "body") return ardResponse(merged.text, ardCacheControl(config), await bodyEtag(merged.text));
    return ardResponse(
      synthesizedBody,
      merged.originFailed ? ARD_FAILURE_CACHE_CONTROL : ardCacheControl(config),
      synthesizedEtag,
    );
  }
  // synthesize (or any other mode).
  return ardResponse(synthesizedBody, ardCacheControl(config), synthesizedEtag);
}

/** The strong ETag of a body, as the build computes it: the first 16 hex of its sha256, quoted. */
async function bodyEtag(body: string): Promise<string> {
  return `"${(await sha256Hex(body)).slice(0, 16)}"`;
}

/**
 * 301 from an [ai_catalog].aliases path (the predecessor ai-catalog.json by
 * default) to the canonical [ai_catalog].path. Cached like the manifest itself;
 * noindex because the aliases live under /.well-known/. CORS like the manifest,
 * because a browser follows a cross-origin redirect only when the redirect
 * itself passes the CORS check.
 */
export function ardRedirect(config: Config): Response {
  return new Response(null, {
    status: 301,
    headers: {
      location: config.ai_catalog.path,
      "access-control-allow-origin": "*",
      "cache-control": ardCacheControl(config),
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}

function ardResponse(body: string, cacheControl: string, etag: string | undefined): Response {
  return new Response(body, {
    status: 200,
    headers: {
      // ARD v0.91 names no media type of its own for the manifest: it is a JSON document.
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      // Agent-discovery surface served under /.well-known/, not search-engine
      // content. See docs/scope.md and the x-robots coverage test.
      "x-robots-tag": "noindex",
      ...(etag !== undefined ? { etag } : {}),
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

/**
 * What merge mode does with origin's answer: serve a merged body, relay origin's
 * response, or serve the generated document (with the short cache when origin
 * failed rather than having no document).
 */
type MergeOutcome =
  | { kind: "body"; text: string }
  | { kind: "relay"; upstream: Response }
  | { kind: "generated"; originFailed: boolean };

async function mergeWithOrigin(
  config: Config,
  synthesizedBody: string,
  proxyToOrigin: (url: URL) => Promise<Response>,
): Promise<MergeOutcome> {
  let upstream = await proxyToOrigin(new URL(config.ai_catalog.path, config.origin.base_url));
  if (upstream.status === 404 && config.ai_catalog.path !== ARD_PREDECESSOR_PATH) {
    upstream = await proxyToOrigin(new URL(ARD_PREDECESSOR_PATH, config.origin.base_url));
  }
  if (upstream.status === 404) return { kind: "generated", originFailed: false };
  if (upstream.status !== 200) return { kind: "generated", originFailed: true };
  if (!isArdContentType(upstream.headers.get("content-type"))) {
    // HTML or text at the path - relay unchanged with noindex.
    return { kind: "relay", upstream };
  }
  if (declaredLength(upstream) > ARD_MERGE_MAX_BYTES) {
    // Too large to merge: relay the body unread.
    return { kind: "relay", upstream };
  }
  let read: CappedRead;
  try {
    read = await readCapped(upstream.body, ARD_MERGE_MAX_BYTES);
  } catch {
    // The body failed while it was read: origin failed.
    return { kind: "generated", originFailed: true };
  }
  const init = { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers };
  if (read.kind === "too_large") {
    // Over the cap without a Content-Length saying so: relay what was read and the rest.
    return { kind: "relay", upstream: new Response(read.rest, init) };
  }
  // The decoder drops a leading byte order mark, for parsing only.
  const merged = tryMergeAiCatalog(new TextDecoder().decode(read.bytes), synthesizedBody);
  if (merged === null) {
    // JSON that fails the structural check: origin's, relayed as it came. The
    // original bytes and headers, so a byte order mark stays and no content type
    // is added where origin sent none.
    return { kind: "relay", upstream: new Response(read.bytes, init) };
  }
  return { kind: "body", text: merged };
}

/**
 * Parse origin's ARD document and append our entries to it. An origin entry
 * with the same identifier or the same url as one of ours is kept and ours is
 * not added, so nothing is duplicated and the publisher's own description wins.
 * Origin's other top-level members are kept as they are. Returns null when the
 * origin document is unparseable or fails the structural check (an object with
 * an entries array of objects with a string identifier; see isArdDocument for
 * why it is not a full schema validation).
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
    const url = typeof ours["url"] === "string" ? ours["url"] : undefined;
    const listed = merged.some((e) => e.identifier === ours.identifier || (url !== undefined && e["url"] === url));
    if (!listed) merged.push(ours);
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
