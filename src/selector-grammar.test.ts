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

describe("checkSelector accepts what lol-html supports", () => {
  const accepted = [
    "form",
    "form#contact",
    "form.a.b",
    'form[action="/a,b"]',
    "form#x > input",
    "form>input",
    '[name="q" i]',
    '[name="q" s]',
    '[class~="a"]',
    '[lang|="en"]',
    '[href^="https://"]',
    '[href$=".pdf"]',
    '[href*="x"]',
    "[data-x]",
    'form[title="a + b ~ c > d"]',
    "form[title='a, b']",
    "li:nth-child(2n+1)",
    "li:nth-child(2n + 1)",
    ":nth-child(-n+3)",
    ":nth-child(odd)",
    ":nth-child(even)",
    "li:first-child",
    "li:nth-of-type(2)",
    "li:first-of-type",
    ":not(.a)",
    "input:not([type=hidden])",
    "input[type=email]",
    "*",
    "form *",
    "form  input",
    "form .a #b",
    "div:not(.a, .b)",
    "input:not(:first-child)",
    "li:not(:nth-child(2))",
    "div:not(a b)",
  ];
  for (const sel of accepted) {
    it(`accepts ${JSON.stringify(sel)}`, () => {
      expect(checkSelector(sel, { allowLeadingChild: false })).toBeNull();
    });
  }

  it("every accepted selector really is accepted by the HTMLRewriter in this runtime", () => {
    const refused = accepted.filter((sel) => !lolHtmlAccepts(sel));
    expect(refused).toEqual([]);
  });

  it("a param selector with a leading child combinator works once joined to its form selector", () => {
    expect(lolHtmlAccepts("form#c > input")).toBe(true);
    expect(checkSelector("> input", { allowLeadingChild: true })).toBeNull();
  });

  it("accepts a leading child combinator only when allowLeadingChild is set", () => {
    expect(checkSelector("> input", { allowLeadingChild: true })).toBeNull();
    expect(checkSelector(">input", { allowLeadingChild: true })).toBeNull();
    expect(checkSelector("> input", { allowLeadingChild: false })).toMatch(/combinator/);
    expect(checkSelector("> input", {})).toMatch(/combinator/);
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
  ];
  for (const [sel, message] of rejected) {
    it(`rejects ${JSON.stringify(sel)}`, () => {
      expect(checkSelector(sel, { allowLeadingChild: false })).toMatch(message);
    });
  }

  it("every rejected selector is refused by the HTMLRewriter too, except comma lists (rejected on purpose)", () => {
    const stillAccepted = rejected
      .map(([sel]) => sel)
      .filter((sel) => !sel.includes(","))
      .filter((sel) => lolHtmlAccepts(sel));
    expect(stillAccepted).toEqual([]);
    // The comma list is the deliberate difference: lol-html takes it, but a param selector is
    // composed as `${form} ${param}`, where a list would bind to the wrong half.
    expect(lolHtmlAccepts("form#a, form#b")).toBe(true);
  });

  it("rejects a leading child combinator on a form selector", () => {
    expect(checkSelector("> input", { allowLeadingChild: false })).not.toBeNull();
  });

  it("still rejects bad constructs in a param selector when a leading child is allowed", () => {
    expect(checkSelector("> input:has(a)", { allowLeadingChild: true })).toMatch(/:has/);
    expect(checkSelector("> input, > select", { allowLeadingChild: true })).toMatch(/list|comma/i);
    expect(checkSelector("+ input", { allowLeadingChild: true })).toMatch(/\+/);
  });

  it("rejects a trailing or doubled combinator", () => {
    expect(checkSelector("form >", { allowLeadingChild: false })).toMatch(/combinator/);
    expect(checkSelector("form > > input", { allowLeadingChild: false })).toMatch(/combinator/);
    expect(checkSelector(">", { allowLeadingChild: true })).toMatch(/combinator/);
  });

  it("rejects an empty selector and unbalanced brackets, parentheses and quotes", () => {
    expect(checkSelector("", {})).not.toBeNull();
    expect(checkSelector("   ", {})).not.toBeNull();
    expect(checkSelector("form[a=b", {})).not.toBeNull();
    expect(checkSelector("form]", {})).not.toBeNull();
    expect(checkSelector("li:nth-child(2", {})).not.toBeNull();
    expect(checkSelector("li)", {})).not.toBeNull();
    expect(checkSelector('form[a="b]', {})).not.toBeNull();
  });
});

describe("checkSelector treats quoted strings and nested groups as opaque", () => {
  it("does not look inside quoted attribute values", () => {
    expect(checkSelector('form[data-x=":has(a), b + c ~ d > e"]', {})).toBeNull();
    expect(checkSelector("form[data-x='::before']", {})).toBeNull();
  });

  it("honours backslash escapes inside quotes and in identifiers", () => {
    expect(checkSelector('form[data-x="a\\"+b"]', {})).toBeNull();
    expect(checkSelector("form#a\\,b", {})).toBeNull();
    expect(checkSelector("form.a\\+b", {})).toBeNull();
  });

  it("does not flag + or , inside parentheses or brackets", () => {
    expect(checkSelector("li:nth-child(2n+1)", {})).toBeNull();
    expect(checkSelector("input:not([a=b], [c=d])", {})).toBeNull();
    expect(checkSelector("input[a~=b]", {})).toBeNull();
  });
});
