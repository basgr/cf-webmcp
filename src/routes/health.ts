import type { Config } from "../config-types";

export interface HealthOptions {
  configHash: string;
  schemaVersion: number;
  deployedAt: string;
  preflight?: { ran_at: string | null; collisions: string[]; warnings: string[]; config_hash?: string };
}

/**
 * Constant-time comparison for secret tokens. Avoids leaking the token via
 * response-time differences when the attacker controls the candidate value.
 */
function timingSafeEqual(a: string, b: string): boolean {
  // Length difference is not a secret; the candidate is attacker-supplied.
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * /_webmcp/health
 * If [health].token is set, requires Authorization: Bearer <token>.
 * If [health].public is false (and no token), refuses.
 */
export function healthResponse(request: Request, config: Config, opts: HealthOptions): Response {
  if (!config.health.public && !config.health.token) {
    return new Response("health endpoint disabled", {
      status: 404,
      headers: { "x-robots-tag": "noindex" },
    });
  }
  if (config.health.token) {
    const auth = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${config.health.token}`;
    if (!timingSafeEqual(auth, expected)) {
      return new Response("unauthorized", {
        status: 401,
        headers: { "x-robots-tag": "noindex" },
      });
    }
  }
  const body = {
    schema_version: opts.schemaVersion,
    config_hash: opts.configHash,
    deployed_at: opts.deployedAt,
    preflight: opts.preflight ?? { ran_at: null, collisions: [], warnings: [] },
    executors: config.tools.map((t) => ({ name: t.name, ok_24h: null, err_24h: null, p95_ms_24h: null })),
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}
