/**
 * Mini-language for url_template placeholders.
 *
 *   {{name}}                 required, URL-encoded per position
 *   {{name|default:VALUE}}   fallback when input is missing
 *   {{name|optional}}        omit the surrounding query parameter when input is missing
 *   {{name|map:k=v,k=v}}     explicit value mapping
 *
 * Compile a template string into a `(input) => string` resolver plus a list of
 * referenced parameter names. The compile step is build-time; the returned
 * function is shipped into the Worker.
 */

export type Resolver = (input: Record<string, unknown>) => string;

export interface CompiledTemplate {
  raw: string;
  resolver: Resolver;
  /** Names of every placeholder referenced. */
  params: string[];
  /**
   * The path every URL this template resolves to must start with (see staticPathPrefix), or null
   * for a template without a placeholder. The executors check the resolved URL against it
   * (resolveUrl in src/executors/common.ts), after the URL parser has normalised the path.
   */
  pathPrefix: string | null;
}

interface Placeholder {
  name: string;
  operator: "required" | "default" | "optional" | "map";
  defaultValue?: string;
  mapping?: Map<string, string>;
}

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function parsePlaceholder(raw: string): Placeholder {
  const [namePart, opPart] = raw.split("|").map((s) => s.trim());
  if (!namePart) throw new Error(`empty placeholder name in "{{${raw}}}"`);
  if (!/^[a-z][a-z0-9_]*$/.test(namePart)) {
    throw new Error(`invalid placeholder name "${namePart}" in "{{${raw}}}"`);
  }
  if (!opPart) return { name: namePart, operator: "required" };

  if (opPart === "optional") return { name: namePart, operator: "optional" };

  if (opPart.startsWith("default:")) {
    return { name: namePart, operator: "default", defaultValue: opPart.slice("default:".length) };
  }

  if (opPart.startsWith("map:")) {
    const pairs = opPart.slice("map:".length).split(",");
    const map = new Map<string, string>();
    for (const pair of pairs) {
      const [k, v] = pair.split("=").map((s) => s.trim());
      if (!k || v === undefined) throw new Error(`malformed map operator in "{{${raw}}}"`);
      map.set(k, v);
    }
    return { name: namePart, operator: "map", mapping: map };
  }

  throw new Error(`unknown operator "${opPart}" in "{{${raw}}}"`);
}

/**
 * Determine whether a position in the URL is path or query.
 * Path: characters before the first unescaped `?`.
 * Query: characters after.
 */
function findPositions(template: string): Array<{ start: number; end: number; isQuery: boolean }> {
  const queryStart = template.indexOf("?");
  PLACEHOLDER_RE.lastIndex = 0;
  const out: Array<{ start: number; end: number; isQuery: boolean }> = [];
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const isQuery = queryStart !== -1 && start > queryStart;
    out.push({ start, end, isQuery });
  }
  return out;
}

/**
 * Compile a template string into a resolver function plus list of parameters.
 * Throws on malformed templates at build time.
 */
export function compileTemplate(template: string): CompiledTemplate {
  PLACEHOLDER_RE.lastIndex = 0;
  const placeholders: Array<Placeholder & { isQuery: boolean; rawMatch: string }> = [];
  const positions = findPositions(template);
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  let i = 0;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) {
    const inner = m[1];
    if (inner === undefined) {
      throw new Error(`internal: malformed regex match for "${m[0]}"`);
    }
    const pos = positions[i];
    if (!pos) {
      throw new Error(`internal: position info missing for placeholder #${i}`);
    }
    const parsed = parsePlaceholder(inner);
    placeholders.push({ ...parsed, isQuery: pos.isQuery, rawMatch: m[0] });
    i++;
  }

  const params = Array.from(new Set(placeholders.map((p) => p.name)));

  const resolver: Resolver = (input) => {
    let result = template;
    // Replace from right to left so earlier offsets stay valid.
    for (let idx = placeholders.length - 1; idx >= 0; idx--) {
      const p = placeholders[idx];
      if (!p) continue;
      const pos = positions[idx];
      if (!pos) continue;
      const value = resolvePlaceholder(p, input, pos.isQuery);
      if (value === OMIT) {
        // Strip surrounding query param (`&key=` or `?key=` to the next `&` or end).
        // Only valid in query positions.
        if (!p.isQuery) {
          throw new Error(`{{${p.name}|optional}} used in path position, cannot omit`);
        }
        result = stripQueryParam(result, pos.start, pos.end);
      } else {
        // Encode per position. Query positions escape every reserved char.
        // Path positions preserve `/` so multi-segment paths like "/blog/hello"
        // pass through cleanly. `?`, `#`, `&` stay encoded in both cases so
        // input cannot break out of its placeholder into query/fragment/auth.
        const encoded = p.isQuery ? encodeURIComponent(value) : encodePath(value);
        result = result.slice(0, pos.start) + encoded + result.slice(pos.end);
      }
    }
    return result;
  };

  return { raw: template, resolver, params, pathPrefix: staticPathPrefix(template) };
}

/**
 * The part of the path that no placeholder can reach: the template's text before its first
 * placeholder, as a path, cut after its last `/` (what follows the slash is the start of a segment
 * the placeholder continues). `https://example.com/api/{{id}}` has the prefix `/api/`, a template
 * rooted at the origin (`https://example.com{{path}}`, `https://example.com/{{path}}`) has `/` and
 * so keeps allowing any path, and when the first placeholder sits in the query the whole path is
 * fixed (`https://example.com/api/items?x={{q}}` has `/api/items`). The prefix is written the way
 * the URL parser writes a pathname, so that it compares with the one `new URL` produces.
 * Null for a template with no placeholder.
 */
export function staticPathPrefix(template: string): string | null {
  PLACEHOLDER_RE.lastIndex = 0;
  const first = PLACEHOLDER_RE.exec(template);
  PLACEHOLDER_RE.lastIndex = 0;
  if (first === null) return null;
  const head = template.slice(0, first.index);
  const authority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(head);
  if (authority === null) return null;
  const rest = head.slice(authority[0].length);
  let prefix = "/";
  if (rest.startsWith("/")) {
    const query = rest.search(/[?#]/);
    prefix = query === -1 ? rest.slice(0, rest.lastIndexOf("/") + 1) : rest.slice(0, query);
  }
  try {
    return new URL(`http://x${prefix}`).pathname;
  } catch {
    return prefix;
  }
}

const OMIT = Symbol("OMIT");
type ResolvedValue = string | typeof OMIT;

/**
 * Encode for path position. Like encodeURIComponent but preserves `/`
 * so callers can pass multi-segment paths. Still escapes anything that
 * could break out of the path (?, #, etc.).
 */
export function encodePath(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

/**
 * Whether a value written into a path holds a `.` or `..` segment, which the URL parser would
 * resolve and so move the request out of the path the template names. Segments are split on `/`
 * and on `\` (a backslash is a slash in a special URL), and percent-escapes are decoded first, up
 * to five layers deep, because `%2e%2e`, `..%2F` and `%252e%252e` all end up as `..` somewhere
 * that decodes them. The decoding is for this test only: the value goes out unchanged (encodePath
 * escapes its percent signs, so a `%2F` the caller wrote stays literal text, never a slash).
 * `..foo`, `v1.2`, `file.json` and `...` are ordinary names.
 */
function hasDotSegment(value: string): boolean {
  let v = value;
  for (let layer = 0; layer < 5; layer++) {
    if (v.split(/[/\\]/).some((segment) => segment === "." || segment === "..")) return true;
    const decoded = v.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    if (decoded === v) return false;
    v = decoded;
  }
  return false;
}

function resolvePlaceholder(p: Placeholder, input: Record<string, unknown>, isQuery: boolean): ResolvedValue {
  // An own property only: `input.constructor` of an input without one is the Object function.
  const raw = Object.prototype.hasOwnProperty.call(input, p.name) ? input[p.name] : undefined;
  const present = raw !== undefined && raw !== null && raw !== "";
  // The caller's own value, in a path: it must not climb out of the template's path. What the
  // publisher wrote (a default, a map value) is the publisher's.
  const fromCaller = (): string => {
    const value = String(raw);
    if (!isQuery && hasDotSegment(value)) {
      throw new Error(`{{${p.name}}} in a path position must not contain a "." or ".." path segment`);
    }
    return value;
  };

  if (p.operator === "required") {
    if (!present) throw new Error(`required parameter "${p.name}" missing`);
    return fromCaller();
  }
  if (p.operator === "optional") {
    return present ? fromCaller() : OMIT;
  }
  if (p.operator === "default") {
    return present ? fromCaller() : (p.defaultValue ?? "");
  }
  if (p.operator === "map") {
    const key = present ? String(raw) : "";
    const mapped = p.mapping?.get(key);
    if (mapped === undefined) {
      throw new Error(`map operator for "${p.name}" has no entry for key "${key}"`);
    }
    return mapped;
  }
  throw new Error(`unknown operator on placeholder "${p.name}"`);
}

/**
 * Given the placeholder span [start, end) inside `result`, find the smallest
 * surrounding query parameter (`&key=…` or `?key=…`) and remove it. Preserves
 * the leading `?` of the query string if removing the first parameter.
 */
function stripQueryParam(result: string, start: number, end: number): string {
  // Walk left to find `&` or `?`.
  let left = start;
  while (left > 0 && result[left - 1] !== "&" && result[left - 1] !== "?") left--;
  // Walk right to find `&` or end.
  let right = end;
  while (right < result.length && result[right] !== "&") right++;

  const leadChar = left > 0 ? result[left - 1] : "";
  if (leadChar === "?") {
    // Remove `?key=...&` (including trailing `&`) or `?key=...` (no trailing).
    if (right < result.length && result[right] === "&") {
      // Convert `?...&` into `?` then keep the rest.
      return result.slice(0, left) + result.slice(right + 1);
    }
    // Remove `?key=...` entirely including the leading `?`.
    return result.slice(0, left - 1) + result.slice(right);
  }
  if (leadChar === "&") {
    // Remove `&key=...` including the leading `&`.
    return result.slice(0, left - 1) + result.slice(right);
  }
  // No surrounding delimiter found; just blank the placeholder.
  return result.slice(0, start) + result.slice(end);
}
