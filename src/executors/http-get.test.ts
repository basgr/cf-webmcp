import { describe, it, expect, vi, afterEach } from "vitest";
import { runHttpGet, matchesAny, readWithLimit } from "./http-get";

const ctx = {
  allowedOrigins: ["https://example.com"],
  deployToken: "t",
  timeoutMs: 1000,
};

afterEach(() => vi.unstubAllGlobals());

describe("matchesAny", () => {
  it("matches exact", () => {
    expect(matchesAny("application/json", ["application/json"])).toBe(true);
  });

  it("matches wildcard family", () => {
    expect(matchesAny("text/csv", ["text/*"])).toBe(true);
    expect(matchesAny("text/csv", ["application/*"])).toBe(false);
  });

  it("ignores content-type parameters", () => {
    expect(matchesAny("application/json; charset=utf-8", ["application/json"])).toBe(true);
  });

  it("rejects unknown types", () => {
    expect(matchesAny("application/octet-stream", ["text/*", "application/json"])).toBe(false);
  });
});

describe("readWithLimit", () => {
  it("returns body within limit", async () => {
    const res = new Response("hello");
    const r = await readWithLimit(res, 100);
    if (!r.ok) throw new Error("expected ok");
    expect(r.text).toBe("hello");
  });

  it("rejects oversize body", async () => {
    const res = new Response("a".repeat(1000));
    const r = await readWithLimit(res, 10);
    expect(r.ok).toBe(false);
  });
});

describe("runHttpGet", () => {
  it("returns body for allowed content-type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("col1,col2\n1,2", { status: 200, headers: { "content-type": "text/csv" } })),
    );
    const r = await runHttpGet(
      ctx,
      {
        url_template: "https://example.com/data.csv",
        method: "GET",
        max_bytes: 1000,
        allowed_content_types: ["text/*"],
      },
      {},
    );
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.body).toContain("col1");
    expect(r.data.content_type).toBe("text/csv");
  });

  it("refuses disallowed content-type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("binary", { status: 200, headers: { "content-type": "application/octet-stream" } })),
    );
    const r = await runHttpGet(
      ctx,
      {
        url_template: "https://example.com/x",
        method: "GET",
        max_bytes: 1000,
        allowed_content_types: ["text/*", "application/json"],
      },
      {},
    );
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("content_type_blocked");
  });

  it("refuses oversize response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("a".repeat(10_000), { status: 200, headers: { "content-type": "text/plain" } })),
    );
    const r = await runHttpGet(
      ctx,
      {
        url_template: "https://example.com/x",
        method: "GET",
        max_bytes: 100,
        allowed_content_types: ["text/*"],
      },
      {},
    );
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("response_too_large");
  });

  it("rejects URL that escapes allowed_origins", async () => {
    const r = await runHttpGet(
      ctx,
      {
        url_template: "https://other.example.com/{{p|default:x}}",
        method: "GET",
        max_bytes: 1000,
        allowed_content_types: ["text/*"],
      },
      {},
    );
    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
  });
});
