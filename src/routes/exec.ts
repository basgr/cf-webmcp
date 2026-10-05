/**
 * POST /<namespace>/exec/:tool_name
 * Validates input, dispatches to the executor, wraps in the response envelope,
 * sets cache headers. Cache lookup is keyed on tool_name + sha256(body).
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
  if (request.method !== "POST") {
    if (request.method === "OPTIONS") {
      return preflightCors(request, config);
    }
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
  const cacheKey = await makeCacheKey(opts.domain, { toolName, bodyText });
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
      ...corsHeaders(request, config),
    },
  });

  // Only cache successful envelopes.
  if (envelope.ok) {
    waitUntil(cache.put(cacheKey, response.clone()));
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

function corsHeaders(request: Request, config: Config): Record<string, string> {
  const reqOrigin = request.headers.get("origin");
  if (!reqOrigin) return {};
  if (config.cors.allowed_origins.includes(reqOrigin)) {
    return {
      "access-control-allow-origin": reqOrigin,
      vary: "origin",
    };
  }
  return {};
}
