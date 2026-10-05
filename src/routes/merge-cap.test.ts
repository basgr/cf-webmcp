/**
 * The merge routes (llms.txt, robots.txt, agents.md, the API catalog, SKILL.md in merge
 * mode) read origin's file to splice their block into it. That read has a cap of 1 MiB and a
 * failure path:
 *
 *   - a body over the cap, by its Content-Length or found out while reading, is relayed as
 *     origin sent it (status, headers, every byte), with the route's X-Robots-Tag policy;
 *   - a body that fails before the cap is a failed origin: the route serves what it serves
 *     when origin has no file, with Cache-Control public, max-age=60, s-maxage=60, instead of
 *     throwing to the platform error page (which carries no noindex).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Env } from "../handler";
import { llmsTxtResponse } from "./llms-txt";
import { robotsTxtResponse } from "./robots-txt";
import { agentsMdResponse } from "./agents-md";
import { apiCatalogResponse } from "./api-catalog";
import { agentSkillsResponse } from "./agent-skills";
import { makeConfig, makeDeps, type ConfigOverrides } from "../test-support/config";

const MIB = 1024 * 1024;
const SHORT_CACHE = "public, max-age=60, s-maxage=60";

type Proxy = (url: URL) => Promise<Response>;

/** `total` bytes of `fill` in 64 KiB chunks; the stream errors once `failAfter` bytes were sent. */
function body(total: number, opts: { failAfter?: number; fill?: number } = {}): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (opts.failAfter !== undefined && sent >= opts.failAfter) {
        controller.error(new Error("connection reset"));
        return;
      }
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(64 * 1024, total - sent);
      controller.enqueue(new Uint8Array(n).fill(opts.fill ?? 0x61));
      sent += n;
    },
  });
}

const notFound: Proxy = async () => new Response("not found", { status: 404 });

interface RouteCase {
  name: string;
  /** Config overrides that put the route in merge mode. */
  merge: ConfigOverrides;
  /** The path the route is configured at, and a config that moves it under a protected prefix. */
  protectedPath: ConfigOverrides;
  contentType: string;
  /** `apex`: no X-Robots-Tag at its usual path (llms.txt, robots.txt). `always`: noindex. */
  robots: "apex" | "always";
  call: (config: ReturnType<typeof makeConfig>, proxy: Proxy) => Promise<Response>;
  /** A mergeable origin document of exactly `size` bytes. */
  document: (size: number) => Uint8Array;
}

const ENC = new TextEncoder();
const padded = (head: string, size: number): Uint8Array => {
  const bytes = new Uint8Array(size).fill(0x20);
  bytes.set(ENC.encode(head));
  return bytes;
};

const cases: RouteCase[] = [
  {
    name: "llms.txt",
    merge: { llms_txt: { mode: "merge" } },
    protectedPath: { llms_txt: { mode: "merge", path: "/.well-known/llms.txt" } },
    contentType: "text/plain; charset=utf-8",
    robots: "apex",
    call: (config, proxy) => llmsTxtResponse(new Request("https://example.com/llms.txt"), config, proxy),
    document: (size) => padded("# Origin llms.txt\n", size),
  },
  {
    name: "robots.txt",
    merge: { robots_txt: { mode: "merge" } },
    protectedPath: { robots_txt: { mode: "merge", path: "/_webmcp/robots.txt" } },
    contentType: "text/plain",
    robots: "apex",
    call: (config, proxy) => robotsTxtResponse(new Request("https://example.com/robots.txt"), config, proxy),
    document: (size) => padded("User-agent: *\nDisallow: /private/\n", size),
  },
  {
    name: "agents.md",
    merge: { agents_md: { mode: "merge" } },
    protectedPath: {},
    contentType: "text/markdown; charset=utf-8",
    robots: "always",
    call: (config, proxy) => agentsMdResponse(new Request("https://example.com/.well-known/agents.md"), config, proxy),
    document: (size) => padded("# Origin agents.md\n", size),
  },
  {
    name: "api-catalog",
    merge: { api_catalog: { mode: "merge" } },
    protectedPath: {},
    contentType: "application/linkset+json",
    robots: "always",
    call: (config, proxy) => apiCatalogResponse(new Request("https://example.com/.well-known/api-catalog"), config, proxy),
    document: (size) => padded('{"linkset":[{"anchor":"https://example.com/api","service-doc":[{"href":"https://example.com/docs"}]}]}', size),
  },
  {
    name: "SKILL.md (merge mode)",
    merge: { agent_skills: { mode: "merge" } },
    protectedPath: {},
    contentType: "text/markdown",
    robots: "always",
    call: (config, proxy) => agentSkillsResponse(new Request("https://example.com/.well-known/agent-skills/site/SKILL.md"), config, proxy),
    document: (size) => padded("---\nname: origin\ndescription: Origin skill\n---\n\n# Origin\n", size),
  },
];

const readAll = async (res: Response): Promise<number> => new Uint8Array(await res.arrayBuffer()).byteLength;

describe.each(cases)("$name: the cap on origin's file", (c) => {
  const config = () => makeConfig(c.merge);

  /** What the route serves when origin has no file: the reference for every stand-in. */
  const standIn = async () => {
    const res = await c.call(config(), notFound);
    return { text: await res.text(), cacheControl: res.headers.get("cache-control"), contentType: res.headers.get("content-type") };
  };

  it("relays a body over 1 MiB by its Content-Length, unmerged and every byte of it", async () => {
    const upstream = new Response(body(MIB + 1), {
      status: 200,
      headers: { "content-type": c.contentType, "content-length": String(MIB + 1), "x-origin-marker": "kept" },
    });

    const res = await c.call(config(), async () => upstream);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(c.contentType);
    expect(res.headers.get("x-origin-marker")).toBe("kept");
    expect(await readAll(res)).toBe(MIB + 1);
  });

  it("does not read a body whose Content-Length is over the cap before relaying it", async () => {
    let pulled = false;
    // Finite on purpose: a route that reads it to the end must end, not exhaust memory.
    const unread = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled = true;
          controller.enqueue(new Uint8Array(8).fill(0x61));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const upstream = new Response(unread, { status: 200, headers: { "content-type": c.contentType, "content-length": String(MIB + 5) } });

    const res = await c.call(config(), async () => upstream);

    expect(pulled).toBe(false);
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it("relays a body over 1 MiB that has no Content-Length, found out while reading, every byte of it", async () => {
    const total = MIB + 100_000;
    const upstream = new Response(body(total), { status: 200, headers: { "content-type": c.contentType, "x-origin-marker": "kept" } });

    const res = await c.call(config(), async () => upstream);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(c.contentType);
    expect(res.headers.get("x-origin-marker")).toBe("kept");
    expect(await readAll(res)).toBe(total);
  });

  it("an oversize relay is not our document: no block is spliced in", async () => {
    const total = MIB + 10;
    const res = await c.call(config(), async () => new Response(body(total), { status: 200, headers: { "content-type": c.contentType } }));
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBe(total);
    expect(bytes.every((b) => b === 0x61)).toBe(true);
  });

  it("serves what the route serves when origin has no file, with the 60 second cache, when the body fails mid-stream", async () => {
    const expected = await standIn();
    const upstream = new Response(body(10 * 64 * 1024, { failAfter: 2 * 64 * 1024 }), { status: 200, headers: { "content-type": c.contentType } });

    const res = await c.call(config(), async () => upstream);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expected.text);
    expect(res.headers.get("cache-control")).toBe(SHORT_CACHE);
    expect(res.headers.get("content-type")).toBe(expected.contentType);
    // The ordinary stand-in keeps the ordinary cache.
    expect(expected.cacheControl).not.toBe(SHORT_CACHE);
  });

  it("also falls back when the very first read fails", async () => {
    const expected = await standIn();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket closed"));
      },
    });

    const res = await c.call(config(), async () => new Response(broken, { status: 200, headers: { "content-type": c.contentType } }));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(expected.text);
    expect(res.headers.get("cache-control")).toBe(SHORT_CACHE);
  });

  it("merges a body of exactly 1 MiB, with the ordinary cache", async () => {
    const expected = await standIn();
    const doc = c.document(MIB);
    expect(doc.byteLength).toBe(MIB);

    const res = await c.call(config(), async () => new Response(doc, { status: 200, headers: { "content-type": c.contentType } }));

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(expected.cacheControl);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    // Our part is in it: merged output differs from the untouched origin document.
    expect(text).not.toBe(new TextDecoder().decode(doc));
  });

  it("merges a body of 1 MiB + 1 byte as an oversize body: relayed untouched", async () => {
    const doc = c.document(MIB + 1);
    const res = await c.call(config(), async () => new Response(doc, { status: 200, headers: { "content-type": c.contentType } }));
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(doc);
  });

  describe("X-Robots-Tag", () => {
    const oversize = () => new Response(body(MIB + 10), { status: 200, headers: { "content-type": c.contentType, "x-robots-tag": "all" } });
    const failing = () => new Response(body(MIB, { failAfter: 64 * 1024 }), { status: 200, headers: { "content-type": c.contentType } });

    if (c.robots === "always") {
      it("is noindex on the relay and on the stand-in", async () => {
        expect((await c.call(config(), async () => oversize())).headers.get("x-robots-tag")).toBe("noindex");
        expect((await c.call(config(), async () => failing())).headers.get("x-robots-tag")).toBe("noindex");
      });
    } else {
      it("is absent at the apex path, even when origin sent one, on the relay and on the stand-in", async () => {
        expect((await c.call(config(), async () => oversize())).headers.has("x-robots-tag")).toBe(false);
        expect((await c.call(config(), async () => failing())).headers.has("x-robots-tag")).toBe(false);
      });

      it("is noindex when the configured path sits under a protected prefix, on the relay and on the stand-in", async () => {
        const moved = makeConfig(c.protectedPath);
        expect((await c.call(moved, async () => oversize())).headers.get("x-robots-tag")).toBe("noindex");
        expect((await c.call(moved, async () => failing())).headers.get("x-robots-tag")).toBe("noindex");
      });
    }
  });

  it("keeps the existing answers for every other origin status: a 5xx is relayed, a 404 is the stand-in", async () => {
    const err = await c.call(config(), async () => new Response("boom", { status: 503, headers: { "content-type": "text/plain" } }));
    expect(err.status).toBe(503);
    expect(await err.text()).toBe("boom");

    const missing = await c.call(config(), notFound);
    expect(missing.status).toBe(200);
    expect(missing.headers.get("cache-control")).not.toBe(SHORT_CACHE);
  });
});

// The same cases through the real handler: nothing may throw to the platform error page.
describe("through the handler: a failing or oversize origin file never throws", () => {
  const env: Env = { CF_WEBMCP_ASSETS: { get: vi.fn(async () => null) } as unknown as R2Bucket };
  const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} }) as unknown as ExecutionContext;

  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const urls: Array<[string, string, string, ConfigOverrides]> = [
    ["llms.txt", "https://example.com/llms.txt", "text/plain", {}],
    ["robots.txt", "https://example.com/robots.txt", "text/plain", {}],
    ["agents.md", "https://example.com/.well-known/agents.md", "text/markdown", {}],
    ["api-catalog", "https://example.com/.well-known/api-catalog", "application/linkset+json", {}],
    ["SKILL.md", "https://example.com/.well-known/agent-skills/site/SKILL.md", "text/markdown", { agent_skills: { mode: "merge" } }],
  ];

  it.each(urls)("%s: a body that fails mid-stream is a 200 with the short cache", async (_name, url, contentType, overrides) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body(MIB, { failAfter: 64 * 1024 }), { status: 200, headers: { "content-type": contentType } })),
    );
    const handler = createHandler(makeDeps(overrides));

    const res = await handler.fetch(new Request(url) as Request<unknown, IncomingRequestCfProperties>, env, ctx());

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(SHORT_CACHE);
    expect((await res.text()).length).toBeGreaterThan(0);
  });

  it.each(urls)("%s: an oversize body is relayed whole", async (_name, url, contentType, overrides) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body(MIB + 50_000), { status: 200, headers: { "content-type": contentType } })),
    );
    const handler = createHandler(makeDeps(overrides));

    const res = await handler.fetch(new Request(url) as Request<unknown, IncomingRequestCfProperties>, env, ctx());

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(contentType);
    expect(await readAll(res)).toBe(MIB + 50_000);
  });
});
