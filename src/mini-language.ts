/**
 * Mini-language for url_template placeholders.
 *
 *   {{name}}                 required, URL-encoded per position
 *   {{name|default:VALUE}}   fallback when input is missing
 *   {{name|optional}}        omit the surrounding query parameter when input is missing
 *   {{name|map:k=v,k=v}}     explicit value mapping
 *
 * One operator per placeholder: they do not combine.
 *
 * Compile a template string into a `(input) => string` resolver plus a list of
 * referenced parameter names. The compile step is build-time; the returned
 * function is shipped into the Worker.
 *
 * An `|optional` placeholder must be the whole value of a query parameter with a fixed key
 * (`?key={{name|optional}}` or `&key={{name|optional}}`): dropping the parameter drops everything
 * between its `?` or `&` and the next `&`, so anything else in it would go too. One in the path,
 * the fragment or a shared parameter is refused when the template is compiled.
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
  /**
   * True when the first placeholder sits in the query (or fragment): no placeholder reaches the
   * path, pathPrefix is the whole path, and a resolved pathname must equal it, not merely start
   * with it (`/api` is never `/api-admin`).
   */
  pathExact: boolean;
  /**
   * Every placeholder in template order: its name, its operator, whether it sits in the query (or
   * fragment), and for a `map:` the keys it maps (empty for the other operators).
   */
  slots: ReadonlyArray<{ name: string; operator: Placeholder["operator"]; isQuery: boolean; mapKeys: readonly string[] }>;
}

interface Placeholder {
  name: string;
  operator: "required" | "default" | "optional" | "map";
  defaultValue?: string;
  mapping?: Map<string, string>;
}

const PLACEHOLDER_RE = /\{\{\s*([^}]+?)\s*\}\}/g;

export function parsePlaceholder(raw: string): Placeholder {
  const parts = raw.split("|").map((s) => s.trim());
  // Operators do not combine, and a default: or map: value cannot hold a "|": the text after a
  // second "|" used to be dropped without a word (`{{x|optional|map:...}}` read as optional).
  if (parts.length > 2) {
    throw new Error(
      `a placeholder takes one operator, and a default: or map: value cannot hold "|": "{{${raw}}}" has ${parts.length - 1}`,
    );
  }
  const [namePart, opPart] = parts;
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
 * The template with every placeholder replaced by as many `_` as it is long: the same offsets,
 * and only the template's own text left to search. A `?`, `#` or `&` inside a `default:` or
 * `map:` value (`{{a|default:v?1}}`) is the placeholder's, so it never starts the query, the
 * fragment or a parameter; a `?` there used to turn the placeholders after it into query
 * values, which exempted them from the dot-segment check. The config schema reads a template's
 * authority through it too (src/config-types.ts).
 */
export function maskPlaceholders(template: string): string {
  PLACEHOLDER_RE.lastIndex = 0;
  const masked = template.replace(PLACEHOLDER_RE, (whole) => "_".repeat(whole.length));
  PLACEHOLDER_RE.lastIndex = 0;
  return masked;
}

/** A piece of a compiled template: text as written, or the placeholder at this index. */
type Piece = { text: string } | { slot: number };

/** One query parameter of the template: the text between its `?` or `&` and the next `&`. */
interface QueryParam {
  pieces: Piece[];
  /** The placeholder that is the parameter's whole value when it is `|optional`, else null. */
  optional: number | null;
}

/**
 * Compile a template string into a resolver function plus list of parameters.
 * Throws on malformed templates at build time.
 *
 * The template is cut into its path (up to its own first `?` or `#`), its query parameters
 * (split on its own `&`) and its fragment (from its own first `#`), each a list of pieces, once.
 * The resolver writes every piece afresh and leaves out a parameter whose `|optional` value is
 * missing; nothing is cut out of a string by offsets.
 */
export function compileTemplate(template: string): CompiledTemplate {
  const placeholders: Array<Placeholder & { isQuery: boolean; rawMatch: string; start: number; end: number }> = [];
  const masked = maskPlaceholders(template);
  // The path ends at the template's own first `?` or `#`; a placeholder after that is a query
  // (or fragment) value.
  const queryOrFragment = masked.search(/[?#]/);
  const pathEnd = queryOrFragment === -1 ? template.length : queryOrFragment;
  const hasQuery = masked[pathEnd] === "?";
  const hashAt = masked.indexOf("#", pathEnd);
  const fragmentStart = hashAt === -1 ? template.length : hashAt;

  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(template)) !== null) {
    const inner = m[1];
    if (inner === undefined) {
      throw new Error(`internal: malformed regex match for "${m[0]}"`);
    }
    const parsed = parsePlaceholder(inner);
    const start = m.index;
    placeholders.push({ ...parsed, isQuery: start > pathEnd, rawMatch: m[0], start, end: start + m[0].length });
  }
  PLACEHOLDER_RE.lastIndex = 0;

  // The pieces of template[from, to). A placeholder never straddles a boundary: the boundaries
  // come from the masked text, where a placeholder holds no `?`, `#` or `&`.
  const piecesOf = (from: number, to: number): Piece[] => {
    const out: Piece[] = [];
    let at = from;
    placeholders.forEach((p, slot) => {
      if (p.start < from || p.end > to) return;
      if (p.start > at) out.push({ text: template.slice(at, p.start) });
      out.push({ slot });
      at = p.end;
    });
    if (at < to) out.push({ text: template.slice(at, to) });
    return out;
  };
  const textOf = (pieces: Piece[]): string =>
    pieces.map((piece) => ("text" in piece ? piece.text : placeholders[piece.slot]!.rawMatch)).join("");

  const pathPieces = piecesOf(0, pathEnd);
  const queryParams: QueryParam[] = [];
  if (hasQuery) {
    let from = pathEnd + 1;
    for (;;) {
      const amp = masked.indexOf("&", from);
      const to = amp === -1 || amp > fragmentStart ? fragmentStart : amp;
      const pieces = piecesOf(from, to);
      queryParams.push({ pieces, optional: optionalValueOf(pieces) });
      if (to === fragmentStart) break;
      from = to + 1;
    }
  }
  const fragmentPieces = piecesOf(fragmentStart, template.length);

  // `key=` and the placeholder, and nothing else: the shape whose parameter can be left out.
  function optionalValueOf(pieces: Piece[]): number | null {
    if (pieces.length !== 2) return null;
    const [key, value] = pieces;
    if (!key || !value || !("text" in key) || !("slot" in value)) return null;
    if (placeholders[value.slot]!.operator !== "optional") return null;
    return key.text.length > 1 && key.text.indexOf("=") === key.text.length - 1 ? value.slot : null;
  }

  placeholders.forEach((p, slot) => {
    if (p.operator !== "optional") return;
    const label = `{{${p.name}|optional}}`;
    if (!p.isQuery) {
      throw new Error(
        `${label} sits in the path, where it cannot be left out. |optional drops a query parameter: write it as the whole value of one, ` +
          `?key=${label} or &key=${label}, or give the placeholder a default (|default:VALUE).`,
      );
    }
    if (p.start > fragmentStart) {
      throw new Error(
        `${label} sits in the fragment, where it cannot be left out. |optional drops a query parameter: write it as the whole value of one, ` +
          `?key=${label} or &key=${label}, before the #.`,
      );
    }
    const param = queryParams.find((q) => q.pieces.some((piece) => "slot" in piece && piece.slot === slot));
    if (param?.optional !== slot) {
      throw new Error(
        `${label} must be the whole value of its query parameter, as in ?key=${label} or &key=${label}, with a fixed key: ` +
          `${JSON.stringify(param ? textOf(param.pieces) : "")} holds more, which leaving the parameter out would drop with it. ` +
          `Give the other part a parameter of its own, or use |default:VALUE.`,
      );
    }
  });

  const params = Array.from(new Set(placeholders.map((p) => p.name)));

  const resolver: Resolver = (input) => {
    // Every value first, right to left as the resolver always went, so that the first error
    // thrown for an input is the same one as before.
    const values: ResolvedValue[] = new Array<ResolvedValue>(placeholders.length);
    for (let idx = placeholders.length - 1; idx >= 0; idx--) {
      const p = placeholders[idx]!;
      values[idx] = resolvePlaceholder(p, input, p.isQuery);
    }
    // Encode per position. Query positions escape every reserved char.
    // Path positions preserve `/` so multi-segment paths like "/blog/hello"
    // pass through cleanly. `?`, `#`, `&` stay encoded in both cases so
    // input cannot break out of its placeholder into query/fragment/auth.
    const write = (pieces: Piece[]): string =>
      pieces
        .map((piece) => {
          if ("text" in piece) return piece.text;
          const value = values[piece.slot];
          if (value === OMIT || value === undefined) {
            throw new Error(`internal: {{${placeholders[piece.slot]!.name}|optional}} left out outside its own query parameter`);
          }
          return placeholders[piece.slot]!.isQuery ? encodeURIComponent(value) : encodePath(value);
        })
        .join("");

    let out = write(pathPieces);
    if (hasQuery) {
      const kept = queryParams.filter((q) => q.optional === null || values[q.optional] !== OMIT);
      // A query whose every parameter was left out goes with its `?`.
      if (kept.length > 0) out += `?${kept.map((q) => write(q.pieces)).join("&")}`;
    }
    return out + write(fragmentPieces);
  };

  return {
    raw: template,
    resolver,
    params,
    pathPrefix: staticPathPrefix(template),
    pathExact: placeholders[0]?.isQuery ?? false,
    slots: placeholders.map((p) => ({ name: p.name, operator: p.operator, isQuery: p.isQuery, mapKeys: [...(p.mapping?.keys() ?? [])] })),
  };
}

/**
 * The part of the path that no placeholder can reach: the template's text before its first
 * placeholder, as a path, cut after its last `/` (what follows the slash is the start of a segment
 * the placeholder continues). `https://example.com/api/{{id}}` has the prefix `/api/`, a template
 * rooted at the origin (`https://example.com{{path}}`, `https://example.com/{{path}}`) has `/` and
 * so keeps allowing any path, and when the first placeholder sits in the query the whole path is
 * fixed (`https://example.com/api/items?x={{q}}` has `/api/items`, which a resolved path must then
 * equal: see pathExact). The prefix is written the way the URL parser writes a pathname, so that
 * it compares with the one `new URL` produces. Null for a template with no placeholder.
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
