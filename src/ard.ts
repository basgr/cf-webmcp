/**
 * Agentic Resource Discovery (ARD) v0.91: the names and identifier helpers
 * cf-webmcp's ARD manifest is built from. One module, so the route, the build,
 * the discovery advertisements and preflight agree.
 *
 * Spec: github.com/ards-project/ard-spec, spec/ard.md v0.91 (26 Aug 2026).
 *   - Section 5.1: the manifest lives at /.well-known/ard.json, advertised with
 *     rel="ard". /.well-known/ai-catalog.json and rel="ai-catalog" are the
 *     predecessor names: consumers MAY consult them, publishers SHOULD move.
 *   - The manifest requires only `entries`; other top-level members are
 *     transport-defined and ignored by ARD.
 *   - Appendix C: identifiers are urn:air:<publisher>:<namespace>:<name>, the
 *     publisher a fully qualified domain name.
 */

/** Canonical well-known path of the ARD manifest (v0.91 section 5.1). */
export const ARD_PATH = "/.well-known/ard.json";

/** Link relation for the ARD manifest, in the Link header and in <link> tags. */
export const ARD_REL = "ard";

/**
 * The predecessor path. cf-webmcp 301-redirects it to the canonical path (the
 * default [ai_catalog].aliases) and, in merge mode, reads origin's document
 * there when origin has none at the canonical path.
 */
export const ARD_PREDECESSOR_PATH = "/.well-known/ai-catalog.json";

/** Entry type of a SKILL.md, as in the skill entry example of v0.91 section 4.4. */
export const SKILL_MEDIA_TYPE = "application/ai-skill+md";

/**
 * The site's canonical host: the host of [site].public_url when it is set, else
 * [site].domain. A configured port is kept (a default port is dropped, as the
 * WHATWG URL parser does), the host is lowercased and an IDN is in punycode.
 */
export function siteHost(site: { domain: string; public_url?: string | undefined }): string {
  return new URL(site.public_url ?? `https://${site.domain}`).host;
}

/**
 * did:web identifier for a host. The did:web method requires the colon before
 * a port to be percent-encoded: did:web:example.com%3A8787.
 */
export function didWeb(host: string): string {
  return `did:web:${new URL(`https://${host}`).host.replace(/:/g, "%3A")}`;
}

/**
 * ARD discovery identifier urn:air:<publisher>:<namespace>:<name>. The
 * publisher segment is a domain name, so it is the host without its port,
 * lowercased, an IDN in punycode.
 */
export function urnAir(host: string, namespace: string, name: string): string {
  const publisher = new URL(`https://${host}`).hostname;
  return `urn:air:${publisher}:${namespace}:${name}`;
}

/**
 * Slug for skill names and ARD identifiers: NFKD, combining marks removed,
 * lowercased, every run of characters outside a-z and 0-9 replaced by one
 * hyphen, hyphens trimmed. A letter NFKD does not decompose to ASCII (ß, ø) is
 * outside a-z, so it separates like any other such character:
 * "Grüße Welt" becomes "gru-e-welt". May return "": the build refuses an empty
 * slug where one is required.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** An ARD manifest as cf-webmcp reads one: an `entries` array of entries with a string identifier. */
export interface ArdDocument {
  entries: ArdEntryLike[];
  [member: string]: unknown;
}

export interface ArdEntryLike {
  identifier: string;
  [term: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The check an origin document must pass before cf-webmcp merges into it: an
 * object with an `entries` array whose members are objects with a string
 * `identifier`. The v0.91 manifest requires only `entries`, and `identifier` is
 * what the merge matches on.
 */
export function isArdDocument(value: unknown): value is ArdDocument {
  if (!isPlainObject(value)) return false;
  const entries = value["entries"];
  return Array.isArray(entries) && entries.every((e) => isPlainObject(e) && typeof e["identifier"] === "string");
}

/**
 * Content types read as an ARD document: application/json, the predecessor's
 * application/ai-catalog+json, or none at all. text/json and text/plain are not.
 */
export function isArdContentType(ct: string | null): boolean {
  if (!ct) return true;
  return /^application\/(ai-catalog\+)?json/i.test(ct);
}
