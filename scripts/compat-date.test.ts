import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import TOML from "@iarna/toml";

/**
 * The Workers compatibility date is set in four places: the three wrangler
 * configs and the miniflare override in vitest.config.ts. They must stay
 * identical, otherwise tests run against a different runtime behaviour set
 * than the one that ships. Bump all four together, and never past the date
 * encoded in the installed workerd version (1.YYYYMMDD.N).
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

function wranglerDate(rel: string): unknown {
  const parsed = TOML.parse(read(rel)) as Record<string, unknown>;
  return parsed.compatibility_date;
}

function vitestDate(): unknown {
  const match = read("vitest.config.ts").match(/compatibilityDate:\s*"([^"]*)"/);
  return match ? match[1] : undefined;
}

const SOURCES: Array<[string, () => unknown]> = [
  ["wrangler.example.toml", () => wranglerDate("wrangler.example.toml")],
  ["wrangler.dev.toml", () => wranglerDate("wrangler.dev.toml")],
  ["wrangler.test.toml", () => wranglerDate("wrangler.test.toml")],
  ["vitest.config.ts", vitestDate],
];

describe("compatibility date", () => {
  for (const [name, get] of SOURCES) {
    it(`${name} sets a YYYY-MM-DD compatibility date`, () => {
      const value = get();
      expect(typeof value).toBe("string");
      expect(value as string).toMatch(DATE_PATTERN);
      expect(Number.isNaN(Date.parse(value as string))).toBe(false);
    });
  }

  it("is identical across wrangler.example.toml, wrangler.dev.toml, wrangler.test.toml and vitest.config.ts", () => {
    const dates = Object.fromEntries(SOURCES.map(([name, get]) => [name, get()]));
    const unique = new Set(Object.values(dates));
    expect(unique.size, JSON.stringify(dates)).toBe(1);
  });
});
