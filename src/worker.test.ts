/**
 * Worker-level tests. These drive the real request pipeline (router, route
 * handlers, proxy, HTMLRewriter injection) through createHandler() with an
 * injected config, so each case can vary config and canned origin responses
 * without touching the generated modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Env } from "./handler";
import { makeDeps } from "./test-support/config";

const HTML = "<html><head></head><body>hi</body></html>";

const env: Env = {
  CF_WEBMCP_ASSETS: { get: vi.fn(async () => null) } as unknown as R2Bucket,
};

function makeCtx(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}

type Canned = Response | (() => Response);

/** Stub global fetch with canned responses keyed by the requested URL. */
function stubOrigin(routes: Record<string, Canned>) {
  const mock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const canned = routes[url];
    if (!canned) return new Response(`no canned response for ${url}`, { status: 599 });
    return typeof canned === "function" ? canned() : canned;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function htmlResponse(body = HTML): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

async function call(handler: ReturnType<typeof createHandler>, url: string, init?: RequestInit): Promise<Response> {
  return handler.fetch(new Request(url, init) as Request<unknown, IncomingRequestCfProperties>, env, makeCtx());
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("worker proxy", () => {
  it("injects the bootstrap script and a Link header into proxied HTML", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/page");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<script");
    expect(body).toContain("/_webmcp/bootstrap.test.js");
    expect(body).toContain('<link rel="webmcp"');
    expect(res.headers.get("link")).toContain('rel="webmcp"');
  });

  it("passes non-HTML bodies through untouched and still adds the Link header", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    stubOrigin({
      "https://example.com/logo.png": () =>
        new Response(png, { status: 200, headers: { "content-type": "image/png" } }),
    });
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/logo.png");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("link")).toContain('rel="webmcp"');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it("relays an origin 302 with its Location unchanged", async () => {
    stubOrigin({
      "https://example.com/old": () =>
        new Response(null, { status: 302, headers: { location: "https://example.com/new" } }),
    });
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/old");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/new");
  });

  it("proxies an unknown path to origin.base_url plus the path and query", async () => {
    const fetchMock = stubOrigin({
      "https://origin.example.com/about?ref=nav": () => htmlResponse("<html><head></head><body>about</body></html>"),
    });
    const handler = createHandler(
      makeDeps({ origin: { base_url: "https://origin.example.com", allowed_origins: ["https://origin.example.com"] } }),
    );

    const res = await call(handler, "https://example.com/about?ref=nav");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe("https://origin.example.com/about?ref=nav");
    expect((init as Request).redirect).toBe("manual");
    expect(await res.text()).toContain("about");
  });

  it("returns origin HTML unchanged when features.inject_html is false", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(makeDeps({ features: { inject_html: false } }));

    const res = await call(handler, "https://example.com/page");

    expect(await res.text()).toBe(HTML);
    expect(res.headers.get("link")).toBeNull();
  });
});

describe("worker routes served from injected assets", () => {
  it("serves the manifest asset body at the canonical manifest path", async () => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps({}, { assets: { manifestJson: '{"from":"deps"}' } }));

    const res = await call(handler, "https://example.com/.well-known/webmcp");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe('{"from":"deps"}');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers HEAD on the manifest with headers and no body", async () => {
    stubOrigin({});
    const handler = createHandler(makeDeps({}, { assets: { manifestJson: '{"from":"deps"}' } }));

    const res = await call(handler, "https://example.com/.well-known/webmcp", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe("");
  });

  it("serves the bootstrap asset at the namespaced, hashed path", async () => {
    stubOrigin({});
    const handler = createHandler(makeDeps({}, { assets: { bootstrapJs: "/*bootstrap from deps*/" } }));

    const res = await call(handler, "https://example.com/_webmcp/bootstrap.test.js");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/*bootstrap from deps*/");
  });

  it("301-redirects the legacy manifest alias to the canonical path", async () => {
    stubOrigin({});
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/.well-known/webmcp.json");

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/.well-known/webmcp");
  });
});
