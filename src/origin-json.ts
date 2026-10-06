/**
 * JSON from origin, parsed with a bound on how deeply it nests.
 *
 * The Worker parses origin's JSON and writes it out again: the API catalog and the ARD manifest
 * a merge route splices its entry into, and an http_json answer that goes back in the exec
 * envelope. Serialisers recurse once per level of arrays and objects, so a 4 KB body of 2,000
 * nested arrays made JSON.stringify throw RangeError out of the route, and just below that
 * depth the 2-space indent the merges used turned 3 KB of input into 4.5 MB of output.
 *
 * So a document nested more than MAX_JSON_DEPTH levels deep is not used: the merge routes treat
 * it like a document that does not parse (the API catalog serves its synthesized catalog, the
 * ARD manifest relays origin's document as it came), and http_json answers schema_mismatch.
 * Preflight judges origin's documents with the same function.
 */

/** The deepest nesting of arrays and objects accepted in a JSON document from origin. */
export const MAX_JSON_DEPTH = 64;

export type OriginJson =
  | { ok: true; value: unknown }
  /** Nested more than MAX_JSON_DEPTH levels deep; not parsed. */
  | { ok: false; reason: "too_deep" }
  /** Not JSON. `message` is the parser's, which can quote origin's text: for the log only. */
  | { ok: false; reason: "syntax"; message: string };

/** `text` parsed as JSON, unless it nests arrays and objects more than MAX_JSON_DEPTH levels deep. */
export function parseOriginJson(text: string): OriginJson {
  if (nestsDeeperThan(text, MAX_JSON_DEPTH)) return { ok: false, reason: "too_deep" };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, reason: "syntax", message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Whether `text`, read as JSON, nests arrays and objects more than `limit` levels deep (`[]` is
 * one level, `[[]]` two, a scalar none). One pass, no recursion, and it stops at the first
 * bracket past the limit. Brackets inside a string do not count; a backslash in a string skips
 * the character after it, so an escaped quote does not end the string. Exact for valid JSON; for
 * text that is not JSON the answer does not matter, since JSON.parse refuses it either way.
 */
export function nestsDeeperThan(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) i++;
      else if (c === 0x22 /* " */) inString = false;
    } else if (c === 0x22) {
      inString = true;
    } else if (c === 0x5b /* [ */ || c === 0x7b /* { */) {
      if (++depth > limit) return true;
    } else if (c === 0x5d /* ] */ || c === 0x7d /* } */) {
      depth--;
    }
  }
  return false;
}
