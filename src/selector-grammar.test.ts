import { describe, expect, it } from "vitest";
import { checkSelector } from "./selector-grammar";

/** Does the real Cloudflare HTMLRewriter (lol-html) take this selector? It parses eagerly in `.on()`. */
function lolHtmlAccepts(selector: string): boolean {
  try {
    new HTMLRewriter().on(selector, { element() {} });
    return true;
  } catch {
    return false;
  }
}

const form = { allowLeadingChild: false };

describe("checkSelector accepts what lol-html supports", () => {
  const accepted = [
    "form",
    "form#contact",
    "form.a.b",
    'form[action="/a,b"]',
    'form[action="/contact"]',
    "form#x > input",
    "form>input",
    "form >input",
    "form> input",
    '[name="q" i]',
    '[name="q" s]',
    "[name=q i]",
    '[class~="a"]',
    '[lang|="en"]',
    '[href^="https://"]',
    '[href$=".pdf"]',
    '[href*="x"]',
    "[data-x]",
    "[ data-x ]",
    "[a = b]",
    '[data-id="123"]',
    '[a=""]',
    'form[title="a + b ~ c > d"]',
    "form[title='a, b']",
    'form[data-x=":has(a), b + c ~ d > e"]',
    "li:nth-child(2n+1)",
    "li:nth-child(2n + 1)",
    ":nth-child(-n+3)",
    ":nth-child(-n + 3)",
    ":nth-child(odd)",
    ":nth-child(even)",
    ":nth-child(3)",
    ":nth-child( 2n+1 )",
    "li:first-child",
    "li:nth-of-type(2)",
    "li:first-of-type",
    ":not(.a)",
    "input:not([type=hidden])",
    "input[type=email]",
    "input[name=your-name]",
    "textarea[name=message]",
    "*",
    "form *",
    "form  input",
    "form .a #b",
    "div:not(.a, .b)",
    "div:not(a b)",
    "div:not(a > b)",
    "input:not(:first-child)",
    "li:not(:nth-child(2))",
    ":not(:not(.a))",
    "form.wpcf7-form",
    "form#contact-form",
    "h1",
    "x-widget",
    "form.-a",
    "form._a",
    "form.café",
    "form\tinput",
    " form ",
  ];
  for (const sel of accepted) {
    it(`accepts ${JSON.stringify(sel)}`, () => {
      expect(checkSelector(sel, form)).toBeNull();
    });
  }

  it("every accepted selector really is accepted by the HTMLRewriter in this runtime", () => {
    expect(accepted.filter((sel) => !lolHtmlAccepts(sel))).toEqual([]);
  });

  it("accepts a leading child combinator only when allowLeadingChild is set", () => {
    expect(checkSelector("> input", { allowLeadingChild: true })).toBeNull();
    expect(checkSelector(">input", { allowLeadingChild: true })).toBeNull();
    expect(checkSelector("> input", { allowLeadingChild: false })).toMatch(/combinator/);
    expect(checkSelector("> input", {})).toMatch(/combinator/);
  });

  it("a param selector with a leading child combinator works once joined to its form selector", () => {
    expect(lolHtmlAccepts("form#c > input")).toBe(true);
  });

  it("accepts a top-level list only when allowList is set (dom_extract)", () => {
    expect(checkSelector("main, article, [role=main]", { allowList: true })).toBeNull();
    expect(checkSelector("main,article", { allowList: true })).toBeNull();
    expect(checkSelector("main, article", {})).toMatch(/list|comma/i);
    expect(checkSelector("main, article", form)).toMatch(/list|comma/i);
  });

  it("still applies every other rule in list mode", () => {
    expect(checkSelector("main, article:has(a)", { allowList: true })).toMatch(/:has/);
    expect(checkSelector("main, , article", { allowList: true })).not.toBeNull();
    expect(checkSelector("main,", { allowList: true })).not.toBeNull();
    expect(checkSelector(",main", { allowList: true })).not.toBeNull();
    expect(checkSelector("main, article + p", { allowList: true })).toMatch(/\+/);
  });
});

describe("checkSelector rejects what lol-html cannot handle", () => {
  const rejected: Array<[string, RegExp]> = [
    ["form:has(input)", /:has/],
    ["form + form", /\+/],
    ["form ~ div", /~/],
    ["form+form", /\+/],
    ["a::before", /::|pseudo-element/],
    ["form#a, form#b", /list|comma/i],
    ["input:hover", /:hover/],
    ["input:checked", /:checked/],
    ["li:last-child", /:last-child/],
    ["form:is(.a)", /:is/],
    // lol-html throws on an unsupported pseudo-class even inside :not(...).
    ["div:not(:hover)", /:hover/],
    ["div:not(:has(a))", /:has/],
    ["div:not(a::before)", /::|pseudo-element/],
    ["div:not(a + b)", /\+/],
  ];
  for (const [sel, message] of rejected) {
    it(`rejects ${JSON.stringify(sel)}`, () => {
      expect(checkSelector(sel, form)).toMatch(message);
    });
  }

  // Selectors a config author could plausibly write, each of which makes lol-html throw
  // and which a denylist-style grammar let through.
  const realisticTypos = [
    "form[action=/contact]",
    "form[action=/de/kontakt/]",
    "form[data-id=123]",
    "input[name=2fa]",
    "form[name=]",
    "form#123",
    "form.1abc",
    "form.",
    "form#",
    "form:not()",
    "form:not",
    "form:nth-child",
    "form:nth-child()",
    "form:nth-child(foo)",
    "form:nth-child(2n+1 of .a)",
    "form:nth-child(odd of .a)",
    "form:nth-of-type()",
    "form:first-child(x)",
    "form:first-child()",
    "form:first-of-type()",
  ];
  for (const sel of realisticTypos) {
    it(`rejects the typo ${JSON.stringify(sel)}`, () => {
      expect(checkSelector(sel, form)).not.toBeNull();
      expect(lolHtmlAccepts(sel)).toBe(false);
    });
  }

  const contrived = [
    "form\\:has(a)",
    "form[a b]",
    'form[a="b" x]',
    '[a="b" i s]',
    "form[ns|a]",
    "svg|rect",
    "*|a",
    "form!",
    "form;",
    "form()",
    'form "x"',
    "form\u000binput",
    "form input",
    'form/*"*/:hover/*"*/',
    "form/*[*/:hover/*]*/",
    "form/*x*/",
    "form[a~ =b]",
    "form[1a]",
    "form[a.b]",
    "form@",
    "form{",
    "**",
    "form*",
    "form:",
    "form:-x",
    ":nth-child(- n+3)",
    ":nth-child(+ 2)",
    ":nth-child(n+n)",
    ":nth-child(1.5)",
    ":not(a, )",
    ":not(, a)",
    ":not(> a)",
    ":not(a >)",
    ':not("x")',
  ];
  for (const sel of contrived) {
    it(`rejects ${JSON.stringify(sel)}`, () => {
      expect(checkSelector(sel, form)).not.toBeNull();
    });
  }

  it("gives the reason for the common mistakes", () => {
    expect(checkSelector("form[action=/contact]", form)).toMatch(/quote/);
    expect(checkSelector("form#123", form)).toMatch(/identifier/);
    expect(checkSelector("form.", form)).toMatch(/class/);
    expect(checkSelector("form:not()", form)).toMatch(/:not/);
    expect(checkSelector("form:nth-child(foo)", form)).toMatch(/nth-child/);
    expect(checkSelector("form:first-child(x)", form)).toMatch(/no argument/);
    expect(checkSelector("form/* x */", form)).toMatch(/comment/);
    expect(checkSelector("form[ns|a]", form)).toMatch(/namespace/);
    expect(checkSelector("svg|rect", form)).toMatch(/namespace/);
  });

  it("rejects a leading child combinator on a form selector", () => {
    expect(checkSelector("> input", form)).not.toBeNull();
  });

  it("still rejects bad constructs in a param selector when a leading child is allowed", () => {
    expect(checkSelector("> input:has(a)", { allowLeadingChild: true })).toMatch(/:has/);
    expect(checkSelector("> input, > select", { allowLeadingChild: true })).toMatch(/list|comma/i);
    expect(checkSelector("+ input", { allowLeadingChild: true })).toMatch(/\+/);
    expect(checkSelector("> > input", { allowLeadingChild: true })).toMatch(/combinator/);
  });

  it("rejects a trailing or doubled combinator", () => {
    expect(checkSelector("form >", form)).toMatch(/combinator/);
    expect(checkSelector("form > > input", form)).toMatch(/combinator/);
    expect(checkSelector(">", { allowLeadingChild: true })).toMatch(/combinator/);
  });

  it("rejects an empty selector and unbalanced brackets, parentheses and quotes", () => {
    expect(checkSelector("", {})).not.toBeNull();
    expect(checkSelector("   ", {})).not.toBeNull();
    expect(checkSelector("form[a=b", {})).not.toBeNull();
    expect(checkSelector("form]", {})).not.toBeNull();
    expect(checkSelector("li:nth-child(2", {})).not.toBeNull();
    expect(checkSelector("li)", {})).not.toBeNull();
    expect(checkSelector(":not(.a", {})).not.toBeNull();
    expect(checkSelector(":not(.a))", {})).not.toBeNull();
    expect(checkSelector('form[a="b]', {})).not.toBeNull();
  });

  it("rejects pathological nesting instead of recursing without bound", () => {
    const deep = ":not(".repeat(200) + ".a" + ")".repeat(200);
    expect(checkSelector(deep, {})).toMatch(/nested/);
  });
});

describe("checkSelector treats quoted strings and nested groups as opaque", () => {
  it("does not look inside quoted attribute values", () => {
    expect(checkSelector('form[data-x=":has(a), b + c ~ d > e"]', {})).toBeNull();
    expect(checkSelector("form[data-x='::before']", {})).toBeNull();
    expect(checkSelector('form[data-x="/* not a comment */"]', {})).toBeNull();
  });

  it("rejects backslash escapes in identifiers and inside quoted values", () => {
    expect(checkSelector("form#a\\,b", {})).toMatch(/backslash/);
    expect(checkSelector("form.a\\+b", {})).toMatch(/backslash/);
    expect(checkSelector('form[data-x="a\\"+b"]', {})).toMatch(/backslash/);
  });

  it("rejects control characters and line breaks inside quoted values", () => {
    expect(checkSelector('form[a="x\ny"]', {})).not.toBeNull();
    expect(checkSelector('form[a="x\u0000y"]', {})).not.toBeNull();
    expect(checkSelector('form[a="x\ty"]', {})).toBeNull();
  });

  it("does not flag + or , inside parentheses or brackets", () => {
    expect(checkSelector("li:nth-child(2n+1)", {})).toBeNull();
    expect(checkSelector("input:not([a=b], [c=d])", {})).toBeNull();
    expect(checkSelector("input[a~=b]", {})).toBeNull();
  });
});
