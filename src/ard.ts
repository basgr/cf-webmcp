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

/**
 * Entry types a skill can be listed with ([ai_catalog].skill_type). The first
 * is the default and the only one ARD v0.91 names (the skill example in section
 * 4.4). The second is what the ARD conformance tool lists as standard; the
 * third is the AI Catalog specification's. None is IANA-registered.
 */
export const SKILL_MEDIA_TYPES = [
  "application/ai-skill+md",
  'text/markdown; profile="urn:air:agent-skills"',
  "application/agent-skills+md",
] as const;

/** Default entry type of a SKILL.md, as in the skill entry example of v0.91 section 4.4. */
export const SKILL_MEDIA_TYPE = SKILL_MEDIA_TYPES[0];

/** Longest skill name the Agent Skills name rule allows. A derived name is cut to it. */
export const SKILL_NAME_MAX = 64;

type SiteHostFields = { domain: string; public_url?: string | undefined };

/**
 * Parse a [site] value as an http(s) URL with a host, or throw an error that
 * names the field and the value (the build reports it as is).
 */
function parseSiteUrl(url: string, field: "domain" | "public_url", value: string): URL {
  let parsed: URL | null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    throw new Error(
      field === "domain"
        ? `[site].domain ${JSON.stringify(value)} is not a usable host: a hostname with an optional port from 1 to 65535 is expected`
        : `[site].public_url ${JSON.stringify(value)} is not an absolute http or https URL such as "http://localhost:8787"`,
    );
  }
  return parsed;
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
}

/**
 * The site's canonical host: the host of [site].public_url when it is set, else
 * [site].domain. A configured port is kept (a default port is dropped, as the
 * WHATWG URL parser does), the host is lowercased and an IDN is in punycode.
 * [site].domain is checked in both cases. Throws an error naming the field when
 * a value cannot be parsed.
 */
export function siteHost(site: SiteHostFields): string {
  const domain = parseSiteUrl(`https://${site.domain}`, "domain", site.domain);
  if (site.public_url === undefined) return domain.host;
  return parseSiteUrl(site.public_url, "public_url", site.public_url).host;
}

/**
 * The urn:air publisher: [site].domain without its port, lowercased, an IDN in
 * punycode, one trailing dot removed. Not public_url: the ARD URN naming guide
 * keeps the real domain in local development too.
 */
export function sitePublisher(site: SiteHostFields): string {
  return stripTrailingDot(parseSiteUrl(`https://${site.domain}`, "domain", site.domain).hostname);
}

/**
 * Why a urn:air publisher is not a fully qualified domain name, or null when it
 * is one. ARD v0.91 Appendix C and the URN naming guide (section 2) require an
 * FQDN; localhost, IP addresses and single labels are not. A name under
 * .localhost (agent.localhost) is the guide's own placeholder for local work.
 */
export function publisherProblem(publisher: string): string | null {
  if (publisher === "localhost") return "is localhost";
  if (publisher.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(publisher)) return "is an IP address";
  if (!publisher.includes(".")) return "has no dot";
  if (publisher.split(".").some((label) => label === "")) return "has an empty label";
  return null;
}

/**
 * did:web identifier for a host. The did:web method requires the colon before
 * a port to be percent-encoded: did:web:example.com%3A8787. One trailing dot
 * on the hostname is removed.
 */
export function didWeb(host: string): string {
  const url = new URL(`https://${host}`);
  const hostname = stripTrailingDot(url.hostname);
  return `did:web:${(url.port ? `${hostname}:${url.port}` : hostname).replace(/:/g, "%3A")}`;
}

/**
 * ARD discovery identifier urn:air:<publisher>:<namespace>:<name>. The
 * publisher segment is a domain name, so it is the host without its port,
 * lowercased, an IDN in punycode, one trailing dot removed.
 */
export function urnAir(host: string, namespace: string, name: string): string {
  const publisher = stripTrailingDot(new URL(`https://${host}`).hostname);
  return `urn:air:${publisher}:${namespace}:${name}`;
}

/**
 * Letters NFKD leaves as they are, with the ASCII they are written as. Applied
 * after lowercasing, so only the lowercase forms are listed (an uppercase
 * letter, ẞ included, lowercases to one of these). Code points rather than
 * literals, so the table reads the same in any editor.
 */
const TRANSLITERATION: ReadonlyArray<readonly [number, string]> = [
  [0x00df, "ss"], // sharp s
  [0x00e6, "ae"], // ae
  [0x0153, "oe"], // oe
  [0x00f8, "o"], // o with stroke
  [0x0111, "d"], // d with stroke
  [0x0142, "l"], // l with stroke
  [0x00fe, "th"], // thorn
  [0x0131, "i"], // dotless i
  [0x00f0, "d"], // eth
  [0x0127, "h"], // h with stroke
  [0x0167, "t"], // t with stroke
  [0x014b, "n"], // eng
  [0x0138, "k"], // kra
];
const TRANSLITERATE = new Map(TRANSLITERATION.map(([cp, ascii]) => [String.fromCharCode(cp), ascii]));
const TRANSLITERATE_RE = new RegExp(`[${TRANSLITERATION.map(([cp]) => String.fromCharCode(cp)).join("")}]`, "g");

/**
 * Slug for skill names and ARD identifiers: NFKD, combining marks removed,
 * lowercased, the letters in TRANSLITERATION written in ASCII ("Grüße Welt"
 * becomes "grusse-welt"), then every run of characters outside a-z and 0-9
 * replaced by one hyphen and hyphens trimmed. Any other character outside a-z
 * and 0-9 separates. May return "": the build refuses an empty slug where one
 * is required.
 */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(TRANSLITERATE_RE, (ch) => TRANSLITERATE.get(ch) ?? ch)
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
 * The structural check an origin document must pass before cf-webmcp merges
 * into it: an object with an `entries` array whose members are objects with a
 * string `identifier`. The v0.91 manifest requires only `entries`, and
 * `identifier` is what the merge matches on. Deliberately not a full
 * validation of each entry against the ARD entry schema: one origin entry that
 * misses a term would then fail the document, and our entry would be dropped
 * with it.
 */
export function isArdDocument(value: unknown): value is ArdDocument {
  if (!isPlainObject(value)) return false;
  const entries = value["entries"];
  return Array.isArray(entries) && entries.every((e) => isPlainObject(e) && typeof e["identifier"] === "string");
}

/**
 * Content types read as an ARD document: application/json, any
 * application/<x>+json (the predecessor's application/ai-catalog+json,
 * application/ld+json), or none at all. text/json, text/plain and look-alikes
 * such as application/json-seq are not.
 */
export function isArdContentType(ct: string | null): boolean {
  if (!ct) return true;
  return /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(ct);
}
