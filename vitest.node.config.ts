import { defineConfig } from "vitest/config";

/**
 * Plain node test pool for scripts/ tests (build-config etc.).
 * These cannot run in workerd because they use node-only APIs (fs, os, child_process).
 */
export default defineConfig({
  test: {
    include: ["scripts/**/*.test.ts"],
    environment: "node",
  },
});
