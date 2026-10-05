/**
 * MIT license notice that travels with the vendored jasonjmcghee/WebMCP widget.
 *
 * scripts/upload-widget.ts uploads ONE object to R2: this preamble followed by
 * the pinned webmcp.js bytes. The Worker serves that object as-is, so the SRI
 * hash in vendor/webmcp/current.json (`served_sri`) covers exactly what a
 * browser receives. Plain string, no Workers types: node scripts import it too.
 *
 * Changing this text changes the composed bytes and therefore the widget URL.
 * Re-run `npm run update-widget` afterwards so current.json records the new
 * `preamble_sha256`, `served_sha256` and `served_sri`.
 *
 * Built from an explicit line list joined with "\n" so the bytes do not depend
 * on the line endings of this source file (Windows checkouts use CRLF).
 */
export const LICENSE_PREAMBLE: string =
  [
    "/*!",
    " * jasonjmcghee/WebMCP - MIT License",
    " * https://github.com/jasonjmcghee/WebMCP/blob/main/LICENSE",
    " *",
    " * Pinned and served by cf-webmcp.",
    " */",
  ].join("\n") + "\n";
