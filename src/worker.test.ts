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

async function call(
  handler: ReturnType<typeof createHandler>,
  url: string,
  init?: RequestInit,
  envOverride: Env = env,
): Promise<Response> {
  return handler.fetch(new Request(url, init) as Request<unknown, IncomingRequestCfProperties>, envOverride, makeCtx());
}

/** An Env whose R2 binding holds exactly the given objects (key -> body). */
function envWithObjects(objects: Record<string, string>) {
  const get = vi.fn(async (key: string) => {
    const body = objects[key];
    if (body === undefined) return null;
    return { body: new Response(body).body, httpEtag: '"test"' } as unknown as R2ObjectBody;
  });
  const head = vi.fn(async (key: string) => (key in objects ? ({ key } as unknown as R2Object) : null));
  const env: Env = { CF_WEBMCP_ASSETS: { get, head } as unknown as R2Bucket };
  return { env, get, head };
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

  it("leaves the body untouched but still sends the Link header when features.inject_html is false", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(makeDeps({ features: { inject_html: false } }));

    const res = await call(handler, "https://example.com/page");

    expect(await res.text()).toBe(HTML);
    expect(res.headers.get("link")).toContain('rel="webmcp"');
  });

  it("sends no Link header when both inject_html and link_header are off", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(makeDeps({ features: { inject_html: false, link_header: false } }));

    const res = await call(handler, "https://example.com/page");

    expect(await res.text()).toBe(HTML);
    expect(res.headers.get("link")).toBeNull();
  });

  it("appends the script at the end of minified HTML that has no </body>", async () => {
    stubOrigin({
      "https://example.com/min": () => htmlResponse("<!doctype html><html><head><title>t</title></head><body><p>hi"),
    });
    const handler = createHandler(makeDeps());

    const body = await (await call(handler, "https://example.com/min")).text();

    expect(body).toMatch(/<p>hi<script[^>]+\/_webmcp\/bootstrap\.test\.js[^>]*><\/script>$/);
    expect(body).toContain('<link rel="webmcp"');
  });
});

describe("worker fails open", () => {
  it("serves the origin HTML unchanged, with the Link header, when a form selector makes HTMLRewriter throw", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubOrigin({ "https://example.com/page": () => htmlResponse("<html><head></head><body><form id=a></form></body></html>") });
    const deps = makeDeps();
    // Bypass the schema (which now rejects this selector at build time) to model a
    // selector that slips through, e.g. an older generated config.
    deps.config.forms = [
      { name: "contact", description: "d", selector: "form:has(input)", paths: [], autosubmit: false, params: [] },
    ];
    const handler = createHandler(deps);

    const res = await call(handler, "https://example.com/page");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html><head></head><body><form id=a></form></body></html>");
    expect(res.headers.get("link")).toContain('rel="webmcp"');
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it.each([true, false])("passes an origin 101 WebSocket upgrade through untouched (inject_html=%s)", async (injectHtml) => {
    const pair = new WebSocketPair();
    const upstream = new Response(null, { status: 101, webSocket: pair[0] });
    stubOrigin({ "https://example.com/socket": () => upstream });
    const handler = createHandler(makeDeps({ features: { inject_html: injectHtml } }));

    const res = await call(handler, "https://example.com/socket", { headers: { upgrade: "websocket" } });

    expect(res).toBe(upstream);
    expect(res.status).toBe(101);
    expect(res.webSocket).not.toBeNull();
  });
});

describe("unknown paths under the namespace", () => {
  const unknown = [
    "/_webmcp/does-not-exist",
    "/_webmcp/",
    "/_webmcp/exec/UPPER",
    "/_webmcp/exec/search_pages/extra",
    "/_webmcp/exec/",
    "/_webmcp/bootstrap.js",
    "/_webmcp/sub/dir/file.txt",
  ];

  it.each(unknown)("answers %s with 404 no-store noindex and never asks origin", async (path) => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps());

    const res = await call(handler, `https://example.com${path}`);

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers HEAD with the same 404 headers and no body", async () => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/_webmcp/does-not-exist", { method: "HEAD" });

    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(await res.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers any method with 404, not only GET", async () => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/_webmcp/exec/UPPER", { method: "POST", body: "{}" });

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still serves the known namespace routes", async () => {
    stubOrigin({});
    const handler = createHandler(makeDeps());

    expect((await call(handler, "https://example.com/_webmcp/health")).status).toBe(200);
    expect((await call(handler, "https://example.com/_webmcp/bootstrap.test.js")).status).toBe(200);
    // A configured tool name that is not POSTed to is the exec route's own 405, not a namespace 404.
    expect((await call(handler, "https://example.com/_webmcp/exec/search_pages")).status).toBe(405);
  });

  it("keeps proxying paths that merely share the namespace spelling as a prefix", async () => {
    const fetchMock = stubOrigin({ "https://example.com/_webmcp-docs": () => htmlResponse() });
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/_webmcp-docs");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("applies to the configured namespace only", async () => {
    const fetchMock = stubOrigin({ "https://example.com/_webmcp/anything": () => htmlResponse() });
    const handler = createHandler(makeDeps({ paths: { namespace: "/_x" } }));

    const inside = await call(handler, "https://example.com/_x/anything");
    const outside = await call(handler, "https://example.com/_webmcp/anything");

    expect(inside.status).toBe(404);
    expect(outside.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("content-addressed bootstrap", () => {
  const BOOTSTRAP_ASSET = "bootstrap.0123456789abcdef.js";
  const SRI = `sha384-${"A".repeat(64)}`;

  it("serves the current bootstrap hash with immutable caching", async () => {
    stubOrigin({});
    const handler = createHandler(
      makeDeps({}, { assets: { bootstrapJs: "/*current*/" }, meta: { BOOTSTRAP_ASSET } }),
    );

    const res = await call(handler, `https://example.com/_webmcp/${BOOTSTRAP_ASSET}`);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    expect(await res.text()).toBe("/*current*/");
  });

  it("answers a stale bootstrap hash with 404 no-store noindex and never asks origin", async () => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps({}, { meta: { BOOTSTRAP_ASSET } }));

    const res = await call(handler, "https://example.com/_webmcp/bootstrap.ffffffffffffffff.js");

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers HEAD on a stale hash with the same 404 headers and no body", async () => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps({}, { meta: { BOOTSTRAP_ASSET } }));

    const res = await call(handler, "https://example.com/_webmcp/bootstrap.ffffffffffffffff.js", { method: "HEAD" });

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects a script whose src ends with the namespaced current asset and carries the SRI hash", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(makeDeps({}, { meta: { BOOTSTRAP_ASSET, BOOTSTRAP_SRI: SRI } }));

    const body = await (await call(handler, "https://example.com/page")).text();

    const tag = body.match(/<script[^>]*src="([^"]+)"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag![1]!.endsWith(`/_webmcp/${BOOTSTRAP_ASSET}`)).toBe(true);
    expect(tag![0]).toContain(`integrity="${SRI}"`);
    expect(tag![0]).toContain('crossorigin="anonymous"');
  });

  it("omits integrity from the injected script when BOOTSTRAP_SRI is null", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(makeDeps({}, { meta: { BOOTSTRAP_ASSET, BOOTSTRAP_SRI: null } }));

    const body = await (await call(handler, "https://example.com/page")).text();

    expect(body).toContain(`/_webmcp/${BOOTSTRAP_ASSET}`);
    expect(body).not.toContain("integrity=");
  });
});

describe("content-addressed widget", () => {
  const WIDGET_ASSET = "widget.fedcba9876543210.js";
  const WIDGET_BODY = "/*preamble*/\nwidget();";

  it("serves the current widget object from R2 as stored", async () => {
    const fetchMock = stubOrigin({});
    const { env: r2Env } = envWithObjects({ [WIDGET_ASSET]: WIDGET_BODY });
    const handler = createHandler(makeDeps({}, { meta: { WIDGET_ASSET } }));

    const res = await call(handler, `https://example.com/_webmcp/${WIDGET_ASSET}`, undefined, r2Env);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe(WIDGET_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a stale widget hash with 404 no-store noindex without touching R2 or origin", async () => {
    const fetchMock = stubOrigin({});
    const { env: r2Env, get } = envWithObjects({ [WIDGET_ASSET]: WIDGET_BODY });
    const handler = createHandler(makeDeps({}, { meta: { WIDGET_ASSET } }));

    const res = await call(handler, "https://example.com/_webmcp/widget.0000000000000000.js", undefined, r2Env);

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("answers any widget path with 404 noindex when the build has no widget asset", async () => {
    const fetchMock = stubOrigin({});
    const { env: r2Env, get, head } = envWithObjects({});
    const handler = createHandler(makeDeps({}, { meta: { WIDGET_ASSET: null } }));

    const res = await call(handler, "https://example.com/_webmcp/widget.anything.js", undefined, r2Env);

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });

  it("answers a widget path with 404 noindex when the feature is off", async () => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps({ features: { fallback_widget: false } }, { meta: { WIDGET_ASSET } }));

    const res = await call(handler, `https://example.com/_webmcp/${WIDGET_ASSET}`);

    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("health reports widget_asset_present null and never probes R2 when the build has no widget", async () => {
    stubOrigin({});
    const { env: r2Env, head } = envWithObjects({});
    const handler = createHandler(makeDeps({}, { meta: { WIDGET_ASSET: null } }));

    const res = await call(handler, "https://example.com/_webmcp/health", undefined, r2Env);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { widget_asset_present: unknown }).widget_asset_present).toBeNull();
    expect(head).not.toHaveBeenCalled();
  });

  it("health reports whether the expected widget object is in R2", async () => {
    stubOrigin({});
    const present = envWithObjects({ [WIDGET_ASSET]: WIDGET_BODY });
    const absent = envWithObjects({});
    const handler = createHandler(makeDeps({}, { meta: { WIDGET_ASSET } }));

    const a = await call(handler, "https://example.com/_webmcp/health", undefined, present.env);
    const b = await call(handler, "https://example.com/_webmcp/health", undefined, absent.env);

    expect(((await a.json()) as { widget_asset_present: unknown }).widget_asset_present).toBe(true);
    expect(((await b.json()) as { widget_asset_present: unknown }).widget_asset_present).toBe(false);
    expect(present.head).toHaveBeenCalledWith(WIDGET_ASSET);
  });
});
