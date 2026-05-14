/**
 * Stable executor response envelope. Every tool call returns one of these.
 * Defined separately from the W3C `Promise<any>` contract because we choose
 * to standardise the shape across the Worker, the bootstrapper, and the
 * fallback widget so agent integrations can rely on it.
 */

export type ErrorCode =
  | "invalid_input"
  | "not_found"
  | "origin_5xx"
  | "origin_4xx"
  | "timeout"
  | "schema_mismatch"
  | "rate_limited"
  | "internal"
  | "response_too_large"
  | "content_type_blocked";

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retriable: boolean;
}

export type Envelope<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: ErrorPayload };

export function ok<T>(data: T): Envelope<T> {
  return { ok: true, data };
}

export function err(code: ErrorCode, message: string, retriable = false): Envelope<never> {
  return { ok: false, error: { code, message, retriable } };
}

export function jsonResponse<T>(envelope: Envelope<T>, init: ResponseInit = {}): Response {
  const status =
    envelope.ok ? (init.status ?? 200) : (init.status ?? statusForCode(envelope.error.code));
  return new Response(JSON.stringify(envelope), {
    ...init,
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      // jsonResponse serves /_webmcp/exec/* responses; that prefix is in the
      // "must noindex" set. See feedback memory and the x-robots coverage test.
      "x-robots-tag": "noindex",
      ...(init.headers ?? {}),
    },
  });
}

function statusForCode(code: ErrorCode): number {
  switch (code) {
    case "invalid_input":
    case "schema_mismatch":
      return 400;
    case "not_found":
      return 404;
    case "rate_limited":
      return 429;
    case "origin_4xx":
      return 502;
    case "origin_5xx":
    case "timeout":
    case "internal":
      return 502;
    case "response_too_large":
    case "content_type_blocked":
      return 502;
    default:
      return 500;
  }
}
