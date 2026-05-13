import { describe, it, expect, vi, afterEach } from "vitest";
import { runHttpJson, projectItem } from "./http-json";

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
});
