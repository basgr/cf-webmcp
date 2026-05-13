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
      const value = resolvePlaceholder(p, input);
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

  return { raw: template, resolver, params };
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

function resolvePlaceholder(p: Placeholder, input: Record<string, unknown>): ResolvedValue {
  const raw = input[p.name];
  const present = raw !== undefined && raw !== null && raw !== "";

  if (p.operator === "required") {
    if (!present) throw new Error(`required parameter "${p.name}" missing`);
    return String(raw);
  }
  if (p.operator === "optional") {
    return present ? String(raw) : OMIT;
  }
  if (p.operator === "default") {
    return present ? String(raw) : (p.defaultValue ?? "");
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
