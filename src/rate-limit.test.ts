import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkGlobalRateLimit,
  checkPerToolRateLimit,
  clientIp,
  RATE_LIMIT_MAX_BUCKETS,
  _resetForTests,
} from "./rate-limit";

beforeEach(() => {
  _resetForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("checkGlobalRateLimit", () => {
  it("allows up to the limit then rejects with retry-after", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkGlobalRateLimit("1.2.3.4", 5).allowed).toBe(true);
    }
    const sixth = checkGlobalRateLimit("1.2.3.4", 5);
    expect(sixth.allowed).toBe(false);
    expect(sixth.retryAfterSec).toBeGreaterThan(0);
    expect(sixth.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it("tracks IPs independently", () => {
    for (let i = 0; i < 5; i++) {
      expect(checkGlobalRateLimit("1.1.1.1", 5).allowed).toBe(true);
    }
    expect(checkGlobalRateLimit("1.1.1.1", 5).allowed).toBe(false);
    // Different IP, same limit, still allowed
    expect(checkGlobalRateLimit("2.2.2.2", 5).allowed).toBe(true);
  });

  it("resets after the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    for (let i = 0; i < 5; i++) {
      checkGlobalRateLimit("3.3.3.3", 5);
    }
    expect(checkGlobalRateLimit("3.3.3.3", 5).allowed).toBe(false);
    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    expect(checkGlobalRateLimit("3.3.3.3", 5).allowed).toBe(true);
  });

  it("treats limit=0 as disabled (always allowed)", () => {
    for (let i = 0; i < 1000; i++) {
      expect(checkGlobalRateLimit("4.4.4.4", 0).allowed).toBe(true);
    }
  });
});

describe("checkPerToolRateLimit", () => {
  it("scopes per (tool, ip)", () => {
    for (let i = 0; i < 3; i++) {
      expect(checkPerToolRateLimit("5.5.5.5", "search_pages", 3).allowed).toBe(true);
    }
    // exceeded for search_pages
    expect(checkPerToolRateLimit("5.5.5.5", "search_pages", 3).allowed).toBe(false);
    // different tool, same ip - allowed
    expect(checkPerToolRateLimit("5.5.5.5", "list_posts", 3).allowed).toBe(true);
    // different ip, same tool - allowed
    expect(checkPerToolRateLimit("6.6.6.6", "search_pages", 3).allowed).toBe(true);
  });
});

describe("a full bucket map", () => {
  it("keeps admitting new clients by evicting the least recently used bucket", () => {
    for (let i = 0; i < RATE_LIMIT_MAX_BUCKETS; i++) {
      expect(checkGlobalRateLimit(`key-${i}`, 5).allowed).toBe(true);
    }
    // The map is full. A new client is admitted, not refused.
    for (let i = 0; i < 100; i++) {
      expect(checkGlobalRateLimit(`new-${i}`, 5).allowed, `new-${i}`).toBe(true);
    }
  });

  it("evicts the bucket used longest ago, not one that is in use", () => {
    // limit 1: a second call inside the window is refused while the bucket exists.
    expect(checkGlobalRateLimit("first", 1).allowed).toBe(true);
    expect(checkGlobalRateLimit("busy", 1).allowed).toBe(true);
    for (let i = 0; i < RATE_LIMIT_MAX_BUCKETS - 2; i++) checkGlobalRateLimit(`key-${i}`, 1);
    // "busy" is refused, and that use moves it to the recently used end.
    expect(checkGlobalRateLimit("busy", 1).allowed).toBe(false);
    // Two new clients make room by evicting the two least recently used buckets: "first" and key-0.
    checkGlobalRateLimit("newcomer-a", 1);
    checkGlobalRateLimit("newcomer-b", 1);

    expect(checkGlobalRateLimit("busy", 1).allowed).toBe(false);
    // "first" lost its bucket, so it starts a new window.
    expect(checkGlobalRateLimit("first", 1).allowed).toBe(true);
  });

  it("applies to the per-tool map too", () => {
    for (let i = 0; i < RATE_LIMIT_MAX_BUCKETS; i++) checkPerToolRateLimit(`ip-${i}`, "search_pages", 3);
    expect(checkPerToolRateLimit("one-more", "search_pages", 3).allowed).toBe(true);
  });
});

describe("clientIp", () => {
  const withHeaders = (headers: Record<string, string>) => new Request("https://example.com/", { headers });

  it("uses cf-connecting-ip for an IPv4 address, the full address", () => {
    expect(clientIp(withHeaders({ "cf-connecting-ip": "9.9.9.9" }))).toBe("9.9.9.9");
  });

  it("ignores x-forwarded-for, which the client controls", () => {
    expect(clientIp(withHeaders({ "x-forwarded-for": "10.0.0.1, 192.168.1.1" }))).toBe("unknown");
    expect(clientIp(withHeaders({ "cf-connecting-ip": "9.9.9.9", "x-forwarded-for": "10.0.0.1" }))).toBe("9.9.9.9");
  });

  it("puts every request without cf-connecting-ip into one shared bucket", () => {
    expect(clientIp(withHeaders({}))).toBe("unknown");
  });

  it.each(["", "   ", "not-an-ip", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.4:80", "2001:db8::1::2", "2001:db8:::1", "12345::1", "g::1", "1:2:3:4:5:6:7:8:9"])(
    "puts a malformed cf-connecting-ip %j into the shared bucket",
    (value) => {
      expect(clientIp(withHeaders({ "cf-connecting-ip": value }))).toBe("unknown");
    },
  );

  it("keys an IPv6 address by its /64", () => {
    expect(clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:2:3:4:5:6" }))).toBe("2001:db8:1:2::/64");
  });

  it("gives two addresses in one /64 the same key, however they are written", () => {
    const a = clientIp(withHeaders({ "cf-connecting-ip": "2001:0DB8:0001:0002:aaaa::1" }));
    const b = clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:2:ffff:ffff:ffff:fffe" }));
    expect(a).toBe("2001:db8:1:2::/64");
    expect(b).toBe(a);
  });

  it("expands :: before it takes the prefix", () => {
    expect(clientIp(withHeaders({ "cf-connecting-ip": "2001:db8::1" }))).toBe("2001:db8:0:0::/64");
    expect(clientIp(withHeaders({ "cf-connecting-ip": "::1" }))).toBe("0:0:0:0::/64");
    expect(clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:2::" }))).toBe("2001:db8:1:2::/64");
  });

  it("gives addresses in different /64s different keys", () => {
    const a = clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:2::1" }));
    const b = clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:3::1" }));
    expect(a).not.toBe(b);
  });

  it("keys an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(clientIp(withHeaders({ "cf-connecting-ip": "::ffff:1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(withHeaders({ "cf-connecting-ip": "::FFFF:0102:0304" }))).toBe("1.2.3.4");
  });

  it("shares one rate-limit bucket across a /64", () => {
    const ipA = clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:2::a" }));
    const ipB = clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:2::b" }));
    const ipC = clientIp(withHeaders({ "cf-connecting-ip": "2001:db8:1:3::a" }));
    expect(checkGlobalRateLimit(ipA, 2).allowed).toBe(true);
    expect(checkGlobalRateLimit(ipB, 2).allowed).toBe(true);
    // A third request from the same /64 is over the shared limit; another /64 is not.
    expect(checkGlobalRateLimit(ipA, 2).allowed).toBe(false);
    expect(checkGlobalRateLimit(ipC, 2).allowed).toBe(true);
  });
});
