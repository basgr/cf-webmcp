/**
 * Ground truth for src/selector-grammar.ts: the real HTMLRewriter (lol-html) in
 * this runtime. `HTMLRewriter.on(selector)` parses eagerly, so a selector it
 * cannot handle throws right there.
 *
 * The invariant is one-directional. Whatever checkSelector accepts, lol-html must
 * accept too, because a selector that passes the build but throws at request time
 * costs injection on the page (or, before the per-selector guard, on every page).
 * The grammar may refuse things lol-html would take (comments, comma lists in a
 * form selector, `:not(a + b)`); that is deliberate strictness, not a bug.
 */

import { describe, expect, it } from "vitest";
import { checkSelector } from "./selector-grammar";
import { HAND_WRITTEN_CORPUS, generatedSelectors } from "./test-support/selector-corpus";

function lolHtmlThrows(selector: string): string | null {
  try {
    new HTMLRewriter().on(selector, { element() {} });
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * Asserts that no selector the grammar accepts under `options` is refused by the
 * real rewriter. Reports the count and the first few as `selector => reason`
 * (a full diff of a large failing sweep would take minutes to print).
 */
function expectNoViolations(corpus: string[], options: Parameters<typeof checkSelector>[1]): void {
  const found: string[] = [];
  for (const sel of corpus) {
    if (checkSelector(sel, options) !== null) continue;
    // A param selector is appended to its form selector; that composite is what lol-html sees.
    const seen = options?.allowLeadingChild ? `form#c ${sel}` : sel;
    const reason = lolHtmlThrows(seen);
    if (reason !== null) found.push(`${JSON.stringify(seen)} => ${reason}`);
  }
  expect(found.slice(0, 15), `${found.length} accepted selector(s) refused by lol-html`).toEqual([]);
}

describe("selector grammar vs the real HTMLRewriter: accepted implies lol-html accepts", () => {
  it("holds for the hand-written corpus as a form selector", () => {
    expectNoViolations(HAND_WRITTEN_CORPUS, { allowLeadingChild: false });
  });

  it("holds for the hand-written corpus as a param selector (composed after the form selector)", () => {
    expectNoViolations(HAND_WRITTEN_CORPUS, { allowLeadingChild: true });
  });

  it("holds for the hand-written corpus as a standalone list (dom_extract)", () => {
    expectNoViolations(HAND_WRITTEN_CORPUS, { allowList: true });
  });

  it("holds for a deterministic generated sweep of atom combinations", { timeout: 120_000 }, () => {
    const sweep = generatedSelectors();
    expect(sweep.length).toBeGreaterThan(100_000);
    expectNoViolations(sweep, {});
    // The other two modes share the grammar; a strided subset keeps the run short.
    const strided = sweep.filter((_, i) => i % 4 === 0);
    expectNoViolations(strided, { allowLeadingChild: true });
    expectNoViolations(strided, { allowList: true });
  });

  it("the sweep and corpus exercise both outcomes (the invariant is not vacuous)", () => {
    const pool = [...HAND_WRITTEN_CORPUS, ...generatedSelectors(0)];
    const accepted = pool.filter((s) => checkSelector(s, {}) === null);
    const rejected = pool.filter((s) => checkSelector(s, {}) !== null);
    expect(accepted.length).toBeGreaterThan(5_000);
    expect(rejected.length).toBeGreaterThan(5_000);
    // lol-html itself refuses a large share of what the grammar refuses, so the corpus is not all valid.
    // (A refusal costs about a millisecond and a half, so sample rather than ask about all of them.)
    const sample = rejected.filter((_, i) => i % 200 === 0).slice(0, 800);
    expect(sample.filter((s) => lolHtmlThrows(s) !== null).length).toBeGreaterThan(300);
  });
});
