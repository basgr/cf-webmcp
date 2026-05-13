/**
 * http_json executor. Fetches a JSON endpoint and projects the result into a
 * stable shape so the agent does not see origin field names.
 *
 * project.type:
 *   - "array" : response is an array; project each element via `fields`
 *   - "first" : response is an array; project only the first element
 *   - "raw"   : return the raw parsed JSON (default)
 *
 * `fields` maps agent-facing names to dotted paths into the response.
 */

import type { ExecutorContext } from "./common";
import { fromErr, mapOriginStatus, originFetch, resolveUrl } from "./common";
import { err, ok, type Envelope } from "../envelope";

export interface HttpJsonConfig {
  url_template: string;
  method: "GET" | "POST";
  project?: {
    type: "array" | "first" | "raw";
    fields?: Record<string, string>;
  };
}

export async function runHttpJson(
  ctx: ExecutorContext,
  config: HttpJsonConfig,
  input: Record<string, unknown>,
): Promise<Envelope> {
  const resolved = resolveUrl(ctx, { urlTemplate: config.url_template, input });
  if (!resolved.ok) return err(resolved.error.code, resolved.error.message, resolved.error.retriable);

  const res = await originFetch(ctx, resolved.url, {
    method: config.method,
    acceptHeader: "application/json, */*",
  });
  if ("error" in res) return fromErr(res.error);
  const mapped = mapOriginStatus(res.status);
  if (mapped) return fromErr(mapped);

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (e) {
    return err("schema_mismatch", `origin did not return valid JSON: ${(e as Error).message}`, false);
  }

  const proj = config.project ?? { type: "raw" };
  switch (proj.type) {
    case "raw":
      return ok(parsed);
    case "array": {
      if (!Array.isArray(parsed))
        return err("schema_mismatch", "expected array response but got object", false);
      return ok(parsed.map((item) => projectItem(item, proj.fields ?? {})));
    }
    case "first": {
      if (!Array.isArray(parsed))
        return err("schema_mismatch", "expected array response but got object", false);
      if (parsed.length === 0) return err("not_found", "no matching item", false);
      return ok(projectItem(parsed[0], proj.fields ?? {}));
    }
  }
}

export function projectItem(item: unknown, fields: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [outKey, path] of Object.entries(fields)) {
    out[outKey] = getPath(item, path);
  }
  return out;
}

function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split(".")) {
    if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return current;
}
