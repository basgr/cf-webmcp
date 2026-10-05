import { describe, it, expect, vi, afterEach } from "vitest";
import { runHttpJson, projectItem, MAX_JSON_BYTES } from "./http-json";

const ctx = {
  allowedOrigins: ["https://example.com"],
  deployToken: "t",
  timeoutMs: 1000,
  version: "0.0.0-test",
};

afterEach(() => vi.unstubAllGlobals());

describe("projectItem", () => {
  it("projects flat fields", () => {
    expect(projectItem({ a: 1, b: 2 }, { x: "a", y: "b" })).toEqual({ x: 1, y: 2 });
  });

  it("projects nested fields via dot path", () => {
    expect(projectItem({ a: { b: { c: 7 } } }, { val: "a.b.c" })).toEqual({ val: 7 });
  });

  it("returns null for missing paths", () => {
    expect(projectItem({}, { val: "missing.path" })).toEqual({ val: null });
  });
});

describe("runHttpJson", () => {
  it("returns raw JSON when project not set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ a: 1 }), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const r = await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, {});
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data).toEqual({ a: 1 });
  });

  it("projects array responses", async () => {
    const items = [{ id: 1, t: { rendered: "first" } }, { id: 2, t: { rendered: "second" } }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(items), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const r = await runHttpJson(
      ctx,
      {
        url_template: "https://example.com/p",
        method: "GET",
        project: { type: "array", fields: { id: "id", title: "t.rendered" } },
      },
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data).toEqual([
      { id: 1, title: "first" },
      { id: 2, title: "second" },
    ]);
  });

  it("first projection unwraps a single element", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ a: 1 }, { a: 2 }]), { status: 200, headers: { "content-type": "application/json" } })),
    );
    const r = await runHttpJson(
      ctx,
      {
        url_template: "https://example.com/p",
        method: "GET",
        project: { type: "first", fields: { a: "a" } },
      },
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data).toEqual({ a: 1 });
  });

  it("first projection returns not_found on empty array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } })),
    );
    const r = await runHttpJson(
      ctx,
      {
        url_template: "https://example.com/p",
        method: "GET",
        project: { type: "first", fields: { id: "id" } },
      },
      {},
    );
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("not_found");
  });

  it("rejects URL templates that escape allowed_origins", async () => {
    const r = await runHttpJson(
      ctx,
      { url_template: "https://other.example.com/x", method: "GET" },
      {},
    );
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
  });

  it("maps non-JSON response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const r = await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, {});
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("schema_mismatch");
  });

  it("does not echo the JSON parser's message to the client; the detail goes to the log", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"a": <secret-token>', { status: 200, headers: { "content-type": "application/json" } })),
    );

    const r = await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, {});

    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("schema_mismatch");
    expect(r.error.message).toBe("origin did not return valid JSON");
    expect(JSON.stringify(r)).not.toMatch(/Unexpected|position|token|secret/i);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]!.join(" "))).toMatch(/JSON/);
    errors.mockRestore();
  });

  it("treats an empty body as invalid JSON", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 200 })));

    const r = await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, {});

    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("schema_mismatch");
    errors.mockRestore();
  });

  it("reads the body through a size cap of 2 MiB", async () => {
    expect(MAX_JSON_BYTES).toBe(2 * 1024 * 1024);
    let pulls = 0;
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls > 1000) return c.close();
        c.enqueue(chunk);
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(endless, { status: 200, headers: { "content-type": "application/json" } })),
    );

    const r = await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, {});

    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("response_too_large");
    expect(r.error.message).toContain(String(MAX_JSON_BYTES));
    // Stopped at the cap (32 chunks of 64 KiB, plus read-ahead), not after all 1000.
    expect(pulls).toBeLessThan(100);
  });

  it("accepts a body of exactly the cap", async () => {
    const padded = '{"a":1}' + " ".repeat(MAX_JSON_BYTES - 7);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(padded, { status: 200, headers: { "content-type": "application/json" } })),
    );

    const r = await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data).toEqual({ a: 1 });
  });

  it("returns a timeout error when the run-wide signal aborts a body that stalls", async () => {
    const controller = new AbortController();
    const stalled = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":'));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stalled, { status: 200, headers: { "content-type": "application/json" } })),
    );
    setTimeout(() => controller.abort(), 30);

    const r = await runHttpJson(
      { ...ctx, signal: controller.signal },
      { url_template: "https://example.com/x", method: "GET" },
      {},
    );

    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("timeout");
  });
});

describe("runHttpJson: POST", () => {
  const post = { url_template: "https://example.com/wp-json/contact/v1/send", method: "POST" as const };

  /** One stubbed fetch that records every request it receives. */
  function recordFetch(answer: () => Response = () => new Response('{"sent":true}', { status: 200, headers: { "content-type": "application/json" } })) {
    const calls: Array<{ url: string; method: string | undefined; body: unknown; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({
          url: String(url),
          method: init?.method,
          body: init?.body,
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
        });
        return answer();
      }),
    );
    return calls;
  }

  it("sends the validated input as a JSON body with content-type application/json", async () => {
    const calls = recordFetch();

    const r = await runHttpJson(ctx, post, { email: "a@example.com", topics: ["x", "y"], count: 3 });

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://example.com/wp-json/contact/v1/send");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers["accept"]).toBe("application/json, */*");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ email: "a@example.com", topics: ["x", "y"], count: 3 });
  });

  it("sends an empty object, not an empty body, when the input has no fields", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, post, {});

    expect(calls[0]!.body).toBe("{}");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  it("resolves the URL from the input and also sends that input in the body", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, { ...post, url_template: "https://example.com/api/{{kind}}" }, { kind: "news", n: 2 });

    expect(calls[0]!.url).toBe("https://example.com/api/news");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ kind: "news", n: 2 });
  });

  it("still applies the allow-list: no request, no body, for a template that leaves allowed_origins", async () => {
    const calls = recordFetch();

    const r = await runHttpJson(ctx, { ...post, url_template: "https://other.example.com/x" }, { a: 1 });

    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("a GET sends no body and no content-type", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, { a: 1 });

    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.body).toBeUndefined();
    expect(calls[0]!.headers["content-type"]).toBeUndefined();
  });

  it("replays the body and the content-type on a 307 and a 308", async () => {
    for (const status of [307, 308]) {
      const calls: Array<{ method: string | undefined; body: unknown; contentType: string | undefined }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ method: init?.method, body: init?.body, contentType: new Headers(init?.headers).get("content-type") ?? undefined });
          return calls.length === 1
            ? new Response(null, { status, headers: { location: "https://example.com/elsewhere" } })
            : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        }),
      );

      const r = await runHttpJson(ctx, post, { a: 1 });

      expect(r.ok, String(status)).toBe(true);
      expect(calls).toEqual([
        { method: "POST", body: '{"a":1}', contentType: "application/json" },
        { method: "POST", body: '{"a":1}', contentType: "application/json" },
      ]);
    }
  });

  it("a 303 turns the follow-up into a GET without the body or its content-type", async () => {
    const calls: Array<{ method: string | undefined; body: unknown; contentType: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method, body: init?.body, contentType: new Headers(init?.headers).get("content-type") ?? undefined });
        return calls.length === 1
          ? new Response(null, { status: 303, headers: { location: "https://example.com/done" } })
          : new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    await runHttpJson(ctx, post, { a: 1 });

    expect(calls[1]).toEqual({ method: "GET", body: undefined, contentType: undefined });
  });
});
