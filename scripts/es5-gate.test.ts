import { describe, it, expect } from "vitest";
import { es5Violations, inlineScripts } from "../src/test-support/es5";

/**
 * The ES5 gate runs over the generated bootstrap and the landing page's inline scripts on
 * every build, so a gate that misses a construct lets that construct through. This file
 * checks the gate itself: every construct newer than ES5 it is meant to catch, and ES5 it
 * must leave alone.
 */

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const BAD: Array<[label: string, source: string, message: RegExp]> = [
  ["an arrow function", "var f = () => 1;", /arrow function/],
  ["let", "let a = 1;", /let or const/],
  ["const", "const a = 1;", /let or const/],
  ["a template literal", "var s = `x${1}`;", /template literal/],
  ["a template literal without substitutions", "var s = `x`;", /template literal/],
  ["a tagged template", "tag`x`;", /template/],
  ["spread in a call", "f(...[1, 2]);", /spread/],
  ["spread in an array", "var a = [...b];", /spread/],
  ["object spread", "var o = { ...b };", /spread/],
  ["a class", "class C {}", /class/],
  ["await", "async function f() { await g(); }", /await/],
  ["an async function", "var f = async function () {};", /async/],
  ["yield and a generator", "function* g() { yield 1; }", /yield|generator/],
  ["for...of", "for (var x of y) {}", /for\.\.\.of/],
  ["a shorthand property", "var o = { b };", /shorthand property/],
  ["a computed property name", "var o = { [k]: 1 };", /computed property name/],
  ["destructuring", "var { d } = o;", /destructuring/],
  ["method shorthand", "var o = { m() {} };", /method shorthand/],
  ["a default parameter", "function f(a = 1) {}", /default or rest parameter/],
  ["a rest parameter", "function f(...a) {}", /default or rest parameter|spread/],
  ["optional chaining", "var x = a?.b;", /optional chaining/],
  ["nullish coalescing", "var x = a ?? 1;", /nullish coalescing/],
  ["the exponent operator", "var x = a ** 2;", /exponent operator/],
  ["a trailing comma in call arguments", "f(1, 2,);", /trailing comma in call arguments/],
  ["a trailing comma in new arguments", "new F(1,);", /trailing comma in call arguments/],
  ["a trailing comma in a parameter list", "function f(a, b,) {}", /trailing comma in a parameter list/],
  ["a trailing comma in a function expression's parameters", "var f = function (a,) {};", /trailing comma in a parameter list/],
  ["regex flag u", "var r = /a/u;", /regex flag "u"/],
  ["regex flag y", "var r = /a/y;", /regex flag "y"/],
  ["regex flag s", "var r = /a/s;", /regex flag "s"/],
  ["regex flag d", "var r = /a/d;", /regex flag "d"/],
  ["regex flag v", "var r = /a/v;", /regex flag "v"/],
  ["a flag next to good ones", "var r = /a/gimu;", /regex flag "u"/],
  ["a regex named group", "var r = /(?<year>a)/;", /named group/],
  ["a regex lookbehind", "var r = /(?<=a)b/;", /lookbehind/],
  ["a regex negative lookbehind", "var r = /(?<!a)b/;", /lookbehind/],
  ["a named group after an escaped paren and a class", "var r = /\\([(?<a>]x(?<b>y)/;", /named group/],
  ["optional catch binding", "try { f(); } catch { g(); }", /optional catch binding/],
  ["||=", "a ||= 1;", /logical assignment/],
  ["&&=", "a &&= 1;", /logical assignment/],
  ["??=", "a ??= 1;", /logical assignment/],
  ["a numeric separator", "var n = 1_000;", /numeric separator/],
  ["a BigInt literal", "var n = 10n;", /BigInt/],
  ["a binary literal", "var n = 0b101;", /binary or octal literal/],
  ["an octal literal", "var n = 0o17;", /binary or octal literal/],
  ["a code point escape in a string", 'var s = "\\u{1F600}";', /code point escape/],
  ["a raw U+2028 in a string", `var s = 'a${LS}b';`, /U\+2028 or U\+2029|syntax error/],
  ["a raw U+2029 in a string", `var s = 'a${PS}b';`, /U\+2028 or U\+2029|syntax error/],
  ["new.target", "function F() { return new.target; }", /new\.target/],
  ["import.meta", "var u = import.meta.url;", /import\.meta/],
  ["a dynamic import", "import('x');", /dynamic import/],
  ["an import declaration", "import x from 'y';", /import or export/],
  ["an export declaration", "export var x = 1;", /import or export/],
  ["export default", "export default 1;", /import or export/],
  ["export from", "export { a } from 'b';", /import or export/],
  ["a TypeScript type annotation", "var x: number = 1;", /syntax error/],
  ["a TypeScript interface", "interface I { a: number }", /syntax error/],
  ["a TypeScript as cast", "var x = y as number;", /syntax error/],
];

const GOOD: Array<[label: string, source: string]> = [
  ["the plain ES5 subset", "var f = function (a, b) { return a ? [a, b] : { x: 1, y: [2, 3], }; };"],
  ["trailing commas in array and object literals", "var a = [1, 2,]; var o = { a: 1, b: 2, };"],
  ["regex flags g, i and m", "var r = /a(?:b)(?=c)(?!d)[(?<x>]\\(?<y/gim;"],
  ["a plain catch", "try { f(); } catch (e) { g(e); }"],
  ["hex, exponent and legacy numbers", "var n = [0xFF, 1e3, 1.5, 0];"],
  ["escapes in strings", "var s = '\\u00e9\\x41\\n\\u2028';"],
  ["function declarations and expressions", "function f() { return function g() { return 1; }; } f()();"],
  ["Object.create, forEach and JSON", "Object.create(null); [1].forEach(function (x) { JSON.stringify(x); });"],
];

describe("es5Violations", () => {
  it.each(BAD)("catches %s", (_label, source, message) => {
    const found = es5Violations(source);
    expect(found.join("\n")).toMatch(message);
    expect(found.length).toBeGreaterThan(0);
  });

  it.each(GOOD)("passes %s", (_label, source) => {
    expect(es5Violations(source)).toEqual([]);
  });

  it("reports the line number of each violation", () => {
    const found = es5Violations("var a = 1;\nvar b = 2;\nlet c = 3;\n");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/\(line 3\)$/);
  });
});

describe("inlineScripts", () => {
  it("returns the text of a classic inline script", () => {
    expect(inlineScripts("<p>x</p><script>var a = 1;</script>")).toEqual(["var a = 1;"]);
  });

  it("skips a script with a src attribute", () => {
    expect(inlineScripts('<script src="/a.js"></script><script SRC = \'/b.js\' defer></script>')).toEqual([]);
  });

  it("does not take data-src for src", () => {
    expect(inlineScripts('<script data-src="/a.js">var a = 1;</script>')).toEqual(["var a = 1;"]);
    expect(inlineScripts('<script data-x="y" nosrc="1">var b = 2;</script>')).toEqual(["var b = 2;"]);
  });

  it("closes on </script> with whitespace or capitals", () => {
    expect(inlineScripts("<script>var a = 1;</script >after<script>var b = 2;</SCRIPT\n>")).toEqual([
      "var a = 1;",
      "var b = 2;",
    ]);
  });

  it("copes with a > inside a quoted attribute value", () => {
    expect(inlineScripts('<script data-x="a>b" src="/a.js"></script><script data-x=\'a>b\'>var c = 3;</script>')).toEqual([
      "var c = 3;",
    ]);
  });

  it.each(["module", "application/ld+json", "application/json", "text/template", "importmap", "speculationrules"])(
    "skips a script of type %s",
    (type) => {
      expect(inlineScripts(`<script type="${type}">var a = 1;</script>`)).toEqual([]);
    },
  );

  it.each(["", "text/javascript", "application/javascript", "TEXT/JAVASCRIPT", "text/ecmascript"])(
    "keeps a classic script of type %j",
    (type) => {
      expect(inlineScripts(`<script type="${type}">var a = 1;</script>`)).toEqual(["var a = 1;"]);
    },
  );

  it("skips type=module written without quotes or with other attributes around it", () => {
    expect(inlineScripts("<script defer type=module>var a = 1;</script>")).toEqual([]);
    expect(inlineScripts('<script async type = "module" crossorigin>var a = 1;</script>')).toEqual([]);
  });
});
