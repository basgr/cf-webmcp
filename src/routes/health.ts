import type { Config } from "../config-types";

export interface HealthOptions {
  configHash: string;
  schemaVersion: number;
  deployedAt: string;
  preflight?: { ran_at: string | null; collisions: string[]; warnings: string[]; config_hash?: string };
  /** Content-addressed widget object key this build serves, or null when it ships no widget. */
  widgetAsset?: string | null;
  /** The CF_WEBMCP_ASSETS R2 binding, used only to probe for the widget object. */
  bucket?: Pick<R2Bucket, "head">;
  /**
   * The CF_WEBMCP_HEALTH_TOKEN secret (env.CF_WEBMCP_HEALTH_TOKEN). When non-empty it is
   * the bearer token and replaces [health].token. An empty string counts as unset.
   */
  envToken?: string;
}

/**
 * Whether the widget object this build expects exists in R2. null means "not
 * applicable or unknown": feature off, no widget in this build, no binding, or
 * the probe itself failed (a bucket outage must not turn the health check into
 * a 500). Never calls head() without a key.
 */
async function widgetAssetPresent(config: Config, opts: HealthOptions): Promise<boolean | null> {
  if (!config.features.fallback_widget) return null;
  if (!opts.widgetAsset || !opts.bucket) return null;
  try {
    return (await opts.bucket.head(opts.widgetAsset)) !== null;
  } catch {
    return null;
  }
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
 *
 * The bearer token is the CF_WEBMCP_HEALTH_TOKEN secret when it is set (non-empty),
 * otherwise [health].token. The secret wins outright: with both set, the TOML token
 * is not accepted.
 *
 * If a token is set, requires Authorization: Bearer <token>.
 * If [health].public is false and no token is set (secret or TOML), answers 404.
 * So public = false plus only the secret is an authenticated endpoint, not a 404.
 */
export async function healthResponse(request: Request, config: Config, opts: HealthOptions): Promise<Response> {
  const token = opts.envToken || config.health.token;
  if (!config.health.public && !token) {
    return new Response("health endpoint disabled", {
      status: 404,
      headers: { "x-robots-tag": "noindex" },
    });
  }
  if (token) {
    const auth = request.headers.get("authorization") ?? "";
    const expected = `Bearer ${token}`;
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
    widget_asset_present: await widgetAssetPresent(config, opts),
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
