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
 *
 * method:
 *   - "GET"  : no body.
 *   - "POST" : the properties of the validated tool input that the tool's input_schema declares
 *              go to origin as the JSON body (content-type application/json): `{}` for a tool
 *              that declares none. Anything else the caller sent (validation tolerates unknown
 *              properties) stays out of the body, a `__proto__` entry included. The URL is
 *              resolved from the same input, which the exec route has already cut down to the
 *              declared properties (src/routes/exec.ts). A 307 or 308 replays the body; a 301, 302 or 303
 *              turns the follow-up into a bodyless GET (src/safe-fetch.ts). The exec route does
 *              not cache a POST tool unless [tools.cache] sets a positive s_maxage
 *              (src/routes/exec.ts).
 */

import type { ExecutorContext } from "./common";
import { fromErr, mapOriginStatus, originFetch, readFailure, readWithLimit, resolveUrl } from "./common";
import { err, ok, type Envelope } from "../envelope";
import { declaredProperties, type DeclaredProperties } from "../validate";

/** Largest JSON body we will read and parse. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

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
  /** The tool's input_schema: the POST body is built from the properties it declares. Without one, the body is `{}`. */
  schema: DeclaredProperties = {},
): Promise<Envelope> {
  const resolved = resolveUrl(ctx, { urlTemplate: config.url_template, input });
  if (!resolved.ok) return err(resolved.error.code, resolved.error.message, resolved.error.retriable);

  const res = await originFetch(ctx, resolved.url, {
    method: config.method,
    acceptHeader: "application/json, */*",
    ...(config.method === "POST"
      ? { body: JSON.stringify(declaredProperties(schema, input)), contentType: "application/json" }
      : {}),
  });
  if ("error" in res) return fromErr(res.error);
  const mapped = mapOriginStatus(res.status);
  if (mapped) return fromErr(mapped);

  // Bounded read first, then parse: res.json() would buffer a body of any size.
  const body = await readWithLimit(res, MAX_JSON_BYTES, ctx.signal);
  if (!body.ok) return fromErr(readFailure(body, ctx, MAX_JSON_BYTES, "response"));

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch (e) {
    // The parser's message quotes the origin's bytes ("Unexpected token <, ..."); keep it
    // out of the envelope the agent sees and log it instead.
    console.error(`cf-webmcp: http_json origin response is not valid JSON: ${(e as Error).message}`);
    return err("schema_mismatch", "origin did not return valid JSON", false);
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
