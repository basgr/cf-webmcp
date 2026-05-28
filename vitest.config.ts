import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Worker pool config: runs everything that needs the Cloudflare Workers
 * runtime (HTMLRewriter, R2 bucket bindings, Cache API, etc.).
 * Includes src/ tests only. scripts/ tests run in plain node via
 * vitest.node.config.ts.
 *
 * vitest-pool-workers v0.16 (vitest 4) replaced the `defineWorkersConfig`
 * helper + `test.poolOptions.workers` block with the `cloudflareTest()`
 * plugin on a plain `defineConfig`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.toml" },
      miniflare: {
        compatibilityDate: "2024-09-23",
        compatibilityFlags: ["nodejs_compat"],
      },
    }),
  ],
  test: {
    include: ["src/**/*.test.ts"],
  },
});
