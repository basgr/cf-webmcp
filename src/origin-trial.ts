/**
 * Chrome origin-trial tokens, as far as cf-webmcp needs them: decode a token to read
 * what it was issued for, and put tokens on a response as `Origin-Trial` headers.
 *
 * Chrome ships WebMCP as an origin trial. A site opts in by sending its token in an
 * `Origin-Trial` response header on the top-level HTML document; without one, only
 * browsers with the flag on get WebMCP. The tokens come from the publisher
 * ([origin_trial].tokens), they are never generated here and never verified: the
 * Ed25519 signature is Chrome's to check.
 *
 * Pure: atob, Uint8Array, DataView, TextDecoder and Headers only, no Buffer and no
 * Workers APIs, so the same code runs in the build (node) and in the Worker (workerd).
 *
 * Token layout (the part that does not depend on third-party use), after base64:
 *
 *   byte 0        version, 2 or 3
 *   bytes 1-64    Ed25519 signature
 *   bytes 65-68   payload length, big-endian uint32
 *   bytes 69-     UTF-8 JSON payload
 */

/** What the config schema accepts as a token: standard base64, padding optional up to two "=". */
export const ORIGIN_TRIAL_TOKEN_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const SIGNATURE_LENGTH = 64;
const LENGTH_OFFSET = 1 + SIGNATURE_LENGTH;
const PAYLOAD_OFFSET = LENGTH_OFFSET + 4;
const SUPPORTED_VERSIONS: readonly number[] = [2, 3];

export interface OriginTrialPayload {
  /** The origin the token was issued for, with an explicit port, e.g. "https://example.com:443". */
  origin: string;
  /** The trial's feature name, e.g. "WebMCP". Whatever the token says; nothing is hard-coded. */
  feature: string;
  /** Seconds since the epoch. */
  expiry: number;
  /** The token also covers every subdomain of `origin`'s host. */
  isSubdomain?: boolean;
  /** Issued for a script from another origin; Chrome ignores it as a header on a first-party document. */
  isThirdParty?: boolean;
}

export interface DecodedOriginTrialToken {
  version: number;
  payload: OriginTrialPayload;
}

/**
 * A reference to a token that is safe in an error message or a log line: at most the first
 * eight characters, and always shorter than the token itself.
 */
function ref(token: string): string {
  return `${token.slice(0, Math.min(8, token.length >> 1))}...`;
}

function fail(token: string, reason: string): never {
  throw new Error(`origin-trial token ${ref(token)}: ${reason}`);
}

/**
 * Decodes a token and validates the shape of what it carries. The signature is not
 * checked. Throws an Error on anything malformed; the message names the token by a
 * short prefix only, never in full.
 */
export function decodeOriginTrialToken(token: string): DecodedOriginTrialToken {
  if (!ORIGIN_TRIAL_TOKEN_RE.test(token)) fail(token, "not valid base64");

  let bytes: Uint8Array;
  try {
    const binary = atob(token);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch {
    return fail(token, "not valid base64");
  }

  if (bytes.length < PAYLOAD_OFFSET) {
    fail(token, `too short (${bytes.length} bytes, the fixed header alone is ${PAYLOAD_OFFSET})`);
  }

  const version = bytes[0]!;
  if (!SUPPORTED_VERSIONS.includes(version)) {
    fail(token, `unsupported version ${version} (expected ${SUPPORTED_VERSIONS.join(" or ")})`);
  }

  const payloadLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(LENGTH_OFFSET, false);
  if (payloadLength > bytes.length - PAYLOAD_OFFSET) {
    fail(token, `payload length is ${payloadLength} bytes but only ${bytes.length - PAYLOAD_OFFSET} follow`);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + payloadLength));
  } catch {
    return fail(token, "payload is not valid UTF-8");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(token, "payload is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) fail(token, "payload is not a JSON object");
  const p = raw as Record<string, unknown>;

  if (typeof p["origin"] !== "string") fail(token, "payload.origin must be a string");
  let originUrl: URL;
  try {
    originUrl = new URL(p["origin"]);
  } catch {
    return fail(token, "payload.origin is not a URL");
  }
  if (originUrl.protocol !== "https:" && originUrl.protocol !== "http:") {
    fail(token, "payload.origin must be an http(s) origin");
  }

  if (typeof p["feature"] !== "string" || p["feature"] === "") fail(token, "payload.feature must be a non-empty string");

  const expiry = p["expiry"];
  if (typeof expiry !== "number" || !Number.isFinite(expiry)) {
    fail(token, "payload.expiry must be a finite number (seconds since the epoch)");
  }
  if (Number.isNaN(new Date(expiry * 1000).getTime())) fail(token, "payload.expiry is outside the range of dates");

  const payload: OriginTrialPayload = { origin: p["origin"], feature: p["feature"], expiry };
  for (const key of ["isSubdomain", "isThirdParty"] as const) {
    const value = p[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") fail(token, `payload.${key} must be a boolean when present`);
    payload[key] = value;
  }
  return { version, payload };
}

/**
 * Puts one `Origin-Trial` header per token on `headers`. A value the origin already sent
 * stays, ours is appended after it, and a token that is already present (as its own header
 * or inside a comma-separated list) is not added a second time.
 */
export function appendOriginTrialHeaders(headers: Headers, tokens: readonly string[]): void {
  if (tokens.length === 0) return;
  const present = new Set(
    (headers.get("origin-trial") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== ""),
  );
  for (const token of tokens) {
    if (present.has(token)) continue;
    headers.append("origin-trial", token);
    present.add(token);
  }
}
