/**
 * Build-time check for the CSS selectors in `[[forms]]`.
 *
 * Cloudflare's HTMLRewriter (lol-html) parses a selector eagerly and throws for
 * anything outside its streaming subset. At runtime that used to surface as an
 * error on every matching page, so the selectors are validated when the config
 * is compiled instead. The subset lol-html supports:
 *
 *   type, `*`, `#id`, `.class`, attribute selectors (`=` `~=` `^=` `$=` `*=`
 *   `|=`, optional ` i` / ` s` flag), descendant (whitespace) and child (`>`)
 *   combinators, `:nth-child()`, `:first-child`, `:nth-of-type()`,
 *   `:first-of-type` and `:not(<simple selector>)`.
 *
 * Not supported: the sibling combinators `+` and `~`, pseudo-elements (`::x`),
 * `:has()` and every other pseudo-class (`:hover`, `:last-child`, `:is()`, ...).
 *
 * Top-level commas are rejected too, although lol-html accepts a selector list
 * on its own: a param selector is composed as `${form.selector} ${param.selector}`,
 * and a comma list there would bind to the wrong half of the compound selector.
 *
 * The combinators `+` and `~` and the comma are judged only at depth 0 (outside
 * quotes, `[...]` and `(...)`). Quoted strings are opaque, so `[href="/a,b"]`
 * and `:nth-child(2n+1)` pass. Pseudo-classes and pseudo-elements are also
 * judged inside parentheses, because lol-html rejects an unsupported one
 * wherever it appears: `:not(:hover)` and `:not(:has(a))` fail here instead of
 * at request time.
 */

export interface SelectorCheckOptions {
  /**
   * Allow the selector to begin with the child combinator (`> input`). Param
   * selectors set this because they are appended to the form selector.
   */
  allowLeadingChild?: boolean;
}

const SUPPORTED_PSEUDO = new Set(["first-child", "first-of-type", "nth-child", "nth-of-type", "not"]);

const SUPPORTED_LIST =
  ":first-child, :first-of-type, :nth-child(), :nth-of-type() and :not()";

/** Index of the quote that closes the string opened at `open`, or -1 if unterminated. */
function closingQuote(s: string, open: number): number {
  const quote = s[open];
  for (let i = open + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++;
      continue;
    }
    if (s[i] === quote) return i;
  }
  return -1;
}

/** Returns null when the selector is acceptable, otherwise a message naming the problem. */
export function checkSelector(sel: string, opts: SelectorCheckOptions = {}): string | null {
  const s = sel.trim();
  if (s === "") return "selector must not be empty";

  let bracketDepth = 0;
  let parenDepth = 0;
  // Combinator placement: a `>` needs a compound selector on its left (except a
  // leading one, when allowed) and on its right.
  let tokens = 0;
  let hasCompound = false;
  let afterChild = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;

    if (ch === "\\") {
      // Escaped character: part of an identifier, never structure.
      i++;
      hasCompound = true;
      afterChild = false;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const end = closingQuote(s, i);
      if (end < 0) return "selector contains an unterminated quoted string";
      i = end;
      hasCompound = true;
      afterChild = false;
      continue;
    }

    if (bracketDepth > 0) {
      if (ch === "]") bracketDepth--;
      continue;
    }
    if (ch === "[") {
      bracketDepth++;
      if (parenDepth === 0) {
        hasCompound = true;
        afterChild = false;
      }
      continue;
    }

    if (ch === "(") {
      parenDepth++;
      continue;
    }
    if (ch === ")") {
      if (parenDepth === 0) return "selector has an unbalanced `)`";
      parenDepth--;
      continue;
    }

    if (ch === ":") {
      // Pseudo-classes are judged at any paren depth: lol-html rejects an
      // unsupported one wherever it appears (`:not(:hover)` throws too).
      if (s[i + 1] === ":") {
        return "pseudo-elements (`::name`) are not supported by Cloudflare HTMLRewriter";
      }
      const name = /^[A-Za-z0-9_-]*/.exec(s.slice(i + 1))![0].toLowerCase();
      if (name === "") return "selector has a `:` that is not followed by a pseudo-class name";
      if (name === "has") {
        return "`:has()` is not supported by Cloudflare HTMLRewriter (it cannot look ahead in a streamed document)";
      }
      if (!SUPPORTED_PSEUDO.has(name)) {
        return `pseudo-class \`:${name}\` is not supported by Cloudflare HTMLRewriter (supported: ${SUPPORTED_LIST})`;
      }
      i += name.length;
      if (parenDepth === 0) {
        tokens++;
        hasCompound = true;
        afterChild = false;
      }
      continue;
    }

    if (parenDepth > 0) continue;

    // Depth 0 from here on.
    if (ch === "]") return "selector has an unbalanced `]`";
    if (/\s/.test(ch)) continue;

    if (ch === ",") {
      return "selector lists (top-level commas) are not supported; give each form its own [[forms]] entry and each param its own [[forms.params]] entry";
    }

    if (ch === "+" || ch === "~") {
      return `the \`${ch}\` combinator is not supported by Cloudflare HTMLRewriter; use a descendant (space) or child (\`>\`) combinator`;
    }

    if (ch === ">") {
      if (!hasCompound) {
        if (afterChild) return "selector has two combinators in a row";
        if (tokens === 0 && !opts.allowLeadingChild) {
          return "selector must not start with a combinator";
        }
      }
      tokens++;
      hasCompound = false;
      afterChild = true;
      continue;
    }

    tokens++;
    hasCompound = true;
    afterChild = false;
  }

  if (bracketDepth > 0) return "selector has an unclosed `[`";
  if (parenDepth > 0) return "selector has an unclosed `(`";
  if (!hasCompound) return "selector must not end with a combinator";
  return null;
}
