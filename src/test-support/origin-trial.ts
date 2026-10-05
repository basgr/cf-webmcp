/**
 * Test-only helpers: assemble a Chrome origin-trial token by hand, so tests never
 * carry a real token. Layout (third-party-independent part, versions 2 and 3):
 *
 *   byte 0        version
 *   bytes 1-64    Ed25519 signature (64 zero bytes here: nothing verifies it)
 *   bytes 65-68   payload length, big-endian uint32
 *   bytes 69-     UTF-8 JSON payload
 *
 * Only atob/btoa, Uint8Array, DataView and TextEncoder are used, so the helper runs
 * in both vitest pools (workerd and node).
 */

export interface TokenParts {
  /** Default 3. */
  version?: number;
  /** Default 64 zero bytes. Pass a length to change the signature size. */
  signatureLength?: number;
  /** Length written into the header. Default: the real payload length. */
  declaredLength?: number;
  /** Bytes appended after the payload. */
  trailing?: Uint8Array;
}

export interface TokenPayload {
  origin?: string;
  feature?: string;
  /** Seconds since epoch. */
  expiry?: number;
  isSubdomain?: boolean;
  isThirdParty?: boolean;
  usage?: string;
}

/** Seconds since epoch, `days` days from now (negative for the past). */
export function expiryInDays(days: number): number {
  return Math.floor(Date.now() / 1000 + days * 86_400);
}

/** The binary token layout around an arbitrary payload, base64 encoded. */
export function encodeOriginTrialToken(payload: Uint8Array | string, parts: TokenParts = {}): string {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const signatureLength = parts.signatureLength ?? 64;
  const trailing = parts.trailing ?? new Uint8Array(0);
  const bytes = new Uint8Array(1 + signatureLength + 4 + body.length + trailing.length);
  bytes[0] = parts.version ?? 3;
  // The signature stays zero-filled.
  new DataView(bytes.buffer).setUint32(1 + signatureLength, parts.declaredLength ?? body.length, false);
  bytes.set(body, 1 + signatureLength + 4);
  bytes.set(trailing, 1 + signatureLength + 4 + body.length);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * A well-formed token. Defaults: the example.com origin with its explicit port (as Chrome
 * issues it), the WebMCP feature, one year of validity. Pass `payload` fields to override
 * or, with `undefined`, to drop one; `parts` changes the binary framing.
 */
export function makeOriginTrialToken(payload: TokenPayload = {}, parts: TokenParts = {}): string {
  const full: TokenPayload = {
    origin: "https://example.com:443",
    feature: "WebMCP",
    expiry: expiryInDays(365),
    ...payload,
  };
  return encodeOriginTrialToken(JSON.stringify(full), parts);
}
