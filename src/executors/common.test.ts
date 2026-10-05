import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveUrl, originFetch, mapOriginStatus, readWithLimit } from "./common";

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

describe("originFetch with a run-wide signal", () => {
  it("hands the caller's signal to fetch and leaves it armed after the headers arrive", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.signal ?? undefined;
        return new Response("ok", { status: 200 });
      }),
    );

    const r = await originFetch({ ...ctx, timeoutMs: 20, signal: controller.signal }, new URL("https://example.com/x"));

    expect(r).toBeInstanceOf(Response);
    expect(seen).toBe(controller.signal);
    // The local per-fetch timer must not exist: waiting past timeoutMs must not abort the shared signal.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(controller.signal.aborted).toBe(false);
  });

  it("maps an abort of the caller's signal to a timeout error", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    const pending = originFetch({ ...ctx, signal: controller.signal }, new URL("https://example.com/x"));
    controller.abort();

    const r = await pending;
    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("timeout");
  });
});

describe("readWithLimit abort handling", () => {
  function stalling(first = "partial") {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(first));
        },
      }),
    );
  }

  it("reports aborted (not a partial body) when the signal fires mid-read", async () => {
    const controller = new AbortController();
    const pending = readWithLimit(stalling(), 1000, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const r = await pending;

    expect(r).toEqual({ ok: false, reason: "aborted" });
  });

  it("reports aborted straight away when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await readWithLimit(stalling(), 1000, controller.signal)).toEqual({ ok: false, reason: "aborted" });
  });

  it("reports too_large with a reason when the cap is exceeded", async () => {
    expect(await readWithLimit(new Response("a".repeat(50)), 10)).toEqual({ ok: false, reason: "too_large" });
  });

  it("returns the text on success", async () => {
    expect(await readWithLimit(new Response("hello"), 10)).toEqual({ ok: true, text: "hello" });
  });

  it("counts bytes, so a multi-byte body over the cap is too large", async () => {
    // 6 characters, 12 bytes.
    expect(await readWithLimit(new Response("é".repeat(6)), 10)).toEqual({ ok: false, reason: "too_large" });
  });

  it("propagates a stream error that is not an abort", async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("socket reset"));
        },
      }),
    );
    await expect(readWithLimit(broken, 10)).rejects.toThrow("socket reset");
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
