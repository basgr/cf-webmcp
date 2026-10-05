/**
 * Simple in-Worker rate limiter.
 *
 * Two layers:
 *   - per-IP across all executors  (config: [rate_limit].requests_per_minute_per_ip)
 *   - per-IP per-tool burst        (config: [[tools]].rate_limit.burst, sliding window: 10s)
 *
 * "Per IP" means per key from clientIp(): an IPv4 address, or the /64 of an IPv6
 * address (one subscriber usually holds a whole /64, so rotating through it must not
 * reset the limit).
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

/**
 * Each Map is kept in least-recently-used order: every check deletes the key and
 * sets it again, so the first entry is always the one used longest ago.
 */
const globalBuckets = new Map<string, Bucket>();
const perToolBuckets = new Map<string, Bucket>();

const GLOBAL_WINDOW_MS = 60_000; // 1 minute
const PER_TOOL_WINDOW_MS = 10_000; // 10 second sliding window for burst
/**
 * Hard cap on each in-isolate rate-limit Map, to bound memory under a flood of
 * unique keys: 16k keys at roughly 80 bytes per bucket is about 1.3 MB. A full Map
 * evicts its least recently used bucket to admit a new key. It never refuses a key
 * for lack of room, which would let a flood of addresses lock everyone else out.
 */
const MAX_BUCKETS = 16_384;
export const RATE_LIMIT_MAX_BUCKETS = MAX_BUCKETS;

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
  // Deleted here and set again below, in both branches, so the key moves to the
  // most recently used end. A refused request counts as use: a client that keeps
  // hammering stays tracked instead of drifting towards eviction.
  if (existing) store.delete(key);
  if (!existing || existing.resetAt <= now) {
    makeRoom(store, now);
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }
  store.set(key, existing);
  if (existing.count >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
    return { allowed: false, retryAfterSec };
  }
  existing.count++;
  return { allowed: true };
}

/**
 * Before a new bucket goes in: drop buckets from the least recently used end
 * while they have expired or the Map is full. Each bucket is deleted at most once,
 * so this is O(1) amortised, and a full Map loses exactly its least recently used
 * bucket (whose client simply starts a fresh window if it comes back).
 */
function makeRoom(store: Map<string, Bucket>, now: number): void {
  for (const [k, v] of store) {
    if (store.size < MAX_BUCKETS && v.resetAt > now) return;
    store.delete(k);
  }
}

/** Used by tests to reset state between cases. */
export function _resetForTests(): void {
  globalBuckets.clear();
  perToolBuckets.clear();
}

/**
 * The rate-limit key of a request, from CF-Connecting-IP only: Cloudflare sets it
 * to the address that connected to its edge, while X-Forwarded-For is whatever the
 * client chose to send, so it is never read.
 *
 *   - IPv4: the address itself.
 *   - IPv6: its /64, as "<first four hextets>::/64". A subscriber usually gets a
 *     whole /64 and can rotate through it at will.
 *   - IPv4-mapped IPv6 (::ffff:1.2.3.4): the IPv4 address.
 *   - A missing or malformed header: "unknown", one bucket all such requests share
 *     (local development without the header, mostly).
 */
export function clientIp(request: Request): string {
  const raw = request.headers.get("cf-connecting-ip")?.trim() ?? "";
  if (raw === "") return UNKNOWN_CLIENT;
  const v4 = parseIpv4(raw);
  if (v4 !== null) return v4.join(".");
  const v6 = parseIpv6(raw);
  if (v6 === null) return UNKNOWN_CLIENT;
  // ::ffff:0:0/96 carries an IPv4 address in its last 32 bits.
  if (v6.slice(0, 5).every((h) => h === 0) && v6[5] === 0xffff) {
    return [v6[6]! >> 8, v6[6]! & 0xff, v6[7]! >> 8, v6[7]! & 0xff].join(".");
  }
  return `${v6
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(":")}::/64`;
}

const UNKNOWN_CLIENT = "unknown";

/** Four decimal octets 0-255, or null. */
function parseIpv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : null;
}

/**
 * The eight 16-bit groups of an IPv6 address in text form (RFC 4291 section 2.2:
 * at most one "::", hextets of one to four hex digits, an optional dotted IPv4
 * address in the last 32 bits), or null. No zone index: Cloudflare sends none.
 */
function parseIpv6(text: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parseSide = (side: string, last: boolean): number[] | null => {
    if (side === "") return [];
    const groups = side.split(":");
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]!;
      if (last && i === groups.length - 1 && g.includes(".")) {
        const v4 = parseIpv4(g);
        if (v4 === null) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(g)) {
        out.push(parseInt(g, 16));
      } else {
        return null;
      }
    }
    return out;
  };
  if (halves.length === 1) {
    const all = parseSide(halves[0]!, true);
    return all !== null && all.length === 8 ? all : null;
  }
  const head = parseSide(halves[0]!, false);
  const tail = parseSide(halves[1]!, true);
  if (head === null || tail === null || head.length + tail.length > 7) return null;
  return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
}
