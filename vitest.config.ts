import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Worker pool config: runs everything that needs the Cloudflare Workers
 * runtime (HTMLRewriter, R2 bucket bindings, Cache API, etc.).
 * Includes src/ tests only. scripts/ tests run in plain node via
 * vitest.node.config.ts.
 */
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.toml" },
        miniflare: {
          compatibilityDate: "2024-09-23",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
    include: ["src/**/*.test.ts"],
  },
});
