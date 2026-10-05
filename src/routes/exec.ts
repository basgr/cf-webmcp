/**
 * POST /<namespace>/exec/:tool_name
 * Validates input, dispatches to the executor, wraps in the response envelope,
 * sets cache headers. Cache lookup is keyed on version + config_hash + tool_name + sha256(body).
 *
 * CORS is computed per request, for every answer: a cache hit, a miss, and every
 * error (405, 404, 400, 413, 429, 5xx). The cache stores results without any CORS
 * header, so a hit never replays the headers of the caller that filled it.
 */

import type { Config, ToolConfig } from "../config-types";
import { runExecutor } from "../executors";
import { readWithLimit, timeoutError, type ExecutorContext } from "../executors/common";
import { validateInput } from "../validate";
import { jsonResponse, err, type Envelope } from "../envelope";
import { buildCacheControl, makeCacheKey } from "../cache";
import { checkGlobalRateLimit, checkPerToolRateLimit, clientIp } from "../rate-limit";

export interface ExecOptions {
  domain: string;
  deployToken: string;
  /** CONFIG_HASH of this build. Part of the cache key, so a config change starts a fresh cache. */
  configHash: string;
  /** cf-webmcp's version (CF_WEBMCP_VERSION). Part of the cache key, so an upgrade starts a fresh cache. */
  version: string;
  /** Deadline for one executor run, origin fetch and body reads together. Defaults to 8s. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 8_000;
/** Hard cap on POST body size for /_webmcp/exec/*. JSON payloads are typically
 * tiny (a few hundred bytes); a multi-MB POST is either misuse or abuse. */
const MAX_EXEC_BODY_BYTES = 64 * 1024; // 64KB

export async function execResponse(
  request: Request,
  config: Config,
  toolName: string,
  opts: ExecOptions,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  // The preflight carries its own CORS answer (allowed methods, headers, max-age).
  if (request.method === "OPTIONS") return preflightCors(request, config);
  return withCors(await execAnswer(request, config, toolName, opts, waitUntil), request, config);
}

/** The answer to an exec request before CORS is applied: no access-control-* header on any path. */
async function execAnswer(
  request: Request,
  config: Config,
  toolName: string,
  opts: ExecOptions,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { allow: "POST, OPTIONS", "x-robots-tag": "noindex" },
    });
  }

  const tool = config.tools.find((t) => t.name === toolName);
  if (!tool) {
    return jsonResponse(err("not_found", `unknown tool "${toolName}"`));
  }

  // Rate limit before doing any meaningful work.
  const ip = clientIp(request);
  const global = checkGlobalRateLimit(ip, config.rate_limit.requests_per_minute_per_ip);
  if (!global.allowed) {
    return rateLimited(global.retryAfterSec!);
  }
  const burst = tool.rate_limit?.burst;
  if (burst !== undefined) {
    const perTool = checkPerToolRateLimit(ip, tool.name, burst);
    if (!perTool.allowed) {
      return rateLimited(perTool.retryAfterSec!);
    }
  }

  // Reject oversize bodies before reading them into memory.
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const declaredLength = Number(contentLengthHeader);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_EXEC_BODY_BYTES) {
      return bodyTooLarge();
    }
  }

  // Read body once, use the raw text for cache key, parse for validation. The
  // reader stops at the cap, so a chunked body with no (or a false) Content-Length
  // is never buffered beyond MAX_EXEC_BODY_BYTES.
  let bodyText: string;
  try {
    const read = await readWithLimit(request, MAX_EXEC_BODY_BYTES);
    if (!read.ok) return bodyTooLarge();
    bodyText = read.text;
  } catch {
    // The client dropped the connection mid-body.
    return jsonResponse(err("invalid_input", "could not read request body"));
  }
  let parsed: unknown;
  try {
    parsed = bodyText.length === 0 ? {} : JSON.parse(bodyText);
  } catch {
    return jsonResponse(err("invalid_input", "body is not valid JSON"));
  }

  const validation = validateInput(tool.input_schema, parsed);
  if (!validation.ok) {
    return jsonResponse(err("invalid_input", validation.message));
  }

  // Cache check.
  const cacheKey = await makeCacheKey(
    opts.domain,
    { version: opts.version, configHash: opts.configHash },
    { toolName, bodyText },
  );
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("x-webmcp-cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const ctx: ExecutorContext = {
    allowedOrigins: config.origin.allowed_origins.map((u) => new URL(u).origin),
    deployToken: opts.deployToken,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };

  const envelope = await runWithDeadline(ctx, tool as ToolConfig, validation.value);

  const ttl = tool.cache ?? {};
  const cc = buildCacheControl({
    max_age: ttl.max_age ?? config.cache.executor_defaults.max_age,
    s_maxage: ttl.s_maxage ?? config.cache.executor_defaults.s_maxage,
    swr: ttl.swr ?? config.cache.executor_defaults.swr,
    sie: ttl.sie ?? config.cache.executor_defaults.sie,
  });
  const response = jsonResponse(envelope, {
    headers: {
      "cache-control": cc,
      "x-webmcp-cache": "MISS",
    },
  });

  // Only cache successful envelopes. Stored without CORS: those headers belong to
  // one caller, and execResponse adds them for each request, hits included.
  if (envelope.ok) {
    waitUntil(cache.put(cacheKey, withoutCors(response.clone())));
  }

  return response;
}

function bodyTooLarge(): Response {
  return jsonResponse(err("invalid_input", "request body too large"), { status: 413 });
}

/**
 * Run an executor under one deadline that covers the origin fetch AND the body
 * reads that follow it (the old per-fetch timer was cleared as soon as headers
 * arrived, so an origin that sent headers and then stalled held the request open).
 *
 * The signal in the executor context is aborted at the deadline, which releases
 * the origin connection and makes pending body reads give up. The race on top
 * guarantees a timeout envelope even where a body read does not honour the signal.
 *
 * An exception from the executor becomes an `internal` envelope. The detail is
 * logged; the client gets neither the message nor a stack.
 */
async function runWithDeadline(
  ctx: ExecutorContext,
  tool: ToolConfig,
  input: Record<string, unknown>,
): Promise<Envelope> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<Envelope>((resolve) => {
    timer = setTimeout(() => {
      // Resolve before aborting: the abort makes the in-flight run settle a moment
      // later (with an abort error), and that must lose the race.
      resolve({ ok: false, error: timeoutError(ctx.timeoutMs) });
      controller.abort();
    }, ctx.timeoutMs);
  });

  const run = (async (): Promise<Envelope> => {
    try {
      return await runExecutor({ ...ctx, signal: controller.signal }, tool, input);
    } catch (e) {
      if (controller.signal.aborted) return { ok: false, error: timeoutError(ctx.timeoutMs) };
      console.error(
        `cf-webmcp: executor for tool "${tool.name}" threw: ${e instanceof Error ? e.message : String(e)}`,
      );
      return err("internal", "the tool failed unexpectedly", false);
    }
  })();

  try {
    return await Promise.race([run, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function rateLimited(retryAfterSec: number): Response {
  return jsonResponse(
    err("rate_limited", `too many requests, retry after ${retryAfterSec}s`, true),
    { headers: { "retry-after": String(retryAfterSec) } },
  );
}

function preflightCors(request: Request, config: Config): Response {
  const headers: Record<string, string> = {
    allow: "POST, OPTIONS",
    "x-robots-tag": "noindex",
  };
  const reqOrigin = request.headers.get("origin");
  // Echo the request origin only if it is on the allow list. This makes
  // multi-origin CORS work correctly (previously the first allow_origins
  // entry was used regardless of the requesting origin, which only worked
  // for that one origin).
  if (reqOrigin && config.cors.allowed_origins.includes(reqOrigin)) {
    headers["access-control-allow-origin"] = reqOrigin;
    headers["access-control-allow-headers"] = "content-type";
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers["access-control-max-age"] = "86400";
    headers["vary"] = "origin";
  }
  return new Response(null, { status: 204, headers });
}

/**
 * The response with the CORS headers of `request`: Access-Control-Allow-Origin echoes
 * the request's Origin when [cors].allowed_origins lists it, as the preflight does.
 * Whatever access-control-* headers the response carried are dropped first, so a
 * cached response can never answer with another caller's. Whenever any origin is
 * allowed, the answer depends on Origin (an echo or no header at all), so it carries
 * Vary: Origin, also when this request gets no CORS header.
 */
function withCors(response: Response, request: Request, config: Config): Response {
  const headers = stripCors(new Headers(response.headers));
  const allowed = config.cors.allowed_origins;
  if (allowed.length > 0) {
    headers.set("vary", addVaryToken(headers.get("vary"), "origin"));
    const reqOrigin = request.headers.get("origin");
    if (reqOrigin !== null && allowed.includes(reqOrigin)) {
      headers.set("access-control-allow-origin", reqOrigin);
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The response as the exec cache stores it: no access-control-* header, no Origin in Vary. */
function withoutCors(response: Response): Response {
  const headers = stripCors(new Headers(response.headers));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function stripCors(headers: Headers): Headers {
  const names = [...headers.keys()].filter((name) => name.startsWith("access-control-"));
  for (const name of names) headers.delete(name);
  const vary = (headers.get("vary") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "" && v.toLowerCase() !== "origin");
  if (vary.length > 0) headers.set("vary", vary.join(", "));
  else headers.delete("vary");
  return headers;
}

function addVaryToken(vary: string | null, token: string): string {
  const tokens = (vary ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
  if (!tokens.some((v) => v.toLowerCase() === token)) tokens.push(token);
  return tokens.join(", ");
}
