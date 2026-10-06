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

describe("runHttpJson: origin JSON nested too deeply", () => {
  const nested = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
  const answer = (text: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(text, { status: 200, headers: { "content-type": "application/json" } })),
    );
  const raw = { url_template: "https://example.com/x", method: "GET" as const };

  // 2,000 levels in 4 KB are enough to make a serialiser that recurses per level throw.
  it.each([2_000, 65])("an answer %i levels deep is schema_mismatch with a fixed message", async (depth) => {
    answer(nested(depth));
    const r = await runHttpJson(ctx, raw, {});
    expect(r).toEqual({
      ok: false,
      error: { code: "schema_mismatch", message: "origin's JSON is nested more than 64 levels deep", retriable: false },
    });
  });

  it("an answer exactly 64 levels deep is returned", async () => {
    answer(nested(64));
    const r = await runHttpJson(ctx, raw, {});
    if (!r.ok) throw new Error(JSON.stringify(r));
    let depth = 0;
    for (let v: unknown = r.data; Array.isArray(v); v = v[0]) depth++;
    expect(depth).toBe(64);
  });

  it("brackets inside strings do not count, escaped quotes included", async () => {
    answer(JSON.stringify({ text: "[".repeat(500) + '\\"' + "{".repeat(500) }));
    const r = await runHttpJson(ctx, raw, {});
    expect(r.ok).toBe(true);
  });
});

describe("runHttpJson: POST", () => {
  const post = { url_template: "https://example.com/wp-json/contact/v1/send", method: "POST" as const };
  /** What the tool declares: the body is built from these properties only. */
  const declares = (...names: string[]) => ({ properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])) });

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

  it("sends the declared properties of the input as a JSON body with content-type application/json, values intact", async () => {
    const calls = recordFetch();
    const input = { email: "a@example.com", topics: ["x", "y"], count: 3, live: false };

    const r = await runHttpJson(ctx, post, input, declares("email", "topics", "count", "live"));

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("https://example.com/wp-json/contact/v1/send");
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(calls[0]!.headers["accept"]).toBe("application/json, */*");
    expect(JSON.parse(calls[0]!.body as string)).toEqual(input);
  });

  it("does not send a property the tool did not declare (no mass assignment against origin's API)", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, post, { q: "abc", role: "admin", is_admin: true, extra: { deep: 1 } }, declares("q"));

    expect(calls[0]!.body).toBe('{"q":"abc"}');
  });

  it("does not send a __proto__ key, nor constructor or toString, whatever it holds", async () => {
    const calls = recordFetch();
    // The exec route parses the request body with JSON.parse, which makes "__proto__" an own property.
    const input = JSON.parse('{"q":"abc","__proto__":{"isAdmin":true},"constructor":{"x":1},"toString":"t"}') as Record<string, unknown>;
    expect(Object.keys(input)).toContain("__proto__");

    await runHttpJson(ctx, post, input, declares("q"));

    expect(calls[0]!.body).toBe('{"q":"abc"}');
    expect(String(calls[0]!.body)).not.toMatch(/isAdmin|__proto__|constructor|toString/);
  });

  it("sends a declared property that shares its name with an inherited one, as an own value only", async () => {
    const calls = recordFetch();
    const input = JSON.parse('{"constructor":"c"}') as Record<string, unknown>;

    await runHttpJson(ctx, post, input, declares("constructor"));
    await runHttpJson(ctx, post, {}, declares("constructor"));

    expect(calls[0]!.body).toBe('{"constructor":"c"}');
    // Absent from the input: absent from the body (the inherited constructor is not read).
    expect(calls[1]!.body).toBe("{}");
  });

  it("omits a declared property the caller did not send", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, post, { a: "1" }, declares("a", "b"));

    expect(calls[0]!.body).toBe('{"a":"1"}');
  });

  it("sends an empty object, not an empty body, when the tool declares no properties, whatever the caller sent", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, post, {}, { properties: {} });
    await runHttpJson(ctx, post, { sneaky: 1 }, { properties: {} });
    await runHttpJson(ctx, post, { sneaky: 1 }, {});

    expect(calls.map((c) => c.body)).toEqual(["{}", "{}", "{}"]);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
  });

  it("resolves the URL from the whole input, and sends only the declared part of it in the body", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, { ...post, url_template: "https://example.com/api/{{kind}}" }, { kind: "news", n: "2" }, declares("n"));

    expect(calls[0]!.url).toBe("https://example.com/api/news");
    expect(JSON.parse(calls[0]!.body as string)).toEqual({ n: "2" });
  });

  it("still applies the allow-list: no request, no body, for a template that leaves allowed_origins", async () => {
    const calls = recordFetch();

    const r = await runHttpJson(ctx, { ...post, url_template: "https://other.example.com/x" }, { a: 1 }, declares("a"));

    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
    expect(calls).toEqual([]);
  });

  it("a GET sends no body and no content-type", async () => {
    const calls = recordFetch();

    await runHttpJson(ctx, { url_template: "https://example.com/x", method: "GET" }, { a: 1 }, declares("a"));

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

      const r = await runHttpJson(ctx, post, { a: 1, hidden: 2 }, declares("a"));

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

    await runHttpJson(ctx, post, { a: 1 }, declares("a"));

    expect(calls[1]).toEqual({ method: "GET", body: undefined, contentType: undefined });
  });
});
