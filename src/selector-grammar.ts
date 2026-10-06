/**
 * Build-time check for the CSS selectors in the config (`[[forms]]` selectors,
 * `dom_extract` selector and strip entries).
 *
 * Cloudflare's HTMLRewriter (lol-html) parses a selector eagerly and throws for
 * anything outside its streaming subset. This is a POSITIVE grammar: it accepts
 * exactly the constructs below and rejects everything else, so a typo cannot
 * slip through just because nobody thought to list it as forbidden. The
 * invariant it must keep (and which src/selector-grammar.ground-truth.test.ts
 * checks against the real rewriter) is one-directional: whatever this accepts,
 * lol-html accepts too. Being stricter than lol-html is fine.
 *
 *   selector      := complex ("," complex)*          (list only when allowed)
 *   complex       := [">"] compound (combinator compound)*
 *   not-list      := compound ("," compound)*        (inside :not; no combinators)
 *   combinator    := whitespace | ">"
 *   compound      := (type | "*") (#id | .class | [attr] | :pseudo)*
 *   type, id, class, attr name: CSS identifier, no escapes, no namespace (`ns|x`)
 *   [attr]        := [name] | [name op value]; op is = ~= ^= $= *= |=;
 *                    value is an identifier or a quoted string, then an optional
 *                    case flag ` i` or ` s`
 *   :pseudo       := :first-child | :first-of-type          (no argument)
 *                  | :nth-child(an+b) | :nth-of-type(an+b)  (an+b, odd, even)
 *                  | :not(not-list)                         (non-empty)
 *
 * Rejected: the sibling combinators `+` and `~`, `::pseudo-elements`, `:has()`
 * and every other pseudo-class, comments, backslash escapes, namespaces, unquoted
 * attribute values that are not identifiers (`[a=/x]`, `[a=1]`), identifiers that
 * start with a digit or are empty (`#1`, `.`), `:nth-child(... of S)`, malformed
 * brackets, quotes and parentheses, and any character outside the selector
 * alphabet. Whitespace is space, tab, LF, CR and FF only.
 *
 * Also rejected, each because the real rewriter fails on it (see the ground-truth
 * test): a combinator inside `:not()` (workerd 1.20260815 and 1.20261001 refuse
 * `:not(a b)` and `:not(a > b)`; older builds took them), uppercase ASCII letters in an attribute NAME (lol-html throws "explicit
 * namespaces" once an operator follows; HTML attribute names match
 * case-insensitively, so lowercase loses nothing), lone UTF-16 surrogates, and
 * selectors over 1024 characters or 64 compounds (a chain of a few thousand
 * compounds takes the worker process down in transform(), where no guard can
 * catch it).
 *
 * Top-level commas are rejected unless `allowList` is set: a form-param selector
 * is composed as `${form.selector} ${param.selector}`, where a comma list would
 * bind to the wrong half of the compound selector. dom_extract selectors stand
 * alone and may be lists.
 */

export interface SelectorCheckOptions {
  /**
   * Allow the selector to begin with the child combinator (`> input`). Param
   * selectors set this because they are appended to the form selector.
   */
  allowLeadingChild?: boolean;
  /** Allow a top-level comma list (`main, article`). Inside `:not(...)` lists are always allowed. */
  allowList?: boolean;
}

/** How deep `:not(:not(...))` may nest; bounds recursion on hostile input. */
const MAX_NESTING = 16;

/** Longest selector accepted, in UTF-16 code units. */
const MAX_LENGTH = 1024;

/** Most compounds in one selector, counted across the whole input including inside `:not()` and list entries. */
const MAX_COMPOUNDS = 64;

const SUPPORTED_LIST = ":first-child, :first-of-type, :nth-child(), :nth-of-type() and :not()";

const IDENT_START = /[\p{L}_]/u;
const IDENT_CHAR = /[\p{L}\p{M}\p{N}_-]/u;
const NTH_ARG = /^[ \t\n\r\f]*(?:odd|even|[+-]?\d+|[+-]?\d*n(?:[ \t\n\r\f]*[+-][ \t\n\r\f]*\d+)?)[ \t\n\r\f]*$/i;

const LIST_MESSAGE =
  "selector lists (top-level commas) are not supported here; give each form its own [[forms]] entry and each param its own [[forms.params]] entry";
const END_COMBINATOR_MESSAGE = "selector must not end with a combinator";
const DOUBLE_COMBINATOR_MESSAGE = "selector has two combinators in a row";
const NOT_COMBINATOR_MESSAGE =
  "`:not()` takes compound selectors only in Cloudflare HTMLRewriter: write `:not(.a)` or `:not(.a, .b)`, not `:not(.a .b)` or `:not(a > b)`";
const NAMESPACE_MESSAGE = "namespaced selectors (`ns|name`) are not supported by Cloudflare HTMLRewriter";
const BACKSLASH_MESSAGE =
  'backslash escapes are not supported; match the attribute instead, e.g. [class~="sm:flex"] or [id="123"]';
const UPPERCASE_ATTRIBUTE_MESSAGE =
  'attribute names must be lowercase: HTML attribute names match case-insensitively, so [action="..."] also matches ACTION in the markup, while an uppercase name in the selector never matches';

/**
 * Thrown by fail(). Deliberately not an Error: it is control flow inside this module,
 * and skipping the stack capture makes rejecting a selector about ten times cheaper,
 * which matters for the ground-truth sweep over a few hundred thousand strings.
 */
class Rejected {
  constructor(readonly message: string) {}
}

function fail(message: string): never {
  throw new Rejected(message);
}

function siblingMessage(ch: string): string {
  return `the \`${ch}\` combinator is not supported by Cloudflare HTMLRewriter; use a descendant (space) or child (\`>\`) combinator`;
}

class Parser {
  private i = 0;
  private compounds = 0;

  constructor(
    private readonly s: string,
    private readonly opts: SelectorCheckOptions,
  ) {}

  run(): void {
    if (this.s.length > MAX_LENGTH) fail(`selector is too long (limit ${MAX_LENGTH} characters)`);
    if (this.s.trim() === "") fail("selector must not be empty");
    // A lone surrogate (for instance from a TOML "\uD800" escape) is not valid UTF-8 for
    // lol-html; a valid pair is one code point of another category and passes.
    if (/\p{Cs}/u.test(this.s)) fail("selector contains a lone surrogate (invalid UTF-16)");
    this.list(false, this.opts.allowLeadingChild === true, 0);
    // list() stops at the end of input or at a `)` it does not own.
    if (this.i < this.s.length) fail("selector has an unbalanced `)`");
  }

  private peek(offset = 0): string | undefined {
    return this.s[this.i + offset];
  }

  /** Skips whitespace; true if any was skipped. */
  private ws(): boolean {
    const start = this.i;
    while (this.i < this.s.length && " \t\n\r\f".includes(this.s[this.i]!)) this.i++;
    return this.i > start;
  }

  private atListEnd(): boolean {
    const c = this.peek();
    return c === undefined || c === "," || c === ")";
  }

  private identStartAt(index: number): boolean {
    let c = this.s[index];
    if (c === "-") c = this.s[index + 1];
    return c !== undefined && IDENT_START.test(c);
  }

  private ident(): void {
    if (this.peek() === "-") this.i++;
    while (this.i < this.s.length && IDENT_CHAR.test(this.s[this.i]!)) this.i++;
  }

  /** fail(), except that a backslash at the current position gets the escape message with its workaround. */
  private failHere(message: string): never {
    if (this.peek() === "\\") fail(BACKSLASH_MESSAGE);
    return fail(message);
  }

  private unexpected(): never {
    const c = this.peek();
    if (c === undefined) fail("selector ends unexpectedly");
    if (c === "/" && this.peek(1) === "*") fail("comments are not supported in selectors");
    if (c === "\\") fail(BACKSLASH_MESSAGE);
    if (c === "|") fail(NAMESPACE_MESSAGE);
    if (c === '"' || c === "'") fail("quoted strings are only allowed as attribute values");
    if (c === "]") fail("selector has an unbalanced `]`");
    if (c === ")") fail("selector has an unbalanced `)`");
    if (c === "+" || c === "~") fail(siblingMessage(c));
    return fail(`unexpected character ${JSON.stringify(c)} at position ${this.i}`);
  }

  private list(inNot: boolean, leadingAllowed: boolean, depth: number): void {
    let leading = leadingAllowed;
    for (;;) {
      this.complex(leading, depth, inNot);
      leading = false;
      this.ws();
      if (this.peek() !== ",") return;
      if (!inNot && !this.opts.allowList) fail(LIST_MESSAGE);
      this.i++;
      this.ws();
      if (this.atListEnd()) fail("selector list has an empty entry");
    }
  }

  private complex(leadingAllowed: boolean, depth: number, inNot: boolean): void {
    this.ws();
    const first = this.peek();
    if (first === ">") {
      if (!leadingAllowed) fail("selector must not start with a combinator");
      this.i++;
      this.ws();
      if (this.atListEnd()) fail(END_COMBINATOR_MESSAGE);
      if (this.peek() === ">") fail(DOUBLE_COMBINATOR_MESSAGE);
    } else if (first === "+" || first === "~") {
      fail(siblingMessage(first));
    }
    this.compound(depth);
    for (;;) {
      const hadWhitespace = this.ws();
      if (this.atListEnd()) return;
      const c = this.peek()!;
      if (c === "+" || c === "~") fail(siblingMessage(c));
      if (inNot && (c === ">" || hadWhitespace)) fail(NOT_COMBINATOR_MESSAGE);
      if (c === ">") {
        this.i++;
        this.ws();
        if (this.atListEnd()) fail(END_COMBINATOR_MESSAGE);
        if (this.peek() === ">") fail(DOUBLE_COMBINATOR_MESSAGE);
        this.compound(depth);
        continue;
      }
      if (!hadWhitespace) this.unexpected();
      this.compound(depth);
    }
  }

  private compound(depth: number): void {
    if (++this.compounds > MAX_COMPOUNDS) {
      fail(`selector has too many compounds (limit ${MAX_COMPOUNDS}, counting those inside :not())`);
    }
    let parts = 0;
    if (this.peek() === "*") {
      this.i++;
      parts++;
    } else if (this.identStartAt(this.i)) {
      this.ident();
      parts++;
    }
    if (parts === 1 && this.peek() === "|") fail(NAMESPACE_MESSAGE);
    for (;;) {
      const c = this.peek();
      if (c === "#") {
        this.i++;
        this.requireIdent("`#` must be followed by an identifier (not empty, not starting with a digit)");
      } else if (c === ".") {
        this.i++;
        this.requireIdent("`.` must be followed by a class name (not empty, not starting with a digit)");
      } else if (c === "[") {
        this.attribute();
      } else if (c === ":") {
        this.pseudo(depth);
      } else {
        break;
      }
      parts++;
    }
    if (parts === 0) this.unexpected();
  }

  private requireIdent(message: string): void {
    if (!this.identStartAt(this.i)) this.failHere(message);
    this.ident();
  }

  private attribute(): void {
    this.i++; // [
    this.ws();
    if (!this.identStartAt(this.i)) {
      this.failHere("attribute selector must start with an attribute name (an identifier)");
    }
    const nameStart = this.i;
    this.ident();
    if (/[A-Z]/.test(this.s.slice(nameStart, this.i))) fail(UPPERCASE_ATTRIBUTE_MESSAGE);
    this.ws();
    const c = this.peek();
    if (c === "]") {
      this.i++;
      return;
    }
    if (c === "=") {
      this.i++;
    } else if (c !== undefined && "~^$*|".includes(c) && this.peek(1) === "=") {
      this.i += 2;
    } else if (c === "|") {
      fail(NAMESPACE_MESSAGE);
    } else {
      this.failHere("attribute selector expects `]` or one of the operators = ~= ^= $= *= |= after the name");
    }
    this.ws();
    const v = this.peek();
    if (v === '"' || v === "'") {
      this.quoted();
    } else if (this.identStartAt(this.i)) {
      this.ident();
    } else {
      this.failHere(
        "attribute value must be an identifier or a quoted string; quote values that start with a digit or contain characters such as / . : ( )",
      );
    }
    const hadWhitespace = this.ws();
    const flag = this.peek();
    if (hadWhitespace && flag !== undefined && "iIsS".includes(flag)) {
      const after = this.peek(1);
      if (after === "]" || (after !== undefined && " \t\n\r\f".includes(after))) {
        this.i++;
        this.ws();
      }
    }
    if (this.peek() !== "]") {
      this.failHere("attribute selector must end with `]` (only one case flag, `i` or `s`, may follow the value)");
    }
    this.i++;
  }

  private quoted(): void {
    const quote = this.s[this.i]!;
    this.i++;
    for (;;) {
      if (this.i >= this.s.length) fail("selector contains an unterminated quoted string");
      const c = this.s[this.i]!;
      if (c === quote) {
        this.i++;
        return;
      }
      if (c === "\\") fail(BACKSLASH_MESSAGE);
      const code = c.charCodeAt(0);
      if ((code < 0x20 && c !== "\t") || code === 0x7f) {
        fail("control characters and line breaks are not allowed inside quoted strings");
      }
      this.i++;
    }
  }

  private pseudo(depth: number): void {
    this.i++; // :
    if (this.peek() === ":") fail("pseudo-elements (`::name`) are not supported by Cloudflare HTMLRewriter");
    const start = this.i;
    while (this.i < this.s.length && IDENT_CHAR.test(this.s[this.i]!)) this.i++;
    const name = this.s.slice(start, this.i).toLowerCase();
    if (name === "") fail("`:` must be followed by a pseudo-class name");
    if (name === "has") {
      fail("`:has()` is not supported by Cloudflare HTMLRewriter (it cannot look ahead in a streamed document)");
    }

    switch (name) {
      case "first-child":
      case "first-of-type":
        if (this.peek() === "(") fail(`\`:${name}\` takes no argument`);
        return;

      case "nth-child":
      case "nth-of-type": {
        if (this.peek() !== "(") fail(`\`:${name}\` needs an argument such as (2n+1), (odd) or (3)`);
        const close = this.s.indexOf(")", this.i);
        if (close < 0) fail("selector has an unclosed `(`");
        const arg = this.s.slice(this.i + 1, close);
        if (!NTH_ARG.test(arg)) {
          if (arg.includes("\\")) fail(BACKSLASH_MESSAGE);
          fail(`\`:${name}(${arg.trim()})\` is not valid; use an+b (2n+1, -n+3), odd, even or a number`);
        }
        this.i = close + 1;
        return;
      }

      case "not": {
        if (this.peek() !== "(") fail("`:not` needs an argument in parentheses");
        if (depth + 1 > MAX_NESTING) fail("selector is nested too deeply");
        this.i++;
        this.ws();
        if (this.peek() === ")") fail("`:not()` needs a non-empty argument");
        this.list(true, false, depth + 1);
        this.ws();
        if (this.peek() !== ")") fail("selector has an unclosed `(`");
        this.i++;
        return;
      }

      default:
        fail(`pseudo-class \`:${name}\` is not supported by Cloudflare HTMLRewriter (supported: ${SUPPORTED_LIST})`);
    }
  }
}

/** Returns null when the selector is acceptable, otherwise a message naming the problem. */
export function checkSelector(sel: string, opts: SelectorCheckOptions = {}): string | null {
  try {
    new Parser(sel, opts).run();
    return null;
  } catch (e) {
    if (e instanceof Rejected) return e.message;
    throw e;
  }
}
