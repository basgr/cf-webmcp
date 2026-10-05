/**
 * Shared helpers for the widget pin in vendor/webmcp/current.json.
 *
 * The pin is the single source for everything about the served widget:
 *   - scripts/update-widget.ts writes it (makePin),
 *   - scripts/upload-widget.ts uploads the composed object under the key it names,
 *   - scripts/build-config.ts reads it to name the asset and emit the SRI hash.
 * All three derive the object key through widgetAssetName(), so the key the
 * build advertises and the key the upload writes cannot drift apart.
 *
 * "Served" bytes are what a browser receives: the MIT preamble
 * (src/widget-preamble.ts) followed by the pinned webmcp.js bytes. The Worker
 * serves the R2 object as-is, so served_sha256 / served_sri describe the R2
 * object exactly.
 */

import { createHash } from "node:crypto";

export interface WidgetPin {
  version: string;
  /** Hex sha256 of the raw upstream webmcp.js. */
  sha256: string;
  /** Hex sha256 of preamble + raw bytes (the R2 object). Names the asset. */
  served_sha256?: string;
  /** Complete SRI string, "sha384-" + base64(sha384(preamble + raw bytes)). */
  served_sri?: string;
  /** Hex sha256 of the LICENSE_PREAMBLE the served fields were computed with. */
  preamble_sha256?: string;
}

export interface ServedFields {
  served_sha256: string;
  served_sri: string;
  preamble_sha256: string;
}

/** Hex sha256. Strings are hashed as utf-8, byte arrays as given. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** The object served to browsers: utf-8 preamble bytes, then the raw bytes untouched. */
export function composeWidget(raw: Uint8Array, preamble: string): Uint8Array {
  const head = Buffer.from(preamble, "utf8");
  const out = new Uint8Array(head.length + raw.length);
  out.set(head, 0);
  out.set(raw, head.length);
  return out;
}

/** sha384 SRI value for the given bytes, e.g. "sha384-<64 base64 chars>". */
export function sriSha384(bytes: Uint8Array): string {
  return `sha384-${createHash("sha384").update(bytes).digest("base64")}`;
}

export function computeServedFields(raw: Uint8Array, preamble: string): ServedFields {
  const composed = composeWidget(raw, preamble);
  return {
    served_sha256: sha256Hex(composed),
    served_sri: sriSha384(composed),
    preamble_sha256: sha256Hex(preamble),
  };
}

/** The full pin update-widget writes. Key order is the order in current.json. */
export function makePin(version: string, raw: Uint8Array, preamble: string): Required<WidgetPin> {
  const served = computeServedFields(raw, preamble);
  return {
    version,
    sha256: sha256Hex(raw),
    served_sha256: served.served_sha256,
    served_sri: served.served_sri,
    preamble_sha256: served.preamble_sha256,
  };
}

/** R2 object key / file name for a served_sha256: widget.<first 16 hex>.js. */
export function widgetAssetName(servedSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(servedSha256)) {
    throw new Error(`served_sha256 must be a 64-character lowercase hex digest, got ${JSON.stringify(servedSha256)}`);
  }
  return `widget.${servedSha256.slice(0, 16)}.js`;
}
