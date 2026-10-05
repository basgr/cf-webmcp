import { describe, it, expect, vi, afterEach } from "vitest";
import { runHttpJson, projectItem, MAX_JSON_BYTES } from "./http-json";

const ctx = {
  allowedOrigins: ["https://example.com"],
  deployToken: "t",
  timeoutMs: 1000,
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
