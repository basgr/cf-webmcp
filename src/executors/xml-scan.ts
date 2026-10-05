/**
 * Linear-time tag scanning for the sitemap parser.
 *
 * The parser used lazy regexes such as /<url\b[^>]*>([\s\S]*?)<\/url>/gi. On a body with many
 * tags that never close, each failed attempt scans to the end of the body before the engine
 * tries the next position: quadratic, and the body is origin's, up to 5 MiB (400 KB of <url>
 * took 4.8 s). These functions give the same matches in one pass:
 *
 *   - An element starts at `<tag` followed by a non-word character (the regex's \b), case-
 *     insensitively. Its start tag ends at the first `>` after the name, its content runs to
 *     the first `</tag>` after that, case-insensitively; the next search starts after it.
 *   - When an element has no `>` or no `</tag>` after it, no later one can have them either
 *     (their search would start further on), so the scan stops. That is where the regex
 *     re-scanned the rest of the body once per remaining start tag.
 *   - The `>` and `</tag>` searches only ever move forward, so every character is looked at a
 *     bounded number of times.
 */

/** Escape a tag name for a RegExp. Tag names here are fixed words, but the escape keeps that from mattering. */
function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The contents of the elements `<tag ...>content</tag>` in `xml`, in order, exactly as the global
 * regex `<tag\b[^>]*>([\s\S]*?)</tag>` with the `gi` flags finds them (empty contents included),
 * at most `limit` of them.
 */
export function elementContents(xml: string, tag: string, limit = Number.POSITIVE_INFINITY): string[] {
  const name = escapeTag(tag);
  const open = new RegExp(`<${name}\\b`, "gi");
  const close = new RegExp(`</${name}>`, "gi");
  const closeLength = tag.length + 3;
  const out: string[] = [];
  // The first `>` and the first close tag at or after the last position searched from: -2 not
  // searched yet, -1 none. Searches start further on each time, so a hit stays valid while it
  // lies at or after the next start.
  let gt = -2;
  let closeAt = -2;
  let cursor = 0;
  while (out.length < limit) {
    open.lastIndex = cursor;
    const start = open.exec(xml);
    if (start === null) break;
    const afterName = start.index + start[0].length;
    if (gt === -2 || (gt !== -1 && gt < afterName)) gt = xml.indexOf(">", afterName);
    if (gt === -1) break;
    const contentStart = gt + 1;
    if (closeAt === -2 || (closeAt !== -1 && closeAt < contentStart)) {
      close.lastIndex = contentStart;
      const end = close.exec(xml);
      closeAt = end === null ? -1 : end.index;
    }
    if (closeAt === -1) break;
    out.push(xml.slice(contentStart, closeAt));
    cursor = closeAt + closeLength;
  }
  return out;
}

/**
 * `text` with every `<![CDATA[...]]>` section replaced by its content, as
 * `text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")` does: a section without a `]]>` after it,
 * and everything after that, stays as written.
 */
export function unwrapCdata(text: string): string {
  const OPEN = "<![CDATA[";
  let out = "";
  let pos = 0;
  for (;;) {
    const open = text.indexOf(OPEN, pos);
    if (open === -1) break;
    const close = text.indexOf("]]>", open + OPEN.length);
    if (close === -1) break;
    out += text.slice(pos, open) + text.slice(open + OPEN.length, close);
    pos = close + 3;
  }
  return out + text.slice(pos);
}
