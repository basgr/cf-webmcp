/**
 * Exec route robustness: executor exceptions become envelopes, request bodies are
 * read through a bounded reader, and the origin timeout covers body reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execResponse, type ExecOptions } from "./exec";
import { _resetForTests } from "../rate-limit";
import { makeConfig, type ConfigOverrides } from "../test-support/config";

const SITEMAP_URL = "https://example.com/sitemap.xml";
const ENC = new TextEncoder();

function post(body: BodyInit | null, init: RequestInit = {}): Request {
  return new Request("https://example.com/_webmcp/exec/search_pages", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

async function run(
  request: Request,
  overrides: ConfigOverrides = {},
  opts: Partial<ExecOptions> = {},
  toolName = "search_pages",
): Promise<Response> {
  return execResponse(
    request,
    makeConfig(overrides),
    toolName,
    { domain: "example.com", deployToken: "", ...opts },
    () => {},
  );
}

interface ErrorBody {
  ok: boolean;
  error: { code: string; message: string; retriable: boolean };
}

beforeEach(() => {
  _resetForTests();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("exec: executor exceptions", () => {
  it("turns an exception thrown while an executor reads the body into an internal error envelope", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = new ReadableStream<Uint8Array>({
      start(c) {
        c.error(new Error("socket reset at /srv/secret/path.ts:42"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(broken, { status: 200, headers: { "content-type": "application/xml" } })),
    );

    const res = await run(post("{}"));

    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    const text = await res.text();
    const body = JSON.parse(text) as ErrorBody;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("internal");
    // No stack and no internals in the client-visible envelope.
    expect(text).not.toContain("secret");
    expect(text).not.toMatch(/\n\s+at /);
    // The detail goes to the log instead.
    expect(errors).toHaveBeenCalled();
    expect(String(errors.mock.calls[0]!.join(" "))).toContain("socket reset");
  });

  it("does not cache an internal error envelope", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waitUntil = vi.fn();
    const broken = () =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("boom"));
        },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(broken(), { status: 200, headers: { "content-type": "application/xml" } })),
    );

    const res = await execResponse(
      post("{}"),
      makeConfig(),
      "search_pages",
      { domain: "example.com", deployToken: "" },
      waitUntil,
    );

    expect(res.status).toBe(502);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("exec: request body limit", () => {
  it("rejects a body over 64 KiB with invalid_input and never calls the origin", async () => {
    const fetchMock = vi.fn(async () => new Response("unexpected"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await run(post("x".repeat(64 * 1024 + 1)));

    expect(res.status).toBe(413);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.message).toBe("request body too large");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("measures bytes, not characters", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unexpected")));
    // 40000 two-byte characters = 80000 bytes, but only 40000 UTF-16 code units.
    const res = await run(post("é".repeat(40_000)));

    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.message).toBe("request body too large");
  });

  it("accepts a body of exactly 64 KiB (and then fails JSON parsing, not the size check)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unexpected")));

    const res = await run(post("x".repeat(64 * 1024)));

    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.message).toBe("body is not valid JSON");
  });

  it("rejects a declared Content-Length over the cap before reading anything", async () => {
    const pulled = vi.fn();
    // highWaterMark 0: pull() runs only when a consumer actually reads.
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled();
          c.enqueue(ENC.encode("x"));
        },
      },
      { highWaterMark: 0 },
    );
    const request = post(stream, { headers: { "content-type": "application/json", "content-length": "1000000" } });
    vi.stubGlobal("fetch", vi.fn());

    const res = await run(request);

    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.message).toBe("request body too large");
    expect(pulled).not.toHaveBeenCalled();
  });

  it("stops reading a chunked body once the cap is exceeded", async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls > 1000) return c.close();
        c.enqueue(new Uint8Array(1024).fill(0x78));
      },
    });
    vi.stubGlobal("fetch", vi.fn());

    const res = await run(post(stream, { duplex: "half" } as RequestInit));

    expect(res.status).toBe(413);
    expect(((await res.json()) as ErrorBody).error.code).toBe("invalid_input");
    // The cap is 64 chunks of 1 KiB; the reader must stop long before the stream's 1000 chunks.
    expect(pulls).toBeLessThan(200);
  });
});

describe("exec: the origin timeout covers body reads", () => {
  /** A 200 whose body sends one chunk and then never closes. */
  function stallingResponse(contentType: string, firstChunk: string) {
    const state = { cancelled: false, signal: undefined as AbortSignal | undefined };
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(ENC.encode(firstChunk));
      },
      cancel() {
        state.cancelled = true;
      },
    });
    const response = new Response(stream, { status: 200, headers: { "content-type": contentType } });
    return { response, state };
  }

  const cases: Array<{ name: string; tool: ConfigOverrides["tools"]; contentType: string; chunk: string }> = [
    {
      name: "sitemap_filter",
      tool: [{ name: "search_pages", description: "d", executor: { type: "sitemap_filter", sitemap_url: SITEMAP_URL } }],
      contentType: "application/xml",
      chunk: "<urlset><url><loc>https://example.com/a</loc></url>",
    },
    {
      name: "rss_feed",
      tool: [{ name: "search_pages", description: "d", executor: { type: "rss_feed", feed_url: "https://example.com/feed.xml" } }],
      contentType: "application/rss+xml",
      chunk: "<rss><channel><item><title>a</title>",
    },
    {
      name: "http_get",
      tool: [{ name: "search_pages", description: "d", executor: { type: "http_get", url_template: "https://example.com/data.txt" } }],
      contentType: "text/plain",
      chunk: "partial",
    },
    {
      name: "http_json",
      tool: [{ name: "search_pages", description: "d", executor: { type: "http_json", url_template: "https://example.com/data.json" } }],
      contentType: "application/json",
      chunk: '{"a":',
    },
    {
      name: "dom_extract",
      tool: [{ name: "search_pages", description: "d", executor: { type: "dom_extract", url_template: "https://example.com/page" } }],
      contentType: "text/html; charset=utf-8",
      chunk: "<html><body><main>partial",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: a body that never closes yields a timeout envelope within the executor timeout`, async () => {
      const { response, state } = stallingResponse(c.contentType, c.chunk);
      let signal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          signal = init?.signal ?? undefined;
          return response;
        }),
      );

      const started = Date.now();
      const res = await run(post("{}"), { tools: c.tool }, { timeoutMs: 150 });
      const elapsed = Date.now() - started;

      expect(res.status).toBe(502);
      const body = (await res.json()) as ErrorBody;
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("timeout");
      expect(body.error.retriable).toBe(true);
      expect(elapsed).toBeLessThan(3_000);
      // The signal handed to fetch is aborted once the deadline passes, so the
      // origin connection is released rather than left half-read.
      expect(signal?.aborted).toBe(true);
      void state;
    });
  }

  it("does not turn a fast, complete response into a timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<urlset><url><loc>https://example.com/a</loc></url></urlset>", {
            status: 200,
            headers: { "content-type": "application/xml" },
          }),
      ),
    );

    const res = await run(post("{}"), {}, { timeoutMs: 150 });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    // Let any (incorrectly) leaked timer fire; a leaked deadline must not change anything observable.
    await new Promise((r) => setTimeout(r, 250));
  });
});
