import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  checkGlobalRateLimit,
  checkPerToolRateLimit,
  clientIp,
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

describe("clientIp", () => {
  it("uses cf-connecting-ip when present", () => {
    const req = new Request("https://example.com/", {
      headers: { "cf-connecting-ip": "9.9.9.9" },
    });
    expect(clientIp(req)).toBe("9.9.9.9");
  });

  it("falls back to x-forwarded-for", () => {
    const req = new Request("https://example.com/", {
      headers: { "x-forwarded-for": "10.0.0.1, 192.168.1.1" },
    });
    expect(clientIp(req)).toBe("10.0.0.1");
  });

  it("returns a constant key when no header is present", () => {
    const req = new Request("https://example.com/");
    expect(clientIp(req)).toBe("local-dev");
  });
});
