/**
 * Test-only helpers: build a valid Config and a full HandlerDeps without the
 * generated modules, so worker-level tests can vary config per case.
 *
 * Config is built through ConfigSchema.parse, so any new schema field picks up
 * its default automatically and tests only spell out what they care about.
 */

import { ConfigSchema, type Config } from "../config-types";
import type { HandlerAssets, HandlerDeps, HandlerMeta } from "../handler";

/** Recursive partial for overrides. Arrays are replaced wholesale, not merged. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

const minimalValidConfig = {
  schema_version: 1,
  site: { domain: "example.com", name: "Example" },
  origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"] },
  tools: [
    {
      name: "search_pages",
      description: "Search pages on the site.",
      executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml" },
    },
  ],
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge key by key; arrays and scalars in `override` replace `base`. */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return base;
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = deepMerge(base[key], value);
    }
    return out;
  }
  return override;
}

export function makeConfig(overrides: DeepPartial<Config> = {}): Config {
  return ConfigSchema.parse(deepMerge(minimalValidConfig, overrides));
}

export function makeDeps(
  configOverrides: DeepPartial<Config> = {},
  extra: { assets?: Partial<HandlerAssets>; meta?: Partial<HandlerMeta> } = {},
): HandlerDeps {
  return {
    config: makeConfig(configOverrides),
    assets: {
      bootstrapJs: "/*bootstrap*/",
      landingHtml: "<html><head></head><body>landing</body></html>",
      manifestJson: "{}",
      aiCatalogJson: "",
      ...extra.assets,
    },
    meta: {
      CONFIG_HASH: "testhash",
      BOOTSTRAP_ASSET: "bootstrap.test.js",
      WIDGET_ASSET: "widget.test.js",
      BUILD_AT: "2026-01-01T00:00:00.000Z",
      PREFLIGHT: { ran_at: null, collisions: [], warnings: [] },
      AGENT_SKILLS_DIGEST: null,
      BOOTSTRAP_SRI: null,
      LLMS_TXT_TOKEN_HINTS: { manifest: 0, landing: 0 },
      ...extra.meta,
    },
  };
}
