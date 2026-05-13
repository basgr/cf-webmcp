/**
 * Simple in-Worker rate limiter.
 *
 * Two layers:
 *   - per-IP across all executors  (config: [rate_limit].requests_per_minute_per_ip)
 *   - per-IP per-tool burst        (config: [[tools]].rate_limit.burst, sliding window: 10s)
 *
 * Storage is an in-memory Map scoped to the current Worker isolate. CF spawns
 * many isolates, so this is an underestimate of true global rate; a determined
 * attacker can spread requests across isolates. For zone-wide enforcement use
 * a Cloudflare WAF rate-limit rule alongside (see docs/deployment.md). This
 * layer protects the common case: bursty repeated calls from one client.
 *
 * Returns { allowed: true } when the request can proceed, or
 * { allowed: false, retryAfterSec } when the caller should be told to back off.
 */

interface Bucket {
  count: number;
  /** Epoch ms when the window resets. */
  resetAt: number;
}

const globalBuckets = new Map<string, Bucket>();
const perToolBuckets = new Map<string, Bucket>();

const GLOBAL_WINDOW_MS = 60_000; // 1 minute
const PER_TOOL_WINDOW_MS = 10_000; // 10 second sliding window for burst
/** Hard cap on the in-isolate rate-limit Map to bound memory under
 * unique-IP-flood attacks. When the cap is hit, new IPs are refused
 * (fail closed). 16k IPs × ~80 bytes per bucket = ~1.3 MB worst case. */
const MAX_BUCKETS = 16_384;

export interface RateLimitCheck {
  allowed: boolean;
  /** Set when allowed === false. Seconds the client should wait before retrying. */
  retryAfterSec?: number;
}

export function checkGlobalRateLimit(
  ip: string,
  limitPerMinute: number,
): RateLimitCheck {
  return checkBucket(globalBuckets, ip, limitPerMinute, GLOBAL_WINDOW_MS);
}

export function checkPerToolRateLimit(
  ip: string,
  toolName: string,
  burst: number,
): RateLimitCheck {
  return checkBucket(perToolBuckets, `${toolName}|${ip}`, burst, PER_TOOL_WINDOW_MS);
}

function checkBucket(
  store: Map<string, Bucket>,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitCheck {
  if (limit <= 0) return { allowed: true };
  const now = Date.now();
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    sweepIfLarge(store, now);
    // Fail closed if the Map is at capacity. Prevents unbounded memory growth
    // from a unique-IP-flood attack at the cost of slightly aggressive limits
    // when the isolate is genuinely serving many clients.
    if (store.size >= MAX_BUCKETS) {
      return { allowed: false, retryAfterSec: Math.ceil(windowMs / 1000) };
    }
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  if (existing.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  existing.count++;
  return { allowed: true };
}

/**
 * Drop expired entries when the Map gets large. Bounded by MAX_BUCKETS via the
 * fail-closed branch above; this is best-effort cleanup so well-behaved
 * traffic doesn't accumulate dead entries forever.
 */
function sweepIfLarge(store: Map<string, Bucket>, now: number): void {
  if (store.size < 1024) return;
  for (const [k, v] of store) {
    if (v.resetAt <= now) store.delete(k);
  }
}

/** Used by tests to reset state between cases. */
export function _resetForTests(): void {
  globalBuckets.clear();
  perToolBuckets.clear();
}

/**
 * Extract the client IP from a Cloudflare-fronted Request.
 * Falls back to a constant key in local dev where the header is absent
 * (which means rate limits are shared across all local clients, fine for testing).
 */
export function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local-dev"
  );
}
