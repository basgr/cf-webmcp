import type { Config } from "../config-types";
import { decodeOriginTrialToken } from "../origin-trial";

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

/** One configured origin-trial token as health reports it. Never the token itself. */
type OriginTrialStatus = { feature: string; expires_at: string; expired: boolean } | { error: "undecodable" };

/**
 * What each [origin_trial].tokens entry says, read from the token at request time:
 * expiry is a fact about the clock now, and a token can lapse after the deploy. The build
 * already refused a token that does not decode, so "undecodable" is a should-not-happen
 * marker; it never takes the health check down and never echoes the token.
 */
function originTrials(config: Config): OriginTrialStatus[] {
  const now = Date.now();
  return config.origin_trial.tokens.map((token): OriginTrialStatus => {
    try {
      const { payload } = decodeOriginTrialToken(token);
      const expiresMs = payload.expiry * 1000;
      return { feature: payload.feature, expires_at: new Date(expiresMs).toISOString(), expired: expiresMs <= now };
    } catch {
      return { error: "undecodable" };
    }
  });
}

/**
 * Constant-time comparison for secret tokens. Both sides are hashed with SHA-256
 * first, so the two values compared are always 32 bytes: neither the content nor the
 * length of the token shows in the response time, whatever candidate the attacker
 * sends. The digests are compared with crypto.subtle.timingSafeEqual, which the
 * Workers runtime provides.
 */
async function tokensMatch(candidate: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
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
    if (!(await tokensMatch(auth, expected))) {
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
    origin_trials: originTrials(config),
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
