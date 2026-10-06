import { describe, expect, it } from "vitest";
import { MAX_JSON_DEPTH, nestsDeeperThan, parseOriginJson } from "./origin-json";

/** The nesting depth by brute force: the smallest limit that `text` does not exceed. */
function depthOf(text: string): number {
  let limit = 0;
  while (nestsDeeperThan(text, limit)) limit++;
  return limit;
}

describe("nestsDeeperThan", () => {
  it.each([
    ["1", 0],
    ['"text"', 0],
    ["[]", 1],
    ["{}", 1],
    ["[[]]", 2],
    ['{"a":{"b":[1]}}', 3],
    ["[[],[[]],[]]", 3],
    ['[{"a":[]},{"b":{"c":{}}}]', 4],
  ])("%s is %i levels deep", (text, depth) => {
    expect(depthOf(text)).toBe(depth);
  });

  it("does not count brackets inside a string", () => {
    expect(depthOf(JSON.stringify({ text: "[[[[{{{{" }))).toBe(1);
  });

  it("an escaped quote does not end the string, and an escaped backslash does not escape the quote after it", () => {
    // ["\"[[[["]: the string holds a quote and four brackets.
    expect(depthOf(JSON.stringify(['"[[[[']))).toBe(1);
    // ["\\",[[]]]: the string holds one backslash and ends before the arrays.
    expect(depthOf(JSON.stringify(["\\", [[]]]))).toBe(3);
  });

  it("counts every level, at the limit and one over", () => {
    const nested = (n: number) => "[".repeat(n) + "]".repeat(n);
    expect(nestsDeeperThan(nested(MAX_JSON_DEPTH), MAX_JSON_DEPTH)).toBe(false);
    expect(nestsDeeperThan(nested(MAX_JSON_DEPTH + 1), MAX_JSON_DEPTH)).toBe(true);
  });
});

describe("parseOriginJson", () => {
  it("is 64 levels", () => {
    expect(MAX_JSON_DEPTH).toBe(64);
  });

  it("parses a document within the limit", () => {
    expect(parseOriginJson('{"a":[1,2]}')).toEqual({ ok: true, value: { a: [1, 2] } });
  });

  it("refuses a document over the limit without parsing it", () => {
    expect(parseOriginJson("[".repeat(2_000) + "]".repeat(2_000))).toEqual({ ok: false, reason: "too_deep" });
    // Text that is too deep is refused as such even when it would not parse.
    expect(parseOriginJson("[".repeat(65))).toEqual({ ok: false, reason: "too_deep" });
  });

  it("reports text that is not JSON with the parser's message, for the log", () => {
    const r = parseOriginJson("<html>");
    expect(r.ok).toBe(false);
    if (r.ok || r.reason !== "syntax") throw new Error("expected a syntax failure");
    expect(r.message.length).toBeGreaterThan(0);
  });
});
