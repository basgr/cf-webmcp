/**
 * Exec route robustness: executor exceptions become envelopes, request bodies are
 * read through a bounded reader, and the origin timeout covers body reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execResponse, type ExecOptions } from "./exec";
import { _resetForTests } from "../rate-limit";
import { makeCacheKey } from "../cache";
import { makeConfig, type ConfigOverrides } from "../test-support/config";

const SITEMAP_URL = "https://example.com/sitemap.xml";
const ENC = new TextEncoder();
const CONFIG_HASH = "c0ffee00";
const VERSION = "0.0.0-test";

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
    { domain: "example.com", deployToken: "", configHash: CONFIG_HASH, version: VERSION, ...opts },
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
      { domain: "example.com", deployToken: "", configHash: CONFIG_HASH, version: VERSION },
      waitUntil,
    );

    expect(res.status).toBe(502);
    expect(waitUntil).not.toHaveBeenCalled();
  });
});

describe("exec: an answer that cannot be serialised never throws out of the route", () => {
  const JSON_TOOL: ConfigOverrides = {
    tools: [{ name: "deep_json", description: "d", executor: { type: "http_json", url_template: "https://example.com/api/deep" } }],
  };
  const deepPost = () =>
    new Request("https://example.com/_webmcp/exec/deep_json", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });

  it("an http_json answer 2,000 levels deep is schema_mismatch, with and without a deploy token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[".repeat(2_000) + "]".repeat(2_000), { status: 200, headers: { "content-type": "application/json" } })),
    );
    for (const deployToken of ["", "0123456789abcdef0123456789abcdef"]) {
      const res = await run(deepPost(), JSON_TOOL, { deployToken }, "deep_json");
      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "schema_mismatch",
        message: "origin's JSON is nested more than 64 levels deep",
        retriable: false,
      });
    }
  });

  it("an envelope whose serialisation throws answers internal with a fixed message, and is not cached", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
    const original = JSON.stringify;
    // A RangeError from the serialiser, as a document nested too deeply for it raises.
    vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
      if (value !== null && typeof value === "object" && (value as { ok?: unknown }).ok === true) {
        throw new RangeError("Maximum call stack size exceeded");
      }
      return (original as (...args: unknown[]) => string).call(JSON, value, ...rest);
    }) as typeof JSON.stringify);
    const waitUntil = vi.fn();

    for (const deployToken of ["", "0123456789abcdef0123456789abcdef"]) {
      const res = await execResponse(
        post(original({ query: "a" })),
        makeConfig(),
        "search_pages",
        { domain: "example.com", deployToken, configHash: CONFIG_HASH, version: VERSION },
        waitUntil,
      );
      expect(res.status).toBe(502);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(((await res.json()) as ErrorBody).error).toEqual({
        code: "internal",
        message: "the tool's answer could not be returned",
        retriable: false,
      });
    }
    expect(waitUntil).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalled();
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

const APP_A = "https://app-a.example";
const APP_B = "https://app-b.example";
const CORS: ConfigOverrides = { cors: { allowed_origins: [APP_A, APP_B] } };

function sitemapOk(): Response {
  return new Response("<urlset><url><loc>https://example.com/a</loc></url></urlset>", {
    status: 200,
    headers: { "content-type": "application/xml" },
  });
}

function fromOrigin(origin: string | null, body: BodyInit | null = "{}"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin !== null) headers["origin"] = origin;
  return post(body, { headers });
}

const varyTokens = (res: Response) =>
  (res.headers.get("vary") ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter((v) => v !== "");

let cacheRun = 0;
/** A config hash no other test uses, so each test starts with an empty exec cache. */
const freshConfigHash = () => `t${Date.now().toString(16)}${(cacheRun++).toString(16)}`;

/** One exec call that also waits for the cache write it scheduled. */
async function runAndSettle(
  request: Request,
  configHash: string,
  overrides: ConfigOverrides = CORS,
  version = VERSION,
): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const res = await execResponse(
    request,
    makeConfig(overrides),
    "search_pages",
    { domain: "example.com", deployToken: "", configHash, version },
    (p) => pending.push(p),
  );
  await Promise.all(pending);
  return res;
}

describe("exec: the cache replays results, never another caller's CORS headers", () => {
  it("answers a cache hit with the CORS headers of the caller asking now", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
    const configHash = freshConfigHash();

    const first = await runAndSettle(fromOrigin(APP_A), configHash);
    expect(first.headers.get("x-webmcp-cache")).toBe("MISS");
    expect(first.headers.get("access-control-allow-origin")).toBe(APP_A);

    const second = await runAndSettle(fromOrigin(APP_B), configHash);
    expect(second.headers.get("x-webmcp-cache")).toBe("HIT");
    expect(second.headers.get("access-control-allow-origin")).toBe(APP_B);
    expect(varyTokens(second)).toEqual(["origin"]);

    const noOrigin = await runAndSettle(fromOrigin(null), configHash);
    expect(noOrigin.headers.get("x-webmcp-cache")).toBe("HIT");
    expect(noOrigin.headers.has("access-control-allow-origin")).toBe(false);

    const unlisted = await runAndSettle(fromOrigin("https://evil.example"), configHash);
    expect(unlisted.headers.get("x-webmcp-cache")).toBe("HIT");
    expect(unlisted.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("stores the result without access-control headers and without Vary: Origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
    const configHash = freshConfigHash();

    await runAndSettle(fromOrigin(APP_A), configHash);

    const stored = await caches.default.match(
      await makeCacheKey("example.com", { version: VERSION, configHash }, { toolName: "search_pages", inputJson: "{}" }),
    );
    expect(stored).toBeDefined();
    const names = [...stored!.headers.keys()];
    expect(names.filter((n) => n.startsWith("access-control-"))).toEqual([]);
    expect(varyTokens(stored!)).not.toContain("origin");
  });

  it("keys the cache on the config hash: the same call under another config is a miss", async () => {
    const fetchMock = vi.fn(async () => sitemapOk());
    vi.stubGlobal("fetch", fetchMock);
    const before = freshConfigHash();
    const after = freshConfigHash();

    expect((await runAndSettle(fromOrigin(null), before)).headers.get("x-webmcp-cache")).toBe("MISS");
    expect((await runAndSettle(fromOrigin(null), before)).headers.get("x-webmcp-cache")).toBe("HIT");
    expect((await runAndSettle(fromOrigin(null), after)).headers.get("x-webmcp-cache")).toBe("MISS");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keys the cache on the cf-webmcp version: the same call after an upgrade is a miss", async () => {
    const fetchMock = vi.fn(async () => sitemapOk());
    vi.stubGlobal("fetch", fetchMock);
    const configHash = freshConfigHash();

    expect((await runAndSettle(fromOrigin(null), configHash, CORS, "0.6.0")).headers.get("x-webmcp-cache")).toBe("MISS");
    expect((await runAndSettle(fromOrigin(null), configHash, CORS, "0.6.0")).headers.get("x-webmcp-cache")).toBe("HIT");
    expect((await runAndSettle(fromOrigin(null), configHash, CORS, "0.6.1")).headers.get("x-webmcp-cache")).toBe("MISS");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("puts the version and the config hash into the cache key URL", async () => {
    const key = (version: string, configHash: string) =>
      makeCacheKey("example.com", { version, configHash }, { toolName: "search_pages", inputJson: "{}" });
    const a = await key("0.6.0", "aaaa1111");
    expect(a.url).toContain("/0.6.0/aaaa1111/search_pages/");
    expect((await key("0.6.0", "bbbb2222")).url).not.toBe(a.url);
    expect((await key("0.6.1", "aaaa1111")).url).not.toBe(a.url);
  });
});

describe("exec: X-Webmcp-Cache is readable by a cross-origin caller", () => {
  const expose = (res: Response) =>
    (res.headers.get("access-control-expose-headers") ?? "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => v !== "");

  it("is listed in Access-Control-Expose-Headers on a miss and on a hit, for a listed origin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
    const configHash = freshConfigHash();

    const miss = await runAndSettle(fromOrigin(APP_A), configHash);
    const hit = await runAndSettle(fromOrigin(APP_B), configHash);

    expect(miss.headers.get("x-webmcp-cache")).toBe("MISS");
    expect(hit.headers.get("x-webmcp-cache")).toBe("HIT");
    expect(expose(miss)).toContain("x-webmcp-cache");
    expect(expose(hit)).toContain("x-webmcp-cache");
  });

  it("is listed on every answer that carries CORS, the errors included", async () => {
    expect(expose(await run(fromOrigin(APP_A, "{"), CORS))).toContain("x-webmcp-cache");
    expect(expose(await run(fromOrigin(APP_A), CORS, {}, "no_such_tool"))).toContain("x-webmcp-cache");
  });

  it("is not sent to an origin that is not listed, to a request without Origin, or when no origin is allowed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
    const configHash = freshConfigHash();

    expect(expose(await runAndSettle(fromOrigin("https://evil.example"), configHash))).toEqual([]);
    expect(expose(await runAndSettle(fromOrigin(null), configHash))).toEqual([]);
    expect(expose(await runAndSettle(fromOrigin(APP_A), configHash, {}))).toEqual([]);
  });

  it("is not stored in the cache with the result", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
    const configHash = freshConfigHash();

    await runAndSettle(fromOrigin(APP_A), configHash);

    const stored = await caches.default.match(
      await makeCacheKey("example.com", { version: VERSION, configHash }, { toolName: "search_pages", inputJson: "{}" }),
    );
    expect(stored!.headers.has("access-control-expose-headers")).toBe(false);
  });
});

describe("exec: every answer carries CORS for a listed origin", () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ["405 for a GET", () => run(new Request("https://example.com/_webmcp/exec/search_pages", { headers: { origin: APP_A } }), CORS)],
    ["404 for an unknown tool", () => run(fromOrigin(APP_A), CORS, {}, "no_such_tool")],
    ["400 for a body that is not JSON", () => run(fromOrigin(APP_A, "{"), CORS)],
    ["413 for a body over the cap", () => run(fromOrigin(APP_A, "x".repeat(64 * 1024 + 1)), CORS)],
    [
      "429 when rate limited",
      async () => {
        vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
        const limited: ConfigOverrides = { ...CORS, rate_limit: { requests_per_minute_per_ip: 1 } };
        await run(fromOrigin(APP_A), limited, { configHash: freshConfigHash() });
        return run(fromOrigin(APP_A), limited, { configHash: freshConfigHash() });
      },
    ],
    [
      "502 for an executor that fails",
      () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.stubGlobal("fetch", vi.fn(async () => new Response("<not xml", { status: 500 })));
        return run(fromOrigin(APP_A), CORS, { configHash: freshConfigHash() });
      },
    ],
  ];

  it.each(cases)("%s", async (_label, make) => {
    const res = await make();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("access-control-allow-origin")).toBe(APP_A);
    expect(varyTokens(res)).toContain("origin");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("sends no CORS header to an origin that is not listed, or to a request without Origin", async () => {
    for (const origin of ["https://evil.example", null]) {
      const res = await run(fromOrigin(origin), CORS, {}, "no_such_tool");
      expect(res.status).toBe(404);
      expect(res.headers.has("access-control-allow-origin")).toBe(false);
      // The answer still depends on Origin, so a cache must key on it.
      expect(varyTokens(res)).toContain("origin");
    }
  });

  it("sends neither CORS nor Vary when no origin is allowed at all", async () => {
    const res = await run(fromOrigin(APP_A), {}, {}, "no_such_tool");
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
    expect(res.headers.has("vary")).toBe(false);
  });
});

describe("exec: a POST http_json tool is not cached unless its [tools.cache] asks for it", () => {
  const SEND_URL = "https://example.com/api/send";
  const postTool = (cache?: Record<string, number>): ConfigOverrides => ({
    tools: [
      {
        name: "search_pages",
        description: "d",
        executor: { type: "http_json", url_template: SEND_URL, method: "POST" },
        ...(cache ? { cache } : {}),
      },
    ],
  });
  const getTool = (cache?: Record<string, number>): ConfigOverrides => ({
    tools: [
      {
        name: "search_pages",
        description: "d",
        executor: { type: "http_json", url_template: SEND_URL, method: "GET" },
        ...(cache ? { cache } : {}),
      },
    ],
  });

  /** A fetch that answers every call with a fresh JSON body and counts them. */
  function originAnswering() {
    const calls: Array<{ method: string | undefined; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method, body: init?.body });
        return new Response(JSON.stringify({ call: calls.length }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return calls;
  }

  const storedFor = async (configHash: string) =>
    caches.default.match(await makeCacheKey("example.com", { version: VERSION, configHash }, { toolName: "search_pages", inputJson: "{}" }));

  const declaring = (...names: string[]): ConfigOverrides => ({
    tools: [
      {
        name: "search_pages",
        description: "d",
        input_schema: {
          type: "object",
          required: [],
          properties: Object.fromEntries(names.map((n) => [n, { type: n === "n" ? "integer" : "string" }])),
        },
        executor: { type: "http_json", url_template: SEND_URL, method: "POST" },
      },
    ],
  });

  it("sends the declared properties of the request body to origin as the POST body", async () => {
    const calls = originAnswering();
    const body = '{"email":"a@example.com","n":2}';

    const res = await runAndSettle(fromOrigin(null, body), freshConfigHash(), declaring("email", "n"));

    expect(res.status).toBe(200);
    expect(calls).toEqual([{ method: "POST", body }]);
  });

  it("sends nothing the tool did not declare, a __proto__ key included, and nothing at all from a tool that declares nothing", async () => {
    const calls = originAnswering();
    const attack = '{"q":"abc","role":"admin","__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}';

    await runAndSettle(fromOrigin(null, attack), freshConfigHash(), declaring("q"));
    await runAndSettle(fromOrigin(null, attack), freshConfigHash(), postTool());

    expect(calls).toEqual([
      { method: "POST", body: '{"q":"abc"}' },
      { method: "POST", body: "{}" },
    ]);
  });

  it("by default neither reads nor writes the cache: every call reaches origin", async () => {
    const calls = originAnswering();
    const configHash = freshConfigHash();

    const first = await runAndSettle(fromOrigin(null), configHash, postTool());
    const second = await runAndSettle(fromOrigin(null), configHash, postTool());

    expect(calls).toHaveLength(2);
    expect(((await first.json()) as { data: { call: number } }).data.call).toBe(1);
    expect(((await second.json()) as { data: { call: number } }).data.call).toBe(2);
    expect(first.headers.get("x-webmcp-cache")).toBe("BYPASS");
    expect(second.headers.get("x-webmcp-cache")).toBe("BYPASS");
    expect(await storedFor(configHash)).toBeUndefined();
  });

  it("answers with Cache-Control: no-store, not the executor defaults", async () => {
    originAnswering();

    const res = await runAndSettle(fromOrigin(null), freshConfigHash(), postTool());

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("schedules no cache write", async () => {
    originAnswering();
    const waitUntil = vi.fn();

    await execResponse(
      fromOrigin(null),
      makeConfig(postTool()),
      "search_pages",
      { domain: "example.com", deployToken: "", configHash: freshConfigHash(), version: VERSION },
      waitUntil,
    );

    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("caches a POST tool whose [tools.cache] sets a positive s_maxage, with the tool's own values", async () => {
    const calls = originAnswering();
    const configHash = freshConfigHash();
    const cache = { s_maxage: 60, swr: 10 };

    const first = await runAndSettle(fromOrigin(null), configHash, postTool(cache));
    const second = await runAndSettle(fromOrigin(null), configHash, postTool(cache));

    expect(calls).toHaveLength(1);
    expect(first.headers.get("x-webmcp-cache")).toBe("MISS");
    expect(second.headers.get("x-webmcp-cache")).toBe("HIT");
    // The tool's s_maxage and swr; the unset max_age and sie come from [cache].executor_defaults.
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=10, stale-if-error=86400");
    expect(await storedFor(configHash)).toBeDefined();
  });

  it("keys a cached POST tool on its declared input, so another declared value is a miss", async () => {
    const calls = originAnswering();
    const configHash = freshConfigHash();
    const overrides: ConfigOverrides = {
      tools: [{ ...declaring("q").tools![0]!, cache: { s_maxage: 60 } }] as ConfigOverrides["tools"],
    };

    await runAndSettle(fromOrigin(null, '{"q":"a"}'), configHash, overrides);
    await runAndSettle(fromOrigin(null, '{"q":"a"}'), configHash, overrides);
    await runAndSettle(fromOrigin(null, '{"q":"b"}'), configHash, overrides);

    expect(calls).toHaveLength(2);
  });

  it.each([
    ["max_age alone (a browser lifetime: a POST is never cached by the browser)", { max_age: 60 }],
    ["swr and sie alone (they only qualify a lifetime)", { swr: 60, sie: 60 }],
    ["s_maxage = 0 (the explicit way to say never)", { s_maxage: 0 }],
    ["an empty [tools.cache] table", {}],
  ])("does not cache a POST tool with %s", async (_label, cache) => {
    const calls = originAnswering();
    const configHash = freshConfigHash();

    const first = await runAndSettle(fromOrigin(null), configHash, postTool(cache));
    const second = await runAndSettle(fromOrigin(null), configHash, postTool(cache));

    expect(calls).toHaveLength(2);
    expect(first.headers.get("x-webmcp-cache")).toBe("BYPASS");
    expect(second.headers.get("x-webmcp-cache")).toBe("BYPASS");
    expect(second.headers.get("cache-control")).toBe("no-store");
  });

  it("does not cache a failed POST either way", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    const configHash = freshConfigHash();

    const res = await runAndSettle(fromOrigin(null), configHash, postTool({ s_maxage: 60 }));

    expect(res.status).toBe(502);
    expect(await storedFor(configHash)).toBeUndefined();
  });

  it("a GET http_json tool keeps the default cache: second call is a hit with the executor defaults", async () => {
    const calls = originAnswering();
    const configHash = freshConfigHash();

    const first = await runAndSettle(fromOrigin(null), configHash, getTool());
    const second = await runAndSettle(fromOrigin(null), configHash, getTool());

    expect(calls).toHaveLength(1);
    expect(first.headers.get("x-webmcp-cache")).toBe("MISS");
    expect(second.headers.get("x-webmcp-cache")).toBe("HIT");
    expect(first.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=300, stale-while-revalidate=1800, stale-if-error=86400");
  });

  it("carries CORS and noindex on the uncached answer like any other", async () => {
    originAnswering();

    const res = await runAndSettle(fromOrigin(APP_A), freshConfigHash(), { ...CORS, ...postTool() });

    expect(res.headers.get("access-control-allow-origin")).toBe(APP_A);
    expect(varyTokens(res)).toContain("origin");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
  });
});

describe("exec: the User-Agent names the cf-webmcp version", () => {
  it("sends cf-webmcp/<version> to origin for every executor type, the version the exec options carry", async () => {
    const agents: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        agents.push((init?.headers as Record<string, string>)["user-agent"]!);
        return new Response("<urlset></urlset>", { status: 200, headers: { "content-type": "application/xml" } });
      }),
    );
    const tools: Record<string, ConfigOverrides["tools"]> = {
      sitemap_filter: [{ name: "search_pages", description: "d", executor: { type: "sitemap_filter", sitemap_url: SITEMAP_URL } }],
      rss_feed: [{ name: "search_pages", description: "d", executor: { type: "rss_feed", feed_url: "https://example.com/feed.xml" } }],
      http_get: [{ name: "search_pages", description: "d", executor: { type: "http_get", url_template: "https://example.com/data.txt" } }],
      http_json: [{ name: "search_pages", description: "d", executor: { type: "http_json", url_template: "https://example.com/data.json" } }],
      dom_extract: [{ name: "search_pages", description: "d", executor: { type: "dom_extract", url_template: "https://example.com/page" } }],
    };

    for (const overrides of Object.values(tools)) {
      // A config hash of its own each time: one tool name and one body would otherwise be a cache hit.
      await run(post("{}"), { tools: overrides }, { version: "4.5.6", configHash: freshConfigHash() });
    }

    expect(agents).toEqual(Array(5).fill("cf-webmcp/4.5.6"));
  });
});

describe("exec: what the executor reads and what the cache is keyed on is the declared input", () => {
  const DATA_URL = "https://example.com/data";
  const declared = (names: string[], executor: Record<string, unknown>, extra: Record<string, unknown> = {}): ConfigOverrides =>
    ({
      tools: [
        {
          name: "search_pages",
          description: "d",
          input_schema: {
            type: "object",
            required: [],
            properties: Object.fromEntries(names.map((n) => [n, n === "tags" ? { type: "array", items: { type: "string" } } : { type: "string" }])),
          },
          executor,
          ...extra,
        },
      ],
    }) as unknown as ConfigOverrides;
  const getJson = (names: string[]) => declared(names, { type: "http_json", url_template: DATA_URL, method: "GET" });

  function origin() {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(String(url));
        return new Response('{"n":1}', { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    return urls;
  }

  describe("the cache key is canonical JSON of the declared input", () => {
    it("is one entry for junk keys, another key order and extra whitespace: a MISS, then HITs, one origin call", async () => {
      const urls = origin();
      const configHash = freshConfigHash();
      const overrides = getJson(["a", "b"]);
      const bodies = [
        '{"a":"1","b":"2"}',
        '{"b":"2","a":"1"}',
        '  {  "a" :  "1" ,   "b" : "2"  }  ',
        '{"a":"1","b":"2","junk":"x","role":"admin"}',
        '{"junk":{"deep":[1,2]},"b":"2","a":"1","__proto__":{"isAdmin":true}}',
      ];

      const answers: string[] = [];
      for (const body of bodies) {
        const res = await runAndSettle(fromOrigin(null, body), configHash, overrides);
        expect(res.status, body).toBe(200);
        answers.push(res.headers.get("x-webmcp-cache")!);
      }

      expect(answers).toEqual(["MISS", "HIT", "HIT", "HIT", "HIT"]);
      expect(urls).toHaveLength(1);
    });

    it("is a different entry for a different declared value: a MISS", async () => {
      const urls = origin();
      const configHash = freshConfigHash();
      const overrides = getJson(["a", "b"]);

      const seen: string[] = [];
      for (const body of ['{"a":"1","b":"2"}', '{"a":"1","b":"3"}', '{"a":"2","b":"2"}', '{"a":"1"}', "{}", '{"a":"1","b":"2"}']) {
        seen.push((await runAndSettle(fromOrigin(null, body), configHash, overrides)).headers.get("x-webmcp-cache")!);
      }

      expect(seen).toEqual(["MISS", "MISS", "MISS", "MISS", "MISS", "HIT"]);
      expect(urls).toHaveLength(5);
    });

    it("keeps the order of an array value: it is part of the input", async () => {
      origin();
      const configHash = freshConfigHash();
      const overrides = getJson(["tags"]);

      const a = await runAndSettle(fromOrigin(null, '{"tags":["x","y"]}'), configHash, overrides);
      const b = await runAndSettle(fromOrigin(null, '{"tags":["y","x"]}'), configHash, overrides);
      const c = await runAndSettle(fromOrigin(null, '{ "tags" : ["x","y"] }'), configHash, overrides);

      expect([a, b, c].map((r) => r.headers.get("x-webmcp-cache"))).toEqual(["MISS", "MISS", "HIT"]);
    });

    it("is stored under the key of the canonical text, which still names the version and the config hash", async () => {
      origin();
      const configHash = freshConfigHash();

      await runAndSettle(fromOrigin(null, '{"b":"2","a":"1","junk":1}'), configHash, getJson(["a", "b"]));

      const key = (version: string, hash: string) =>
        makeCacheKey("example.com", { version, configHash: hash }, { toolName: "search_pages", inputJson: '{"a":"1","b":"2"}' });
      const stored = await caches.default.match(await key(VERSION, configHash));
      expect(stored).toBeDefined();
      expect((await key(VERSION, configHash)).url).toContain(`/${VERSION}/${configHash}/search_pages/`);
      expect(await caches.default.match(await key("9.9.9", configHash))).toBeUndefined();
      expect(await caches.default.match(await key(VERSION, "other000"))).toBeUndefined();
    });

    it("the same declared input under another cf-webmcp version or config hash is a MISS", async () => {
      const urls = origin();
      const configHash = freshConfigHash();
      const overrides = getJson(["a"]);

      const first = await runAndSettle(fromOrigin(null, '{"a":"1"}'), configHash, overrides, "0.6.0");
      const sameKey = await runAndSettle(fromOrigin(null, '{ "a":"1", "x":2 }'), configHash, overrides, "0.6.0");
      const upgraded = await runAndSettle(fromOrigin(null, '{"a":"1"}'), configHash, overrides, "0.6.1");
      const reconfigured = await runAndSettle(fromOrigin(null, '{"a":"1"}'), freshConfigHash(), overrides, "0.6.0");

      expect([first, sameKey, upgraded, reconfigured].map((r) => r.headers.get("x-webmcp-cache"))).toEqual(["MISS", "HIT", "MISS", "MISS"]);
      expect(urls).toHaveLength(3);
    });

    it("applies to every tool, a tool that declares nothing included: any body is the same call", async () => {
      const urls = origin();
      const configHash = freshConfigHash();
      const none = getJson([]);

      const seen = [];
      for (const body of ["{}", '{"anything":1}', '{"a":"x","b":[1]}', "  {  }  "]) {
        seen.push((await runAndSettle(fromOrigin(null, body), configHash, none)).headers.get("x-webmcp-cache"));
      }

      expect(seen).toEqual(["MISS", "HIT", "HIT", "HIT"]);
      expect(urls).toHaveLength(1);
    });

    it("a cached POST tool is keyed the same way, and sends the declared body on a miss only", async () => {
      const calls: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init?: RequestInit) => {
          calls.push(init?.body);
          return new Response('{"ok":1}', { status: 200, headers: { "content-type": "application/json" } });
        }),
      );
      const configHash = freshConfigHash();
      const overrides = declared(["q"], { type: "http_json", url_template: "https://example.com/send", method: "POST" }, { cache: { s_maxage: 60 } });

      const a = await runAndSettle(fromOrigin(null, '{"q":"a","junk":1}'), configHash, overrides);
      const b = await runAndSettle(fromOrigin(null, '{"junk":2,"q":"a"}'), configHash, overrides);

      expect([a, b].map((r) => r.headers.get("x-webmcp-cache"))).toEqual(["MISS", "HIT"]);
      expect(calls).toEqual(['{"q":"a"}']);
    });
  });

  describe("the executor is given the declared input only", () => {
    it("reads a declared placeholder from the request, and nothing else", async () => {
      const urls = origin();
      const overrides = declared(["id"], { type: "http_json", url_template: "https://example.com/items/{{id}}", method: "GET" });

      const res = await runAndSettle(fromOrigin(null, '{"id":"7","junk":1}'), freshConfigHash(), overrides);

      expect(res.status).toBe(200);
      expect(urls).toEqual(["https://example.com/items/7"]);
    });

    it("never reads a placeholder the tool does not declare, even from a stale config: the call fails and origin is not asked", async () => {
      const urls = origin();
      // The build refuses this config (undeclared input name); the runtime does not depend on that.
      const overrides = declared([], { type: "http_json", url_template: "https://example.com/items/{{secret}}", method: "GET" });

      const res = await runAndSettle(fromOrigin(null, '{"secret":"x"}'), freshConfigHash(), overrides);

      expect(res.status).toBe(400);
      expect(((await res.json()) as ErrorBody).error.code).toBe("invalid_input");
      expect(urls).toEqual([]);
    });

    it("ignores an undeclared query on a sitemap_filter tool: it lists, as a tool that declares no query does", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => sitemapOk()));
      const overrides = declared([], { type: "sitemap_filter", sitemap_url: SITEMAP_URL });

      const res = await runAndSettle(fromOrigin(null, '{"query":"no-such-page-anywhere"}'), freshConfigHash(), overrides);

      const body = (await res.json()) as { ok: boolean; data: { entries: unknown[] } };
      expect(body.ok).toBe(true);
      expect(body.data.entries).toHaveLength(1);
    });
  });

  describe("a path placeholder cannot leave its path prefix", () => {
    const apiTool = declared(["id"], { type: "http_json", url_template: "https://example.com/api/{{id}}", method: "GET" });

    it.each(["../../admin", "..%2F..%2Fadmin", "%2e%2e/admin", "a/../../admin", "/./x"])(
      "%j is refused as invalid_input, and no request, with its token headers, is made",
      async (id) => {
        const urls = origin();

        const res = await run(post(JSON.stringify({ id })), apiTool, { deployToken: "t0ken", configHash: freshConfigHash() });

        expect(res.status).toBe(400);
        const body = (await res.json()) as ErrorBody;
        expect(body.error.code).toBe("invalid_input");
        expect(body.error.message).toContain("{{id}}");
        expect(urls).toEqual([]);
      },
    );

    it("lets a normal id through to the path it names", async () => {
      const urls = origin();

      await run(post(JSON.stringify({ id: "v1.2/file.json" })), apiTool, { configHash: freshConfigHash() });

      expect(urls).toEqual(["https://example.com/api/v1.2/file.json"]);
    });

    it("still lets a get_page-style root template fetch any normal path", async () => {
      const urls: string[] = [];
      const page = declared(["path"], { type: "dom_extract", url_template: "https://example.com{{path}}" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          urls.push(String(url));
          return new Response("<html><body><main>hi</main></body></html>", { status: 200, headers: { "content-type": "text/html" } });
        }),
      );

      const ok = await run(post(JSON.stringify({ path: "/blog/hello-world.html" })), page, { configHash: freshConfigHash() });
      const climb = await run(post(JSON.stringify({ path: "/../admin" })), page, { configHash: freshConfigHash() });

      expect(ok.status).toBe(200);
      expect(climb.status).toBe(400);
      expect(urls).toEqual(["https://example.com/blog/hello-world.html"]);
    });
  });
});
