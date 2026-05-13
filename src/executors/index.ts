/**
 * Executor dispatch. Routes each tool invocation to its typed runner.
 * Built thin so phases 2/3 can add new executor types one at a time.
 */

import type { ExecutorContext } from "./common";
import type { ToolConfig } from "../config-types";
import { err, type Envelope } from "../envelope";
import { runSitemapFilter } from "./sitemap";
import { runRssFeed } from "./rss";
import { runDomExtract } from "./dom-extract";
import { runHttpJson } from "./http-json";
import { runHttpGet } from "./http-get";

export async function runExecutor(
  ctx: ExecutorContext,
  tool: ToolConfig,
  input: Record<string, unknown>,
): Promise<Envelope> {
  switch (tool.executor.type) {
    case "sitemap_filter":
      return runSitemapFilter(ctx, tool.executor, input);
    case "rss_feed":
      return runRssFeed(ctx, tool.executor, input);
    case "dom_extract":
      return runDomExtract(ctx, tool.executor, input);
    case "http_json":
      return runHttpJson(ctx, tool.executor, input);
    case "http_get":
      return runHttpGet(ctx, tool.executor, input);
    default: {
      // Exhaustive at type level; this branch is unreachable.
      const _exhaustive: never = tool.executor;
      void _exhaustive;
      return err("internal", "unknown executor type", false);
    }
  }
}
