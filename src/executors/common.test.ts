import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveUrl, originFetch, mapOriginStatus } from "./common";

const ctx = {
  allowedOrigins: ["https://example.com"],
  deployToken: "deploy-token-x",
  timeoutMs: 1000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveUrl", () => {
  it("resolves a clean template", () => {
    const r = resolveUrl(ctx, {
      urlTemplate: "https://example.com/p?q={{query}}",
      input: { query: "hello" },
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.url.toString()).toBe("https://example.com/p?q=hello");
  });

  it("keeps URL on example.com even when input looks like a URL", () => {
    // URL-encoding in query position prevents the host from being changed
    // by user input. The resulting URL stays inside the allow-listed origin.
    const r = resolveUrl(ctx, {
      urlTemplate: "https://example.com/p?q={{query}}",
      input: { query: "https://evil.example.com/" },
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.url.origin).toBe("https://example.com");
    expect(r.url.searchParams.get("q")).toBe("https://evil.example.com/");
  });

  it("rejects when template resolves outside allowed_origins", () => {
    const r = resolveUrl(ctx, {
      urlTemplate: "https://other.example.com/{{p}}",
      input: { p: "x" },
    });
    if (r.ok) throw new Error("expected rejection");
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.message).toContain("not in allowed_origins");
  });

  it("returns invalid_input on missing required param", () => {
    const r = resolveUrl(ctx, {
      urlTemplate: "https://example.com/{{slug}}",
      input: {},
    });
    if (r.ok) throw new Error("expected rejection");
    expect(r.error.code).toBe("invalid_input");
  });
});

describe("originFetch", () => {
  it("strips visitor cookies and sets the bypass header", async () => {
    const seen: { headers: Record<string, string> } = { headers: {} };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string> | undefined;
        if (h) seen.headers = h;
        return new Response("ok", { status: 200 });
      }),
    );
    const r = await originFetch(ctx, new URL("https://example.com/x"), {});
    expect(r).toBeInstanceOf(Response);
    expect(seen.headers["cookie"]).toBeUndefined();
    expect(seen.headers["cf-webmcp-bypass"]).toBe("1");
    expect(seen.headers["cf-webmcp-deploy-token"]).toBe("deploy-token-x");
    expect(seen.headers["user-agent"]).toMatch(/^cf-webmcp\//);
  });

  it("maps timeout to envelope error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((_, reject) => {
            // never resolves - controller.abort will kick in
            setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
          }),
      ),
    );
    const r = await originFetch({ ...ctx, timeoutMs: 10 }, new URL("https://example.com/x"));
    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("timeout");
  });
});

describe("mapOriginStatus", () => {
  it("returns null for 2xx", () => {
    expect(mapOriginStatus(200)).toBeNull();
  });

  it("maps 5xx", () => {
    expect(mapOriginStatus(503)?.code).toBe("origin_5xx");
  });

  it("maps 404", () => {
    expect(mapOriginStatus(404)?.code).toBe("not_found");
  });

  it("maps 429", () => {
    expect(mapOriginStatus(429)?.code).toBe("rate_limited");
  });

  it("maps generic 4xx", () => {
    expect(mapOriginStatus(403)?.code).toBe("origin_4xx");
  });
});
