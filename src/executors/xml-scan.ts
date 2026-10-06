/**
 * Linear-time tag scanning for the sitemap and feed parsers.
 *
 * The parsers used lazy regexes such as /<url\b[^>]*>([\s\S]*?)<\/url>/gi. On a body with many
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

/** What one `elementContents` call needs for a set of tag names, compiled once: a feed has thousands of blocks to scan. */
interface Scanner {
  open: RegExp;
  lowerNames: string[];
  closes: RegExp[];
  closeLengths: number[];
}

// The RegExps are global, so they carry a lastIndex; every use sets it first and no use calls back
// into another, so sharing them is safe. The names are fixed words, which keeps these caches small.
const scannersByName = new Map<string, Scanner>();
const scannersByList = new WeakMap<readonly string[], Scanner>();

function scannerFor(tag: string | readonly string[]): Scanner {
  const cached = typeof tag === "string" ? scannersByName.get(tag) : scannersByList.get(tag);
  if (cached !== undefined) return cached;
  const names = typeof tag === "string" ? [tag] : tag;
  const scanner: Scanner = {
    open: new RegExp(`<(${names.map(escapeTag).join("|")})\\b`, "gi"),
    lowerNames: names.map((n) => n.toLowerCase()),
    closes: names.map((n) => new RegExp(`</${escapeTag(n)}>`, "gi")),
    closeLengths: names.map((n) => n.length + 3),
  };
  if (typeof tag === "string") scannersByName.set(tag, scanner);
  else scannersByList.set(tag, scanner);
  return scanner;
}

/**
 * The contents of the elements `<tag ...>content</tag>` in `xml`, in order, exactly as the global
 * regex `<tag\b[^>]*>([\s\S]*?)</tag>` with the `gi` flags finds them (empty contents included),
 * at most `limit` of them.
 *
 * With several names (`["item", "entry"]`) an element is closed by its own name only, as the
 * regex `<(item|entry)\b[^>]*>([\s\S]*?)</\1>` has it: an `<item>` is not closed by `</entry>`. A
 * name with no close tag left after it drops out, and the scan goes on for the others; with no
 * name left, or no `>` left, it stops.
 */
export function elementContents(xml: string, tag: string | readonly string[], limit = Number.POSITIVE_INFINITY): string[] {
  const { open, lowerNames, closes, closeLengths } = scannerFor(tag);
  const out: string[] = [];
  // The first `>` at or after the last position searched from: -2 not searched yet, -1 none.
  // Searches start further on each time, so a hit stays valid while it lies at or after the next start.
  let gt = -2;
  // The same per name for the first close tag: -2 not searched yet, -1 none, which is final.
  const closeAt = lowerNames.map(() => -2);
  let alive = lowerNames.length;
  let cursor = 0;
  while (out.length < limit && alive > 0) {
    open.lastIndex = cursor;
    const start = open.exec(xml);
    if (start === null) break;
    const which = lowerNames.indexOf((start[1] as string).toLowerCase());
    const afterName = start.index + start[0].length;
    if (closeAt[which] === -1) {
      // This name has no close tag after an earlier start, so none after this one: no match here.
      cursor = start.index + 1;
      continue;
    }
    if (gt === -2 || (gt !== -1 && gt < afterName)) gt = xml.indexOf(">", afterName);
    if (gt === -1) break;
    const contentStart = gt + 1;
    if (closeAt[which] === -2 || (closeAt[which] as number) < contentStart) {
      const close = closes[which] as RegExp;
      close.lastIndex = contentStart;
      const end = close.exec(xml);
      closeAt[which] = end === null ? -1 : end.index;
    }
    const closeIndex = closeAt[which] as number;
    if (closeIndex === -1) {
      alive--;
      cursor = start.index + 1;
      continue;
    }
    out.push(xml.slice(contentStart, closeIndex));
    cursor = closeIndex + (closeLengths[which] as number);
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
