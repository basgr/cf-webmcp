/**
 * Whether the exec route reads and writes the Workers cache for a tool, one rule shared by
 * the route (src/routes/exec.ts) and the build, which warns about a [tools.cache] it ignores.
 *
 * Every tool uses the cache, except a POST http_json tool: it sends its input to origin as a
 * request body and may have effects there, and a replayed answer would hide a call that never
 * happened. A POST tool is cached only when the publisher wrote a lifetime for it:
 * `[tools.cache]` with `s_maxage` greater than 0, the lifetime of the Worker's own cache. Every
 * other value of a cached tool falls back to `[cache].executor_defaults`, as for any tool.
 *
 * These do not count as asking for it: no `[tools.cache]`, an empty one, `max_age` (a browser
 * lifetime, and a browser does not cache a POST), `swr` and `sie` (they qualify a lifetime),
 * and `s_maxage = 0`, which is how a publisher says "never" in so many words.
 */

import type { ToolConfig } from "./config-types";

export function cachesResults(tool: Pick<ToolConfig, "executor" | "cache">): boolean {
  if (tool.executor.type === "http_json" && tool.executor.method === "POST") {
    return (tool.cache?.s_maxage ?? 0) > 0;
  }
  return true;
}
