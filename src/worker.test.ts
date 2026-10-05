/**
 * Worker-level tests. These drive the real request pipeline (router, route
 * handlers, proxy, HTMLRewriter injection) through createHandler() with an
 * injected config, so each case can vary config and canned origin responses
 * without touching the generated modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, originTarget, PROXY_ORIGIN_TIMEOUT_MS, type Env } from "./handler";
import { makeDeps, type ConfigOverrides } from "./test-support/config";
import { expiryInDays, makeOriginTrialToken } from "./test-support/origin-trial";

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

describe("proxy: a request path never names the host the Worker fetches", () => {
  interface Seen {
    url: string;
    method: string;
    cookie: string | null;
    authorization: string | null;
    body: string | null;
  }

  /** Record every fetch the Worker makes, whatever its URL, and answer each with an HTML page. */
  function recordFetches(): Seen[] {
    const seen: Seen[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = new Request(input as RequestInfo, init);
        seen.push({
          url: req.url,
          method: req.method,
          cookie: req.headers.get("cookie"),
          authorization: req.headers.get("authorization"),
          body: req.method === "GET" || req.method === "HEAD" ? null : await req.text(),
        });
        return htmlResponse("<html><head></head><body>origin page</body></html>");
      }),
    );
    return seen;
  }

  const visitorHeaders = { cookie: "session=victim", authorization: "Bearer visitor", accept: "text/html" };

  // Each of these parses to a pathname that starts with "//": resolved against base_url as a
  // relative reference, it would be a protocol-relative URL naming attacker.example.
  it.each([
    "//attacker.example/login",
    "//attacker.example",
    "///attacker.example/x",
    "/\\attacker.example/x",
    "/.//attacker.example/x",
    "/..//attacker.example/x",
    "/%2F%2Fattacker.example/x",
  ])("GET %s goes to the configured origin with the visitor's path, never to attacker.example", async (path) => {
    const seen = recordFetches();
    const handler = createHandler(makeDeps());

    const url = `https://example.com${path}`;
    const res = await call(handler, url, { headers: visitorHeaders });
    await res.text();

    if (res.status === 400) {
      expect(seen).toEqual([]);
      return;
    }
    expect(seen).toHaveLength(1);
    const target = new URL(seen[0]!.url);
    expect(target.origin).toBe("https://example.com");
    expect(target.pathname).toBe(new URL(url).pathname);
  });

  it("a POST with a body to //attacker.example/collect sends the body and the visitor's headers to the configured origin only", async () => {
    const seen = recordFetches();
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com//attacker.example/collect", {
      method: "POST",
      body: "secret=1",
      headers: { ...visitorHeaders, "content-type": "application/x-www-form-urlencoded" },
    });
    await res.text();

    if (res.status === 400) {
      expect(seen).toEqual([]);
      return;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      url: "https://example.com//attacker.example/collect",
      method: "POST",
      cookie: "session=victim",
      authorization: "Bearer visitor",
      body: "secret=1",
    });
  });

  it.each([
    ["an ordinary path", "/blog/post", "https://example.com/blog/post"],
    ["a path with // in the middle", "/a//b", "https://example.com/a//b"],
    ["a query string", "/search?q=a%20b&page=2", "https://example.com/search?q=a%20b&page=2"],
    ["a query string that holds //", "/r?next=//attacker.example/x", "https://example.com/r?next=//attacker.example/x"],
  ])("leaves %s as it was", async (_label, path, expected) => {
    const seen = recordFetches();
    const handler = createHandler(makeDeps());

    const res = await call(handler, `https://example.com${path}`, { headers: visitorHeaders });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("origin page");
    expect(seen.map((s) => s.url)).toEqual([expected]);
    expect(seen[0]!.cookie).toBe("session=victim");
  });

  it("uses only the origin of a base_url that carries a path, as before: the path is not a prefix", async () => {
    const seen = recordFetches();
    const handler = createHandler(
      makeDeps({ origin: { base_url: "https://origin.example.com/blog/", allowed_origins: ["https://origin.example.com"] } }),
    );

    await (await call(handler, "https://example.com/about?x=1")).text();
    await (await call(handler, "https://example.com//attacker.example/x")).text();

    expect(seen.map((s) => s.url)).toEqual([
      "https://origin.example.com/about?x=1",
      "https://origin.example.com//attacker.example/x",
    ]);
  });
});

describe("originTarget: the URL on the configured origin for a request's path and query", () => {
  it("keeps the path and query, and the origin of base_url, whatever the path starts with", () => {
    expect(originTarget("https://example.com", { pathname: "/a//b", search: "?q=1" })?.href).toBe("https://example.com/a//b?q=1");
    expect(originTarget("https://example.com", { pathname: "//attacker.example/x", search: "" })?.href).toBe(
      "https://example.com//attacker.example/x",
    );
    expect(originTarget("https://EXAMPLE.com:443/blog/", { pathname: "/x", search: "" })?.href).toBe("https://example.com/x");
  });

  it("is null for a path that would leave the origin, so nothing is fetched", () => {
    // A pathname the URL parser never produces for an http(s) request; the guard is the backstop.
    expect(originTarget("https://example.com", { pathname: "@attacker.example/x", search: "" })).toBeNull();
    expect(originTarget("https://example.com", { pathname: ".attacker.example/x", search: "" })).toBeNull();
    expect(originTarget("https://example.com", { pathname: ":8443/x", search: "" })).toBeNull();
  });
});

describe("worker fails open", () => {
  it("a form selector HTMLRewriter rejects skips only that form: the page still gets the script, link tags and Link header", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    stubOrigin({
      "https://example.com/page": () =>
        htmlResponse("<html><head></head><body><form id=a></form><form id=b></form></body></html>"),
    });
    const deps = makeDeps();
    // Bypass the schema (which rejects these selectors at build time) to model a
    // selector that slips through, e.g. an older generated config. paths is empty,
    // so both forms apply to every page.
    deps.config.forms = [
      { name: "broken", description: "d", selector: "form:has(input)", paths: [], autosubmit: false, params: [] },
      { name: "contact", description: "Contact us.", selector: "form#b", paths: [], autosubmit: false, params: [] },
    ];
    const handler = createHandler(deps);

    const res = await call(handler, "https://example.com/page");
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("/_webmcp/bootstrap.test.js");
    expect(body).toContain('<link rel="webmcp"');
    expect(body).toMatch(/<form id="?b"?[^>]*toolname="contact"/);
    expect(body).not.toContain('toolname="broken"');
    expect(res.headers.get("link")).toContain('rel="webmcp"');
    expect(errors).toHaveBeenCalledTimes(1);
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

  it.each([
    "https://example.com",
    "https://www.example.com",
    "https://my-site.example.workers.dev",
    "https://preview-123.example.pages.dev",
    "http://localhost:8787",
  ])("injects a script src on the origin of the request (%s), so it loads from the host that served the page", async (origin) => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(makeDeps({}, { meta: { BOOTSTRAP_ASSET, BOOTSTRAP_SRI: SRI } }));

    const body = await (await call(handler, `${origin}/page`)).text();

    const tag = body.match(/<script[^>]*src="([^"]+)"[^>]*>/);
    expect(tag).not.toBeNull();
    // The visitor's own scheme, host and port, then the namespaced asset. An absolute URL to
    // [site].domain is cross-origin on www, workers.dev and preview hosts, where
    // crossorigin="anonymous" with no CORS header blocks the script; a root-relative one would
    // follow a <base href> to another host. The origin of the request does neither.
    expect(tag![1]).toBe(`${origin}/_webmcp/${BOOTSTRAP_ASSET}`);
    expect(tag![0]).toContain(`integrity="${SRI}"`);
    expect(tag![0]).toContain('crossorigin="anonymous"');
  });

  it("uses the request's origin even when [site].public_url names another host, and keeps the <link> on public_url", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const handler = createHandler(
      makeDeps(
        { site: { public_url: "https://www.example.com" }, paths: { namespace: "/_agents" } },
        { meta: { BOOTSTRAP_ASSET, BOOTSTRAP_SRI: null } },
      ),
    );

    const body = await (await call(handler, "https://staging.example.net/page")).text();

    expect(body.match(/<script[^>]*src="([^"]+)"/)![1]).toBe(`https://staging.example.net/_agents/${BOOTSTRAP_ASSET}`);
    // Discovery documents stay absolute, on the configured site URL.
    expect(body).toContain('<link rel="webmcp" href="https://www.example.com/.well-known/webmcp">');
  });

  it("is not moved by a <base href> in the page, because the src names its host", async () => {
    const page = '<!doctype html><html><head><base href="https://cdn.other.example/"></head><body><p>hi</p></body></html>';
    stubOrigin({ "https://example.com/page": () => htmlResponse(page) });
    const handler = createHandler(makeDeps({}, { meta: { BOOTSTRAP_ASSET, BOOTSTRAP_SRI: null } }));

    const body = await (await call(handler, "https://www.example.com/page")).text();

    expect(body.match(/<script[^>]*src="([^"]+)"/)![1]).toBe(`https://www.example.com/_webmcp/${BOOTSTRAP_ASSET}`);
  });
});

describe("content-addressed widget", () => {
  const WIDGET_ASSET = "widget.fedcba9876543210.js";
  const WIDGET_BODY = "/*preamble*/\nwidget();";
  /** The widget is opt-in ([features].fallback_widget defaults to false). */
  const WIDGET_ON = { features: { fallback_widget: true } };

  it("serves the current widget object from R2 as stored", async () => {
    const fetchMock = stubOrigin({});
    const { env: r2Env } = envWithObjects({ [WIDGET_ASSET]: WIDGET_BODY });
    const handler = createHandler(makeDeps(WIDGET_ON, { meta: { WIDGET_ASSET } }));

    const res = await call(handler, `https://example.com/_webmcp/${WIDGET_ASSET}`, undefined, r2Env);

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe(WIDGET_BODY);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers a stale widget hash with 404 no-store noindex without touching R2 or origin", async () => {
    const fetchMock = stubOrigin({});
    const { env: r2Env, get } = envWithObjects({ [WIDGET_ASSET]: WIDGET_BODY });
    const handler = createHandler(makeDeps(WIDGET_ON, { meta: { WIDGET_ASSET } }));

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
    const handler = createHandler(makeDeps(WIDGET_ON, { meta: { WIDGET_ASSET: null } }));

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
    const handler = createHandler(makeDeps(WIDGET_ON, { meta: { WIDGET_ASSET: null } }));

    const res = await call(handler, "https://example.com/_webmcp/health", undefined, r2Env);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { widget_asset_present: unknown }).widget_asset_present).toBeNull();
    expect(head).not.toHaveBeenCalled();
  });

  it("health reports whether the expected widget object is in R2", async () => {
    stubOrigin({});
    const present = envWithObjects({ [WIDGET_ASSET]: WIDGET_BODY });
    const absent = envWithObjects({});
    const handler = createHandler(makeDeps(WIDGET_ON, { meta: { WIDGET_ASSET } }));

    const a = await call(handler, "https://example.com/_webmcp/health", undefined, present.env);
    const b = await call(handler, "https://example.com/_webmcp/health", undefined, absent.env);

    expect(((await a.json()) as { widget_asset_present: unknown }).widget_asset_present).toBe(true);
    expect(((await b.json()) as { widget_asset_present: unknown }).widget_asset_present).toBe(false);
    expect(present.head).toHaveBeenCalledWith(WIDGET_ASSET);
  });
});

describe("proxyToOrigin redirects (llms.txt, robots.txt, agents.md and the other merge routes)", () => {
  const tokenEnv: Env = { ...env, CF_WEBMCP_DEPLOY_TOKEN: "deploy-token-x" };
  const twoHosts = {
    origin: { base_url: "https://example.com", allowed_origins: ["https://example.com", "https://cdn.example.com"] },
  };
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  function redirectTo(status: number, location: string): Response {
    return new Response(null, { status, headers: { location } });
  }

  function textResponse(body: string): Response {
    return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  /** The URL of every fetch call, in order. */
  function urlsOf(mock: ReturnType<typeof stubOrigin>): string[] {
    return mock.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : String(c[0])));
  }

  /** Neither the headers nor the (already read) body of a response may carry the deploy token. */
  function expectNoToken(res: Response, bodyText: string) {
    expect(JSON.stringify([...res.headers])).not.toContain("deploy-token-x");
    expect(bodyText).not.toContain("deploy-token-x");
  }

  describe("an origin redirect that leaves allowed_origins is relayed, not followed", () => {
    // Every route that goes through proxyToOrigin and relays an uninterpretable origin answer.
    // The /.well-known/* routes add noindex to the relay; the apex discovery files (llms.txt, robots.txt) never do.
    const relayRoutes = [
      { name: "llms.txt", path: "/llms.txt", noindex: null },
      { name: "robots.txt", path: "/robots.txt", noindex: null },
      { name: "agents.md", path: "/.well-known/agents.md", noindex: "noindex" },
      { name: "api-catalog", path: "/.well-known/api-catalog", noindex: "noindex" },
      { name: "agent-skills (merge)", path: "/.well-known/agent-skills/site/SKILL.md", noindex: "noindex" },
    ];
    const deps = () => makeDeps({ agent_skills: { mode: "merge" } });

    it.each(relayRoutes)("$name: answers the origin's 301 with the resolved Location, no body, no-store, and noindex only under /.well-known/", async ({ path, noindex }) => {
      const fetchMock = stubOrigin({
        [`https://example.com${path}`]: () => redirectTo(301, `https://www.example.com${path}`),
        [`https://www.example.com${path}`]: () => textResponse("should never be fetched"),
      });
      const handler = createHandler(deps());

      const res = await call(handler, `https://example.com${path}`, undefined, tokenEnv);

      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`https://www.example.com${path}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe(noindex);
      const body = await res.text();
      expect(body).toBe("");
      // Exactly one request, to origin; none to the other host, and the token is on that one only.
      expect(urlsOf(fetchMock)).toEqual([`https://example.com${path}`]);
      expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)["cf-webmcp-deploy-token"]).toBe("deploy-token-x");
      expectNoToken(res, body);
    });

    it("the ARD manifest in merge mode keeps serving its synthesized document (200), after one request", async () => {
      const fetchMock = stubOrigin({
        "https://example.com/.well-known/ard.json": () =>
          redirectTo(301, "https://www.example.com/.well-known/ard.json"),
      });
      const handler = createHandler(
        makeDeps(
          { features: { ai_catalog: true }, ai_catalog: { mode: "merge" } },
          { assets: { aiCatalogJson: '{"synthesized":true}' } },
        ),
      );

      const res = await call(handler, "https://example.com/.well-known/ard.json", undefined, tokenEnv);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"synthesized":true}');
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      // A redirect is not a 404: the predecessor path is not consulted.
      expect(urlsOf(fetchMock)).toEqual(["https://example.com/.well-known/ard.json"]);
    });

    it.each([301, 302, 303, 307, 308])("relays the redirect status as it came (%i)", async (status) => {
      stubOrigin({ "https://example.com/robots.txt": () => redirectTo(status, "https://www.example.com/robots.txt") });
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/robots.txt", undefined, tokenEnv);

      expect(res.status).toBe(status);
      expect(res.headers.get("location")).toBe("https://www.example.com/robots.txt");
    });

    it("resolves a protocol-relative or dotted Location to an absolute URL before relaying it", async () => {
      stubOrigin({
        "https://example.com/robots.txt": () => redirectTo(302, "//www.example.com/robots.txt?x=1"),
        "https://example.com/llms.txt": () => redirectTo(302, "https://cdn.example.org:8443/a/../llms.txt"),
      });
      const handler = createHandler(makeDeps());

      const robots = await call(handler, "https://example.com/robots.txt", undefined, tokenEnv);
      const llms = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

      expect(robots.headers.get("location")).toBe("https://www.example.com/robots.txt?x=1");
      expect(llms.headers.get("location")).toBe("https://cdn.example.org:8443/llms.txt");
    });

    it("leaves userinfo out of the relayed Location and keeps path, query and fragment", async () => {
      stubOrigin({
        "https://example.com/robots.txt": () => redirectTo(301, "https://user:pass@evil.example/x?q=1#f"),
      });
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/robots.txt", undefined, tokenEnv);

      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe("https://evil.example/x?q=1#f");
      expect(JSON.stringify([...res.headers])).not.toMatch(/user|pass/);
    });

    it("relays the status and Location of the hop that left the list, after following an allowed hop", async () => {
      const fetchMock = stubOrigin({
        "https://example.com/robots.txt": () => redirectTo(301, "https://cdn.example.com/robots.txt"),
        "https://cdn.example.com/robots.txt": () => redirectTo(307, "https://evil.example/robots.txt"),
        "https://evil.example/robots.txt": () => textResponse("should never be fetched"),
      });
      const handler = createHandler(makeDeps(twoHosts));

      const res = await call(handler, "https://example.com/robots.txt", undefined, tokenEnv);

      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toBe("https://evil.example/robots.txt");
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(urlsOf(fetchMock)).toEqual(["https://example.com/robots.txt", "https://cdn.example.com/robots.txt"]);
      expectNoToken(res, await res.text());
    });
  });

  it("follows a redirect to another allowed origin, sends the token to both, and merges the final body", async () => {
    const fetchMock = stubOrigin({
      "https://example.com/llms.txt": () => redirectTo(301, "https://cdn.example.com/llms.txt"),
      "https://cdn.example.com/llms.txt": () => textResponse("# Publisher llms.txt\n"),
    });
    const handler = createHandler(makeDeps(twoHosts));

    const res = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("# Publisher llms.txt");
    expect(body).toContain("cf-webmcp:begin");
    expect(urlsOf(fetchMock)).toEqual(["https://example.com/llms.txt", "https://cdn.example.com/llms.txt"]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe("manual");
      const headers = init?.headers as Record<string, string>;
      expect(headers["cf-webmcp-bypass"]).toBe("1");
      expect(headers["cf-webmcp-deploy-token"]).toBe("deploy-token-x");
    }
  });

  describe("failures that stay a 502 with noindex and a generic body", () => {
    // Run on agents.md: a /.well-known/* route, so the 502 carries noindex. llms.txt and robots.txt
    // answer the same 502 without it (see "llms.txt and robots.txt never carry X-Robots-Tag").
    async function expect502(res: Response, body: string) {
      expect(res.status).toBe(502);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      const text = await res.text();
      expect(text).toBe(body);
      expectNoToken(res, text);
    }

    it("more than 5 redirects", async () => {
      const routes: Record<string, Canned> = {};
      for (let i = 0; i < 6; i++) {
        routes[i === 0 ? "https://example.com/.well-known/agents.md" : `https://example.com/h${i}`] = () =>
          redirectTo(302, `/h${i + 1}`);
      }
      const fetchMock = stubOrigin(routes);
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/.well-known/agents.md", undefined, tokenEnv);

      await expect502(res, "origin redirected too many times");
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it("an unparseable Location, which is logged but not echoed", async () => {
      stubOrigin({ "https://example.com/.well-known/agents.md": () => redirectTo(302, "http://:notaport?q=secret") });
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/.well-known/agents.md", undefined, tokenEnv);

      await expect502(res, "origin returned an unusable redirect location");
      const line = errorLog.mock.calls[0]![0] as string;
      expect(line.startsWith("cf-webmcp: proxy refused an origin redirect: ")).toBe(true);
      // The log keeps the value up to its query, and no further.
      expect(line).toContain("http://:notaport");
      expect(line).not.toContain("q=secret");
    });

    it("a blob: Location whose origin looks allowed: nothing is requested for it", async () => {
      const fetchMock = stubOrigin({
        "https://example.com/.well-known/agents.md": () => redirectTo(302, "blob:https://example.com/abc?q=secret"),
      });
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/.well-known/agents.md", undefined, tokenEnv);

      await expect502(res, "origin returned an unusable redirect location");
      expect(urlsOf(fetchMock)).toEqual(["https://example.com/.well-known/agents.md"]);
    });

    it("base_url itself outside allowed_origins: nothing is sent, and only the log names the origin", async () => {
      const fetchMock = stubOrigin({});
      const handler = createHandler(
        makeDeps({ origin: { base_url: "https://other.example", allowed_origins: ["https://example.com"] } }),
      );

      const res = await call(handler, "https://example.com/.well-known/agents.md", undefined, tokenEnv);

      await expect502(res, "configured origin is not in allowed_origins");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(errorLog.mock.calls[0]![0]).toContain("https://other.example");
    });
  });

  it("still relays an origin 404 as a merge (no redirect involved)", async () => {
    stubOrigin({ "https://example.com/llms.txt": () => new Response("nope", { status: 404 }) });
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("cf-webmcp:begin");
  });

  it("fetches origin exactly once for agent-skills when origin answers 500, and relays that answer with noindex", async () => {
    const fetchMock = stubOrigin({
      "https://example.com/.well-known/agent-skills/site/SKILL.md": () => new Response("boom", { status: 500 }),
    });
    const handler = createHandler(makeDeps({ agent_skills: { mode: "merge" } }));

    const res = await call(handler, "https://example.com/.well-known/agent-skills/site/SKILL.md", undefined, tokenEnv);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe("boom");
  });
});

describe("proxyToOrigin failure handling and deadline", () => {
  const tokenEnv: Env = { ...env, CF_WEBMCP_DEPLOY_TOKEN: "deploy-token-x" };
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function abortError(): Error {
    return Object.assign(new Error("aborted"), { name: "AbortError" });
  }

  /** A fetch that never answers on its own and rejects with an AbortError when its signal aborts. */
  function stallUntilAborted(init?: RequestInit): Promise<Response> {
    return new Promise((_, reject) => {
      init!.signal!.addEventListener("abort", () => reject(abortError()));
    });
  }

  it("answers 502 with noindex and a generic body when the origin fetch rejects, and logs the detail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network connection lost.");
      }),
    );
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/.well-known/agents.md", undefined, tokenEnv);

    expect(res.status).toBe(502);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("origin request failed");
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = errorLog.mock.calls[0]![0] as string;
    expect(line).toContain("Network connection lost.");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("deploy-token-x");
  });

  it("answers 504 with noindex when the origin does not answer within the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => stallUntilAborted(init)));
    const handler = createHandler(makeDeps());

    const pending = call(handler, "https://example.com/.well-known/agents.md", undefined, tokenEnv);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(PROXY_ORIGIN_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;

    expect(res.status).toBe(504);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("origin did not answer in time");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("one deadline covers the whole chain: a stall on the second hop times out at the same moment", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        signals.push(init!.signal!);
        // The first hop answers after 4s; the second never does.
        return url === "https://example.com/robots.txt"
          ? new Promise<Response>((resolve) =>
              setTimeout(() => resolve(new Response(null, { status: 302, headers: { location: "/robots2.txt" } })), 4_000),
            )
          : stallUntilAborted(init);
      }),
    );
    const handler = createHandler(makeDeps());

    const pending = call(handler, "https://example.com/robots.txt", undefined, tokenEnv);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(signals).toHaveLength(2);
    // A fresh per-hop deadline would run until 4s + PROXY_ORIGIN_TIMEOUT_MS and still be pending here.
    await vi.advanceTimersByTimeAsync(PROXY_ORIGIN_TIMEOUT_MS - 4_000);
    expect(settled).toBe(true);
    const res = await pending;

    expect(res.status).toBe(504);
    expect(signals[0]).toBe(signals[1]);
  });

  it("leaves no timer behind and never aborts the signal after a successful answer, so a relayed body is not cut", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        signal = init!.signal!;
        return new Response("# Publisher\n", { status: 200, headers: { "content-type": "text/plain" } });
      }),
    );
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

    expect(res.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(PROXY_ORIGIN_TIMEOUT_MS * 2);
    expect(signal!.aborted).toBe(false);
  });

  it("leaves no timer behind after a refused redirect either", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 301, headers: { location: "https://www.example.com/robots.txt" } })),
    );
    const handler = createHandler(makeDeps());

    const res = await call(handler, "https://example.com/robots.txt", undefined, tokenEnv);

    expect(res.status).toBe(301);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("llms.txt and robots.txt never carry X-Robots-Tag", () => {
  // House rule: every route under /_webmcp/* or /.well-known/* emits noindex; the apex discovery files
  // /llms.txt and /robots.txt are the explicit exceptions and must never carry it, whatever the answer is:
  // a merge, a relayed redirect, a 502, a 504, or an origin answer relayed as it came.
  const tokenEnv: Env = { ...env, CF_WEBMCP_DEPLOY_TOKEN: "deploy-token-x" };
  const files = [
    { name: "llms.txt", path: "/llms.txt" },
    { name: "robots.txt", path: "/robots.txt" },
  ];

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function expectNoRobotsTag(res: Response) {
    expect([...res.headers.keys()]).not.toContain("x-robots-tag");
  }

  describe.each(files)("$name", ({ path }) => {
    const origin = `https://example.com${path}`;

    it("merged answer (origin has the file)", async () => {
      stubOrigin({
        [origin]: () => new Response("# origin\n", { status: 200, headers: { "content-type": "text/plain" } }),
      });
      const res = await call(createHandler(makeDeps()), origin, undefined, tokenEnv);

      expect(res.status).toBe(200);
      expectNoRobotsTag(res);
    });

    it("generated answer (origin has no file)", async () => {
      stubOrigin({ [origin]: () => new Response("", { status: 404 }) });
      const res = await call(createHandler(makeDeps()), origin, undefined, tokenEnv);

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("cf-webmcp:begin");
      expectNoRobotsTag(res);
    });

    it("relayed redirect that leaves allowed_origins", async () => {
      stubOrigin({
        [origin]: () => new Response(null, { status: 301, headers: { location: `https://www.example.com${path}` } }),
      });
      const res = await call(createHandler(makeDeps()), origin, undefined, tokenEnv);

      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`https://www.example.com${path}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expectNoRobotsTag(res);
    });

    it("502 when the origin fetch fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Network connection lost.");
        }),
      );
      const res = await call(createHandler(makeDeps()), origin, undefined, tokenEnv);

      expect(res.status).toBe(502);
      expect(await res.text()).toBe("origin request failed");
      expectNoRobotsTag(res);
    });

    it("502 for an unusable redirect location and for a base_url outside allowed_origins", async () => {
      stubOrigin({ [origin]: () => new Response(null, { status: 302, headers: { location: "http://:notaport" } }) });
      const unusable = await call(createHandler(makeDeps()), origin, undefined, tokenEnv);
      const offList = await call(
        createHandler(makeDeps({ origin: { base_url: "https://other.example", allowed_origins: ["https://example.com"] } })),
        origin,
        undefined,
        tokenEnv,
      );

      expect(unusable.status).toBe(502);
      expect(offList.status).toBe(502);
      expectNoRobotsTag(unusable);
      expectNoRobotsTag(offList);
    });

    it("504 when the origin does not answer in time", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
              init!.signal!.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            }),
        ),
      );
      const pending = call(createHandler(makeDeps()), origin, undefined, tokenEnv);
      await vi.advanceTimersByTimeAsync(PROXY_ORIGIN_TIMEOUT_MS);
      const res = await pending;

      expect(res.status).toBe(504);
      expect(await res.text()).toBe("origin did not answer in time");
      expectNoRobotsTag(res);
    });

    it("an origin 5xx is relayed as it came, and drops an X-Robots-Tag the origin sent itself", async () => {
      stubOrigin({
        [origin]: () =>
          new Response("boom", { status: 503, headers: { "content-type": "text/plain", "x-robots-tag": "noindex" } }),
      });
      const res = await call(createHandler(makeDeps()), origin, undefined, tokenEnv);

      expect(res.status).toBe(503);
      expect(await res.text()).toBe("boom");
      expectNoRobotsTag(res);
    });

    it("an origin answer that is not text is relayed without an X-Robots-Tag", async () => {
      stubOrigin({
        [origin]: () =>
          new Response("<html></html>", {
            status: 200,
            headers: { "content-type": "text/html", "x-robots-tag": "noindex" },
          }),
      });
      const res = await call(createHandler(makeDeps()), origin, undefined, tokenEnv);

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html");
      expect(await res.text()).toBe("<html></html>");
      expectNoRobotsTag(res);
    });
  });

  it("agents.md, a /.well-known/* route, keeps noindex on the same relay and the same failure", async () => {
    const agents = "https://example.com/.well-known/agents.md";
    stubOrigin({
      [agents]: () =>
        new Response(null, { status: 301, headers: { location: "https://www.example.com/.well-known/agents.md" } }),
    });
    const relayed = await call(createHandler(makeDeps()), agents, undefined, tokenEnv);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Network connection lost.");
      }),
    );
    const failed = await call(createHandler(makeDeps()), agents, undefined, tokenEnv);

    expect(relayed.status).toBe(301);
    expect(relayed.headers.get("x-robots-tag")).toBe("noindex");
    expect(failed.status).toBe(502);
    expect(failed.headers.get("x-robots-tag")).toBe("noindex");
  });
});

describe("the landing path is shared with MCP traffic", () => {
  // Cloudflare WebMCP Labs POSTs MCP JSON-RPC to data-mcp-url="/mcp"; an origin MCP server may live there too.
  // The rule: GET and HEAD requests get the landing page unless their Accept header asks for
  // text/event-stream; every other method goes to origin.
  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const rpcAnswer = () =>
    new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("proxies a POST to /mcp to origin with its method and body, and does not serve the landing", async () => {
    const fetchMock = stubOrigin({ "https://example.com/mcp": rpcAnswer });
    const res = await call(createHandler(makeDeps()), "https://example.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: rpcBody,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [target, init] = fetchMock.mock.calls[0]!;
    expect(target).toBe("https://example.com/mcp");
    expect((init as Request).method).toBe("POST");
    expect(await (init as Request).text()).toBe(rpcBody);
  });

  it("proxies a DELETE to /mcp to origin (MCP session termination)", async () => {
    const fetchMock = stubOrigin({ "https://example.com/mcp": () => new Response(null, { status: 204 }) });
    const res = await call(createHandler(makeDeps()), "https://example.com/mcp", { method: "DELETE" });

    expect(res.status).toBe(204);
    expect((fetchMock.mock.calls[0]![1] as Request).method).toBe("DELETE");
  });

  it.each(["application/json, text/event-stream", "text/event-stream"])(
    "proxies a GET to /mcp with Accept: %s to origin (the MCP streamable HTTP GET)",
    async (accept) => {
      const fetchMock = stubOrigin({ "https://example.com/mcp": rpcAnswer });
      const res = await call(createHandler(makeDeps()), "https://example.com/mcp", { headers: { accept } });

      expect(res.headers.get("content-type")).toBe("application/json");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["text/html", "application/json", "application/json, text/plain, */*"])(
    "serves the landing for a GET with Accept: %s, without asking origin",
    async (accept) => {
      const fetchMock = stubOrigin({});
      const res = await call(createHandler(makeDeps()), "https://example.com/mcp", { headers: { accept } });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("landing");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("serves the landing for a GET with no Accept header and for HEAD", async () => {
    const fetchMock = stubOrigin({});
    const handler = createHandler(makeDeps());

    const get = await call(handler, "https://example.com/mcp");
    const head = await call(handler, "https://example.com/mcp", { method: "HEAD" });

    expect(await get.text()).toContain("landing");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toContain("text/html");
    expect(await head.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe("caches: the answer depends on Accept, so the landing and its redirect say so", () => {
    // A browser that cached the landing (max-age=300) must not answer a later
    // fetch("/mcp", { headers: { accept: "text/event-stream" } }) from that entry, and a
    // cached 308 must not send every later GET /mcp to /mcp/.
    const varyTokens = (res: Response) =>
      (res.headers.get("vary") ?? "").split(",").map((t) => t.trim().toLowerCase());

    it("sends Vary: Accept on the landing, GET and HEAD alike", async () => {
      stubOrigin({});
      const handler = createHandler(makeDeps());

      const get = await call(handler, "https://example.com/mcp", { headers: { accept: "text/html" } });
      const head = await call(handler, "https://example.com/mcp", { method: "HEAD" });

      expect(varyTokens(get)).toContain("accept");
      expect(varyTokens(head)).toContain("accept");
      expect(head.headers.get("cache-control")).toBe(get.headers.get("cache-control"));
    });

    it("sends Vary: Accept and Cache-Control: no-store on the 308 from /mcp to /mcp/, GET and HEAD alike", async () => {
      stubOrigin({});
      const handler = createHandler(makeDeps({ webmcp_landing: { path: "/mcp/" } }));

      for (const method of ["GET", "HEAD"]) {
        const res = await call(handler, "https://example.com/mcp", { method, headers: { accept: "text/html" } });
        expect(res.status).toBe(308);
        expect(res.headers.get("location")).toBe("/mcp/");
        expect(varyTokens(res), `${method} /mcp`).toContain("accept");
        expect(res.headers.get("cache-control"), `${method} /mcp`).toBe("no-store");
      }
    });
  });

  describe("directory-form landing path", () => {
    const dirForm = { webmcp_landing: { path: "/mcp/" } };

    it("redirects a browser GET on /mcp to /mcp/", async () => {
      const fetchMock = stubOrigin({});
      const res = await call(createHandler(makeDeps(dirForm)), "https://example.com/mcp", {
        headers: { accept: "text/html" },
      });

      expect(res.status).toBe(308);
      expect(res.headers.get("location")).toBe("/mcp/");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("redirects a JSON GET on /mcp to /mcp/ as well (axios-style Accept)", async () => {
      const fetchMock = stubOrigin({});
      const res = await call(createHandler(makeDeps(dirForm)), "https://example.com/mcp", {
        headers: { accept: "application/json, text/plain, */*" },
      });

      expect(res.status).toBe(308);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends a POST on /mcp (no trailing slash) to origin, not to a redirect", async () => {
      const fetchMock = stubOrigin({ "https://example.com/mcp": rpcAnswer });
      const res = await call(createHandler(makeDeps(dirForm)), "https://example.com/mcp", {
        method: "POST",
        body: rpcBody,
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]![1] as Request).method).toBe("POST");
    });

    it("sends a text/event-stream GET on /mcp to origin, not to a redirect", async () => {
      stubOrigin({ "https://example.com/mcp": rpcAnswer });
      const res = await call(createHandler(makeDeps(dirForm)), "https://example.com/mcp", {
        headers: { accept: "application/json, text/event-stream" },
      });

      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
    });
  });
});

describe("passthrough mode: origin owns the file", () => {
  const cases: Array<{ name: string; path: string; override: ConfigOverrides }> = [
    { name: "llms.txt", path: "/llms.txt", override: { llms_txt: { mode: "passthrough" } } },
    { name: "robots.txt", path: "/robots.txt", override: { robots_txt: { mode: "passthrough" } } },
    { name: "agents.md", path: "/.well-known/agents.md", override: { agents_md: { mode: "passthrough" } } },
    { name: "the /AGENTS.md alias of agents.md", path: "/AGENTS.md", override: { agents_md: { mode: "passthrough" } } },
  ];

  it.each(cases)(
    "$name is proxied: origin's own response, our Link header, nothing merged or added",
    async ({ path, override }) => {
      const fetchMock = stubOrigin({
        [`https://example.com${path}`]: () =>
          new Response("the origin file\n", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }),
      });
      const res = await call(createHandler(makeDeps(override)), `https://example.com${path}`);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("the origin file\n");
      expect(res.headers.get("link")).toContain('rel="webmcp"');
      // The Worker does not serve this path, so it adds no noindex to the origin response.
      expect(res.headers.get("x-robots-tag")).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect((fetchMock.mock.calls[0]![1] as Request).redirect).toBe("manual");
    },
  );

  it.each(cases)("$name: an origin 404 stays a 404 (no generated fallback)", async ({ path, override }) => {
    stubOrigin({ [`https://example.com${path}`]: () => new Response("not here", { status: 404 }) });
    const res = await call(createHandler(makeDeps(override)), `https://example.com${path}`);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not here");
  });

  it("an agents.md alias is relayed from origin, not redirected to the canonical path", async () => {
    stubOrigin({
      "https://example.com/agents.md": () =>
        new Response("# mine\n", { status: 200, headers: { "content-type": "text/markdown" } }),
    });
    const res = await call(
      createHandler(makeDeps({ agents_md: { mode: "passthrough" } })),
      "https://example.com/agents.md",
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toBe("# mine\n");
  });
});

describe("the health token", () => {
  const healthUrl = "https://example.com/_webmcp/health";
  const bearer = (token: string): RequestInit => ({ headers: { authorization: `Bearer ${token}` } });
  const envWithSecret = (secret?: string): Env => ({ ...env, CF_WEBMCP_HEALTH_TOKEN: secret });

  it("with public = false and only the CF_WEBMCP_HEALTH_TOKEN secret, answers 401 without auth and 200 with the secret", async () => {
    const handler = createHandler(makeDeps({ health: { public: false } }));
    const secretEnv = envWithSecret("from-secret");

    expect((await call(handler, healthUrl, undefined, secretEnv)).status).toBe(401);
    expect((await call(handler, healthUrl, bearer("wrong"), secretEnv)).status).toBe(401);
    const ok = await call(handler, healthUrl, bearer("from-secret"), secretEnv);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("when both are set, the secret wins and the TOML token is rejected", async () => {
    const handler = createHandler(makeDeps({ health: { public: false, token: "from-toml" } }));
    const secretEnv = envWithSecret("from-secret");

    expect((await call(handler, healthUrl, bearer("from-toml"), secretEnv)).status).toBe(401);
    expect((await call(handler, healthUrl, bearer("from-secret"), secretEnv)).status).toBe(200);
  });

  it("the TOML token still works when no secret is set", async () => {
    const handler = createHandler(makeDeps({ health: { public: false, token: "from-toml" } }));

    expect((await call(handler, healthUrl, bearer("from-toml"))).status).toBe(200);
    expect((await call(handler, healthUrl)).status).toBe(401);
  });

  it("with public = false and neither token set, answers 404", async () => {
    const handler = createHandler(makeDeps({ health: { public: false } }));

    expect((await call(handler, healthUrl)).status).toBe(404);
    expect((await call(handler, healthUrl, undefined, envWithSecret(""))).status).toBe(404);
  });
});

describe("llms.txt and robots.txt configured under a protected prefix", () => {
  // The apex exception is for the files at the apex. Under the namespace or /.well-known/ the prefix
  // rule wins: the merged answer, a relayed redirect, a 502 and an origin 5xx all carry noindex.
  const tokenEnv: Env = { ...env, CF_WEBMCP_DEPLOY_TOKEN: "deploy-token-x" };
  const cases: Array<{ name: string; path: string; override: ConfigOverrides }> = [
    { name: "llms.txt under the namespace", path: "/_webmcp/llms.txt", override: { llms_txt: { path: "/_webmcp/llms.txt" } } },
    { name: "robots.txt under the namespace", path: "/_webmcp/robots.txt", override: { robots_txt: { path: "/_webmcp/robots.txt" } } },
    { name: "llms.txt under /.well-known/", path: "/.well-known/llms.txt", override: { llms_txt: { path: "/.well-known/llms.txt" } } },
    { name: "robots.txt under /.well-known/", path: "/.well-known/robots.txt", override: { robots_txt: { path: "/.well-known/robots.txt" } } },
    {
      name: "llms.txt under a custom namespace",
      path: "/_x/llms.txt",
      override: { paths: { namespace: "/_x" }, llms_txt: { path: "/_x/llms.txt" } },
    },
  ];

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  describe.each(cases)("$name", ({ path, override }) => {
    const origin = `https://example.com${path}`;

    it("merged answer carries noindex", async () => {
      stubOrigin({ [origin]: () => new Response("# origin\n", { status: 200, headers: { "content-type": "text/plain" } }) });
      const res = await call(createHandler(makeDeps(override)), origin, undefined, tokenEnv);

      expect(res.status).toBe(200);
      expect(await res.text()).toContain("cf-webmcp:begin");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    });

    it("relayed redirect carries noindex", async () => {
      stubOrigin({ [origin]: () => new Response(null, { status: 301, headers: { location: `https://www.example.com${path}` } }) });
      const res = await call(createHandler(makeDeps(override)), origin, undefined, tokenEnv);

      expect(res.status).toBe(301);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    });

    it("502 carries noindex", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Network connection lost.");
        }),
      );
      const res = await call(createHandler(makeDeps(override)), origin, undefined, tokenEnv);

      expect(res.status).toBe(502);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    });

    it("an origin 5xx without any X-Robots-Tag of its own gets noindex", async () => {
      stubOrigin({ [origin]: () => new Response("boom", { status: 503, headers: { "content-type": "text/plain" } }) });
      const res = await call(createHandler(makeDeps(override)), origin, undefined, tokenEnv);

      expect(res.status).toBe(503);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
    });
  });
});

describe("the /.well-known/ merge routes keep noindex on every relay and failure", () => {
  // proxyToOrigin's own relays and failures carry noindex, and each of these routes passes an answer it
  // cannot merge on. The ARD manifest never relays a redirect or an error: it answers with its generated document.
  const tokenEnv: Env = { ...env, CF_WEBMCP_DEPLOY_TOKEN: "deploy-token-x" };
  const GENERATED = '{"generated":true}';
  const routes: Array<{ name: string; path: string; override: ConfigOverrides; generated: boolean }> = [
    { name: "api-catalog", path: "/.well-known/api-catalog", override: {}, generated: false },
    {
      name: "agent-skills (merge)",
      path: "/.well-known/agent-skills/site/SKILL.md",
      override: { agent_skills: { mode: "merge" } },
      generated: false,
    },
    {
      name: "ARD manifest (merge)",
      path: "/.well-known/ard.json",
      override: { features: { ai_catalog: true }, ai_catalog: { mode: "merge" } },
      generated: true,
    },
  ];
  const handlerFor = (override: ConfigOverrides) => createHandler(makeDeps(override, { assets: { aiCatalogJson: GENERATED } }));

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** What each route answers: its own status for a relayed or failed answer, the generated document for the ARD manifest. */
  async function expectAnswer(res: Response, route: { generated: boolean }, status: number) {
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    if (route.generated) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(await res.text()).toBe(GENERATED);
    } else {
      expect(res.status).toBe(status);
    }
  }

  describe.each(routes)("$name", (route) => {
    const origin = `https://example.com${route.path}`;

    it("relayed redirect that left allowed_origins", async () => {
      stubOrigin({
        [origin]: () => new Response(null, { status: 301, headers: { location: `https://www.example.com${route.path}` } }),
      });
      const res = await call(handlerFor(route.override), origin, undefined, tokenEnv);

      await expectAnswer(res, route, 301);
      if (!route.generated) expect(res.headers.get("location")).toBe(`https://www.example.com${route.path}`);
    });

    it("502 when the origin fetch fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new TypeError("Network connection lost.");
        }),
      );
      const res = await call(handlerFor(route.override), origin, undefined, tokenEnv);

      await expectAnswer(res, route, 502);
    });

    it("504 when the origin does not answer in time", async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_url: string, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
              init!.signal!.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            }),
        ),
      );
      const pending = call(handlerFor(route.override), origin, undefined, tokenEnv);
      await vi.advanceTimersByTimeAsync(PROXY_ORIGIN_TIMEOUT_MS);
      const res = await pending;

      await expectAnswer(res, route, 504);
    });

    it("an origin 5xx", async () => {
      stubOrigin({ [origin]: () => new Response("boom", { status: 503, headers: { "content-type": "text/plain" } }) });
      const res = await call(handlerFor(route.override), origin, undefined, tokenEnv);

      await expectAnswer(res, route, 503);
      if (!route.generated) expect(await res.text()).toBe("boom");
    });

    it("an origin 5xx that sends a different X-Robots-Tag is still marked noindex", async () => {
      stubOrigin({
        [origin]: () =>
          new Response("boom", { status: 503, headers: { "content-type": "text/plain", "x-robots-tag": "all" } }),
      });
      const res = await call(handlerFor(route.override), origin, undefined, tokenEnv);

      await expectAnswer(res, route, 503);
    });
  });

  it("the ARD manifest (merge) relays a 200 that is not JSON, with noindex", async () => {
    const origin = "https://example.com/.well-known/ard.json";
    stubOrigin({ [origin]: () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) });
    const res = await call(
      handlerFor({ features: { ai_catalog: true }, ai_catalog: { mode: "merge" } }),
      origin,
      undefined,
      tokenEnv,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<html></html>");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
  });
});

describe("ARD v0.91: /.well-known/ard.json, the 301 from ai-catalog.json and rel=ard", () => {
  const ARD = "https://example.com/.well-known/ard.json";
  const PREDECESSOR = "https://example.com/.well-known/ai-catalog.json";
  const GENERATED = JSON.stringify({
    host: { displayName: "Example", identifier: "did:web:example.com" },
    entries: [{ identifier: "urn:air:example.com:skill:example", displayName: "Example", type: "application/ai-skill+md", url: "https://example.com/.well-known/agent-skills/site/SKILL.md" }],
  });
  const OTHER = { identifier: "urn:air:example.com:agent:other", displayName: "Other", type: "application/a2a-agent-card+json", url: "https://example.com/a.json" };
  const handlerFor = (override: ConfigOverrides) => createHandler(makeDeps(override, { assets: { aiCatalogJson: GENERATED } }));
  const jsonDoc = (doc: unknown, ct = "application/json") =>
    new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": ct } });
  const urlsOf = (mock: ReturnType<typeof stubOrigin>): string[] =>
    mock.mock.calls.map((c) => (typeof c[0] === "string" ? c[0] : String(c[0])));

  it.each(["synthesize", "merge"] as const)("301s /.well-known/ai-catalog.json to /.well-known/ard.json with noindex (%s)", async (mode) => {
    const fetchMock = stubOrigin({});
    const res = await call(handlerFor({ features: { ai_catalog: true }, ai_catalog: { mode } }), PREDECESSOR);

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/.well-known/ard.json");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.text()).toBe("");
    // Claimed, not proxied: origin is not asked, even in merge mode.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves ard.json without specVersion, as application/json with CORS and noindex", async () => {
    stubOrigin({});
    const res = await call(handlerFor({ features: { ai_catalog: true } }), ARD);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    const doc = JSON.parse(await res.text());
    expect(doc).not.toHaveProperty("specVersion");
    expect(Object.keys(doc).sort()).toEqual(["entries", "host"]);
  });

  it("leaves both paths to origin when the feature is off", async () => {
    stubOrigin({ [PREDECESSOR]: () => jsonDoc({ entries: [] }), [ARD]: () => jsonDoc({ entries: [OTHER] }) });
    const handler = handlerFor({});
    expect((await call(handler, PREDECESSOR)).status).toBe(200);
    const res = await call(handler, ARD);
    expect(JSON.parse(await res.text()).entries).toEqual([OTHER]);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("advertises rel=\"ard\" at the canonical URL in the Link header and the <link> tag, and no rel=\"ai-catalog\"", async () => {
    stubOrigin({ "https://example.com/page": () => htmlResponse() });
    const res = await call(handlerFor({ features: { ai_catalog: true } }), "https://example.com/page");

    const link = res.headers.get("link") ?? "";
    expect(link).toContain('<https://example.com/.well-known/ard.json>; rel="ard"');
    expect(link).not.toContain('rel="ai-catalog"');
    expect(link).not.toContain("ai-catalog.json");
    const body = await res.text();
    expect(body).toContain('<link rel="ard" href="https://example.com/.well-known/ard.json">');
    expect(body).not.toContain('rel="ai-catalog"');
  });

  it("merge: falls back to origin's predecessor path on a 404 and merges that document", async () => {
    const fetchMock = stubOrigin({
      [ARD]: () => new Response("not found", { status: 404 }),
      [PREDECESSOR]: () => jsonDoc({ host: { displayName: "Origin" }, entries: [OTHER] }, "application/ai-catalog+json"),
    });
    const res = await call(handlerFor({ features: { ai_catalog: true }, ai_catalog: { mode: "merge" } }), ARD);

    expect(urlsOf(fetchMock)).toEqual([ARD, PREDECESSOR]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const doc = JSON.parse(await res.text());
    expect(doc.host).toEqual({ displayName: "Origin" });
    expect(doc.entries.map((e: { identifier: string }) => e.identifier)).toEqual([
      OTHER.identifier,
      "urn:air:example.com:skill:example",
    ]);
  });

  it("merge: relays an origin document that fails the structural check unchanged, with noindex", async () => {
    const invalid = JSON.stringify({ specVersion: "1.0", entries: [{ displayName: "no identifier" }] });
    stubOrigin({ [ARD]: () => new Response(invalid, { status: 200, headers: { "content-type": "application/json" } }) });
    const res = await call(handlerFor({ features: { ai_catalog: true }, ai_catalog: { mode: "merge" } }), ARD);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(await res.text()).toBe(invalid);
  });
});

describe("Origin-Trial headers", () => {
  // Chrome ships WebMCP as an origin trial. The token goes in an Origin-Trial response header on the
  // top-level HTML document: proxied 200 text/html responses and the landing page, nothing else.
  const T1 = makeOriginTrialToken({ feature: "WebMCP" });
  const T2 = makeOriginTrialToken({ feature: "WebMCP", expiry: expiryInDays(200) });
  const withTokens = (extra: ConfigOverrides = {}) => makeDeps({ origin_trial: { tokens: [T1, T2] }, ...extra });

  /** The Origin-Trial values on a response, however the runtime joined them. */
  const trialTokens = (res: Response) =>
    (res.headers.get("origin-trial") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "");

  const page = "https://example.com/page";

  function htmlWith(contentType: string, body = HTML, status = 200): Response {
    return new Response(body, { status, headers: { "content-type": contentType } });
  }

  describe("on proxied HTML", () => {
    it("sends one header per token on a 200 text/html page, and still injects", async () => {
      stubOrigin({ [page]: () => htmlResponse() });
      const res = await call(createHandler(withTokens()), page);

      expect(res.status).toBe(200);
      expect(trialTokens(res)).toEqual([T1, T2]);
      expect(res.headers.get("origin-trial")).toBe(`${T1}, ${T2}`);
      expect(res.headers.get("link")).toContain('rel="webmcp"');
      expect(await res.text()).toContain("/_webmcp/bootstrap.test.js");
    });

    it("sends nothing when no token is configured", async () => {
      stubOrigin({ [page]: () => htmlResponse() });
      const res = await call(createHandler(makeDeps()), page);

      expect(res.headers.has("origin-trial")).toBe(false);
    });

    it.each(["text/html", "TEXT/HTML; Charset=UTF-8", "text/html;charset=utf-8", "text/html ; charset=utf-8"])(
      "recognises the content type %j",
      async (contentType) => {
        stubOrigin({ [page]: () => htmlWith(contentType) });
        const res = await call(createHandler(withTokens()), page);

        expect(trialTokens(res)).toEqual([T1, T2]);
      },
    );

    it("sends the headers on a HEAD request to an HTML page", async () => {
      stubOrigin({ [page]: () => new Response(null, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }) });
      const res = await call(createHandler(withTokens()), page, { method: "HEAD" });

      expect(res.status).toBe(200);
      expect(trialTokens(res)).toEqual([T1, T2]);
    });

    it("sends the headers when inject_html is off, and leaves the body alone", async () => {
      stubOrigin({ [page]: () => htmlResponse() });
      const res = await call(createHandler(withTokens({ features: { inject_html: false } })), page);

      expect(trialTokens(res)).toEqual([T1, T2]);
      expect(await res.text()).toBe(HTML);
    });

    it("sends the headers when the page is not UTF-8 and so is not injected", async () => {
      stubOrigin({ [page]: () => htmlWith("text/html; charset=iso-8859-1") });
      const res = await call(createHandler(withTokens()), page);

      expect(trialTokens(res)).toEqual([T1, T2]);
      expect(await res.text()).toBe(HTML);
    });

    it("sends the headers on a path in [injection].exclude_paths", async () => {
      stubOrigin({ [page]: () => htmlResponse() });
      const res = await call(createHandler(withTokens({ injection: { exclude_paths: ["/page"] } })), page);

      expect(trialTokens(res)).toEqual([T1, T2]);
      expect(await res.text()).toBe(HTML);
    });

    it("sends the headers on an HTML fragment that gets no injection", async () => {
      stubOrigin({ [page]: () => htmlWith("text/html; charset=utf-8", "<p>just a fragment</p>") });
      const res = await call(createHandler(withTokens()), page);

      expect(trialTokens(res)).toEqual([T1, T2]);
      expect(await res.text()).toBe("<p>just a fragment</p>");
    });

    it("sends the headers independently of [features].link_header", async () => {
      stubOrigin({ [page]: () => htmlResponse() });
      const res = await call(createHandler(withTokens({ features: { link_header: false } })), page);

      expect(trialTokens(res)).toEqual([T1, T2]);
      expect(res.headers.has("link")).toBe(false);
    });

    it("keeps an Origin-Trial header the origin sent and appends ours", async () => {
      stubOrigin({
        [page]: () =>
          new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "origin-trial": "originToken" } }),
      });
      const res = await call(createHandler(withTokens()), page);

      expect(trialTokens(res)).toEqual(["originToken", T1, T2]);
    });

    it("does not repeat a token the origin already sent", async () => {
      stubOrigin({
        [page]: () =>
          new Response(HTML, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "origin-trial": T1 } }),
      });
      const res = await call(createHandler(withTokens()), page);

      expect(trialTokens(res)).toEqual([T1, T2]);
    });

    it.each(["application/json", "image/png", "text/plain", "application/xhtml+xml", "text/html-fragment"])(
      "sends nothing on a 200 with content type %j",
      async (contentType) => {
        stubOrigin({ [page]: () => new Response("x", { status: 200, headers: { "content-type": contentType } }) });
        const res = await call(createHandler(withTokens()), page);

        expect(res.headers.has("origin-trial")).toBe(false);
      },
    );

    it.each([201, 203, 204, 206, 301, 302, 304, 308, 400, 403, 404, 410, 500, 502, 503])(
      "sends nothing on a text/html response with status %i",
      async (status) => {
        const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
        if (status >= 300 && status < 400) headers["location"] = "https://example.com/elsewhere";
        const hasBody = status !== 204 && status !== 304 && !(status >= 300 && status < 400);
        stubOrigin({ [page]: () => new Response(hasBody ? HTML : null, { status, headers }) });
        const res = await call(createHandler(withTokens()), page);

        expect(res.status).toBe(status);
        expect(res.headers.has("origin-trial")).toBe(false);
      },
    );

    it("sends the headers on an HTML 200 that answers a POST, as the injection does", async () => {
      // The rule is about the response, not the method: the answer to a form POST is a top-level document too.
      stubOrigin({ [page]: () => htmlResponse() });
      const res = await call(createHandler(withTokens()), page, { method: "POST", body: "a=b" });

      expect(trialTokens(res)).toEqual([T1, T2]);
    });
  });

  describe("on a 304 for an HTML navigation", () => {
    // Chrome merges the headers of a 304 into the page it cached (HttpResponseHeaders::Update) and
    // Origin-Trial is not among the headers it keeps from the old copy. So a 304 that carries the
    // current tokens fixes a cached page that predates the first deploy, or holds a rotated-out token.
    const notModified = (headers: Record<string, string> = {}) => () =>
      new Response(null, { status: 304, headers: { etag: '"v1"', ...headers } });
    const navigate = (headers: Record<string, string>, method = "GET") => ({ method, headers });

    it.each(["document", "iframe", "frame", "Document", " IFRAME "])(
      "sends the headers on a 304 for Sec-Fetch-Dest: %j",
      async (dest) => {
        stubOrigin({ [page]: notModified() });
        const res = await call(createHandler(withTokens()), page, navigate({ "sec-fetch-dest": dest }));

        expect(res.status).toBe(304);
        expect(trialTokens(res)).toEqual([T1, T2]);
      },
    );

    it.each([
      "text/html",
      "TEXT/HTML",
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8",
      "application/xhtml+xml, text/html;q=0.9",
    ])("sends the headers on a 304 for Accept: %s", async (accept) => {
      stubOrigin({ [page]: notModified() });
      const res = await call(createHandler(withTokens()), page, navigate({ accept }));

      expect(res.status).toBe(304);
      expect(trialTokens(res)).toEqual([T1, T2]);
    });

    it("sends the headers on a 304 answering a HEAD navigation", async () => {
      stubOrigin({ [page]: notModified() });
      const res = await call(createHandler(withTokens()), page, navigate({ "sec-fetch-dest": "document" }, "HEAD"));

      expect(res.status).toBe(304);
      expect(trialTokens(res)).toEqual([T1, T2]);
    });

    it.each([
      ["Accept: image/avif,image/*,*/*;q=0.8", { accept: "image/avif,image/*,*/*;q=0.8" }],
      ["Accept: */*", { accept: "*/*" }],
      ["Accept: text/css,*/*;q=0.1", { accept: "text/css,*/*;q=0.1" }],
      ["Accept: application/json", { accept: "application/json" }],
      ["Sec-Fetch-Dest: image", { "sec-fetch-dest": "image" }],
      ["Sec-Fetch-Dest: script", { "sec-fetch-dest": "script" }],
      ["Sec-Fetch-Dest: style", { "sec-fetch-dest": "style" }],
      ["Sec-Fetch-Dest: empty", { "sec-fetch-dest": "empty" }],
      ["Sec-Fetch-Dest: worker", { "sec-fetch-dest": "worker" }],
      ["no Accept and no Sec-Fetch-Dest", {}],
    ] as Array<[string, Record<string, string>]>)("sends nothing on a 304 for %s", async (_label, headers) => {
      stubOrigin({ [page]: notModified() });
      const res = await call(createHandler(withTokens()), page, navigate(headers));

      expect(res.status).toBe(304);
      expect(res.headers.has("origin-trial")).toBe(false);
    });

    it.each(["POST", "PUT", "DELETE", "PATCH"])("sends nothing on a 304 for a %s, whatever it accepts", async (method) => {
      stubOrigin({ [page]: notModified() });
      const res = await call(
        createHandler(withTokens()),
        page,
        navigate({ "sec-fetch-dest": "document", accept: "text/html" }, method),
      );

      expect(res.status).toBe(304);
      expect(res.headers.has("origin-trial")).toBe(false);
    });

    it("does not repeat a token the origin already sent on the 304", async () => {
      stubOrigin({ [page]: notModified({ "origin-trial": T1 }) });
      const res = await call(createHandler(withTokens()), page, navigate({ "sec-fetch-dest": "document" }));

      expect(trialTokens(res)).toEqual([T1, T2]);
    });

    it("does not repeat a token the origin sent as a quoted string", async () => {
      stubOrigin({ [page]: notModified({ "origin-trial": `"${T1}"` }) });
      const res = await call(createHandler(withTokens()), page, navigate({ "sec-fetch-dest": "document" }));

      expect(trialTokens(res).map((v) => v.replace(/^"|"$/g, ""))).toEqual([T1, T2]);
      expect((res.headers.get("origin-trial") ?? "").split(T1)).toHaveLength(2);
    });

    it("keeps a token the origin sent on the 304 and appends ours", async () => {
      stubOrigin({ [page]: notModified({ "origin-trial": "originToken" }) });
      const res = await call(createHandler(withTokens()), page, navigate({ "sec-fetch-dest": "document" }));

      expect(trialTokens(res)).toEqual(["originToken", T1, T2]);
    });

    it("sends the headers when inject_html is off", async () => {
      stubOrigin({ [page]: notModified() });
      const res = await call(
        createHandler(withTokens({ features: { inject_html: false } })),
        page,
        navigate({ "sec-fetch-dest": "document" }),
      );

      expect(trialTokens(res)).toEqual([T1, T2]);
    });

    it("sends nothing without tokens", async () => {
      stubOrigin({ [page]: notModified() });
      const res = await call(createHandler(makeDeps()), page, navigate({ "sec-fetch-dest": "document" }));

      expect(res.status).toBe(304);
      expect(res.headers.has("origin-trial")).toBe(false);
    });

    it("keeps adding the Link header to a 304, as it always did", async () => {
      stubOrigin({ [page]: notModified() });
      const handler = createHandler(withTokens());

      const navigation = await call(handler, page, navigate({ "sec-fetch-dest": "document" }));
      const subresource = await call(handler, page, navigate({ "sec-fetch-dest": "image" }));

      expect(navigation.headers.get("link")).toContain('rel="webmcp"');
      expect(subresource.headers.get("link")).toContain('rel="webmcp"');
    });

    it("sends only the tokens on a 304 when link_header is off", async () => {
      stubOrigin({ [page]: notModified() });
      const res = await call(
        createHandler(withTokens({ features: { link_header: false } })),
        page,
        navigate({ "sec-fetch-dest": "document" }),
      );

      expect(trialTokens(res)).toEqual([T1, T2]);
      expect(res.headers.has("link")).toBe(false);
    });

    it.each([206, 301, 302, 307, 308, 400, 404, 410, 500, 503])(
      "does not extend the rule to a %i, even for a document navigation",
      async (status) => {
        const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" };
        if (status >= 300 && status < 400) headers["location"] = "https://example.com/elsewhere";
        const hasBody = !(status >= 300 && status < 400);
        stubOrigin({ [page]: () => new Response(hasBody ? HTML : null, { status, headers }) });
        const res = await call(
          createHandler(withTokens()),
          page,
          navigate({ "sec-fetch-dest": "document", accept: "text/html" }),
        );

        expect(res.status).toBe(status);
        expect(res.headers.has("origin-trial")).toBe(false);
      },
    );

    it("does not send the headers on a 200 that is not HTML, even for a document navigation", async () => {
      stubOrigin({ [page]: () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }) });
      const res = await call(
        createHandler(withTokens()),
        page,
        navigate({ "sec-fetch-dest": "document", accept: "text/html" }),
      );

      expect(res.headers.has("origin-trial")).toBe(false);
    });
  });

  describe("on the landing page", () => {
    it("sends the headers on GET and HEAD", async () => {
      const fetchMock = stubOrigin({});
      const handler = createHandler(withTokens());

      const get = await call(handler, "https://example.com/mcp");
      const head = await call(handler, "https://example.com/mcp", { method: "HEAD" });

      expect(get.status).toBe(200);
      expect(trialTokens(get)).toEqual([T1, T2]);
      expect(head.status).toBe(200);
      expect(trialTokens(head)).toEqual([T1, T2]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("sends nothing without tokens", async () => {
      stubOrigin({});
      const res = await call(createHandler(makeDeps()), "https://example.com/mcp");

      expect(res.headers.has("origin-trial")).toBe(false);
    });

    it("sends nothing on the 308 from /mcp to /mcp/", async () => {
      stubOrigin({});
      const handler = createHandler(withTokens({ webmcp_landing: { path: "/mcp/" } }));

      for (const method of ["GET", "HEAD"]) {
        const redirect = await call(handler, "https://example.com/mcp", { method });
        expect(redirect.status).toBe(308);
        expect(redirect.headers.has("origin-trial"), method).toBe(false);
      }
      const landing = await call(handler, "https://example.com/mcp/");
      expect(trialTokens(landing)).toEqual([T1, T2]);
    });
  });

  describe("never on the routes cf-webmcp answers itself", () => {
    it("sends nothing on the manifest, the bootstrap, a missing asset or the health check", async () => {
      stubOrigin({});
      const handler = createHandler(withTokens());

      for (const path of [
        "/.well-known/webmcp",
        "/_webmcp/bootstrap.test.js",
        "/_webmcp/bootstrap.nope.js",
        "/_webmcp/health",
      ]) {
        const res = await call(handler, `https://example.com${path}`);
        expect(res.headers.has("origin-trial"), path).toBe(false);
      }
    });
  });

  describe("/_webmcp/health", () => {
    it("lists the trials, computed from the configured tokens", async () => {
      stubOrigin({});
      const expiry = expiryInDays(200);
      const token = makeOriginTrialToken({ feature: "WebMCP", expiry });
      const res = await call(createHandler(makeDeps({ origin_trial: { tokens: [token] } })), "https://example.com/_webmcp/health");

      const body = (await res.json()) as { origin_trials: unknown };
      expect(body.origin_trials).toEqual([
        { feature: "WebMCP", expires_at: new Date(expiry * 1000).toISOString(), expired: false },
      ]);
    });
  });
});

/** The strong ETag of a body: its sha256, first 16 hex, quoted. */
async function bodyTag(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `"${hex.slice(0, 16)}"`;
}

describe("body ETags on the documents the Worker generates", () => {
  const meta = {
    CONFIG_HASH: "cafe0123",
    MANIFEST_ETAG: '"1111111111111111"',
    LANDING_ETAG: '"2222222222222222"',
    ARD_ETAG: '"3333333333333333"',
  };
  const ARD = "https://example.com/.well-known/ard.json";
  const GENERATED = JSON.stringify({ host: { displayName: "Example", identifier: "did:web:example.com" }, entries: [] });
  const handlerFor = (override: ConfigOverrides = {}) =>
    createHandler(makeDeps(override, { assets: { aiCatalogJson: GENERATED }, meta }));

  it.each(["GET", "HEAD"])("tags the manifest with the hash of its body, not the config hash (%s)", async (method) => {
    stubOrigin({});
    const res = await call(handlerFor(), "https://example.com/.well-known/webmcp", { method });

    expect(res.headers.get("etag")).toBe(meta.MANIFEST_ETAG);
    expect(res.headers.get("etag")).not.toContain(meta.CONFIG_HASH);
  });

  it.each(["GET", "HEAD"])("tags the landing with the hash of its body, not the config hash (%s)", async (method) => {
    stubOrigin({});
    const res = await call(handlerFor(), "https://example.com/mcp", { method });

    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(meta.LANDING_ETAG);
  });

  it("tags the synthesized ARD manifest with the hash of the generated body", async () => {
    stubOrigin({});
    const res = await call(handlerFor({ features: { ai_catalog: true } }), ARD);

    expect(await res.text()).toBe(GENERATED);
    expect(res.headers.get("etag")).toBe(meta.ARD_ETAG);
  });

  it("tags the generated ARD manifest that stands in for origin in merge mode", async () => {
    stubOrigin({ [ARD]: () => new Response("no", { status: 404 }), "https://example.com/.well-known/ai-catalog.json": () => new Response("no", { status: 404 }) });
    const res = await call(handlerFor({ features: { ai_catalog: true }, ai_catalog: { mode: "merge" } }), ARD);

    expect(await res.text()).toBe(GENERATED);
    expect(res.headers.get("etag")).toBe(meta.ARD_ETAG);
  });

  it("tags a merged ARD manifest with the hash of the merged body, computed per request", async () => {
    const other = { identifier: "urn:air:example.com:agent:other", displayName: "Other", type: "application/a2a-agent-card+json", url: "https://example.com/a.json" };
    stubOrigin({
      [ARD]: () =>
        new Response(JSON.stringify({ entries: [other] }), {
          status: 200,
          headers: { "content-type": "application/json", etag: '"origin-tag"', "last-modified": "Mon, 05 Oct 2026 08:00:00 GMT" },
        }),
    });
    const res = await call(handlerFor({ features: { ai_catalog: true }, ai_catalog: { mode: "merge" } }), ARD);

    const body = await res.text();
    expect(JSON.parse(body).entries).toEqual([other]);
    expect(res.headers.get("etag")).toBe(await bodyTag(body));
    expect(res.headers.has("last-modified")).toBe(false);
  });

  it("relays origin's own ETag with an origin ARD document it does not merge", async () => {
    const invalid = JSON.stringify({ entries: [{ displayName: "no identifier" }] });
    stubOrigin({ [ARD]: () => new Response(invalid, { status: 200, headers: { "content-type": "application/json", etag: '"origin-tag"' } }) });
    const res = await call(handlerFor({ features: { ai_catalog: true }, ai_catalog: { mode: "merge" } }), ARD);

    expect(await res.text()).toBe(invalid);
    expect(res.headers.get("etag")).toBe('"origin-tag"');
  });
});

describe("validators on rewritten HTML (a deploy that changes the injection must reach cached pages)", () => {
  const H = "0123456789abcdef";
  const OLD = "fedcba9876543210";
  const page = "https://example.com/page";
  const NAV = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "sec-fetch-dest": "document" };
  const IMAGE = { accept: "image/avif,image/webp,image/*,*/*;q=0.8", "sec-fetch-dest": "image" };
  const LAST_MODIFIED = "Mon, 05 Oct 2026 08:00:00 GMT";
  const handlerWith = (extra: ConfigOverrides = {}) => createHandler(makeDeps(extra, { meta: { INJECTION_HASH: H } }));

  /** Stub origin with one answer and record the requests it was sent. */
  function origin(answer: () => Response): Request[] {
    const seen: Request[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init as Request);
        return answer();
      }),
    );
    return seen;
  }

  const html = (headers: Record<string, string> = {}, contentType = "text/html; charset=utf-8") => () =>
    new Response(HTML, { status: 200, headers: { "content-type": contentType, ...headers } });
  const notModified = (headers: Record<string, string> = {}) => () => new Response(null, { status: 304, headers });

  describe("a rewritten 200", () => {
    it("carries origin's strong ETag with the injection hash inside the quotes, and no Last-Modified", async () => {
      origin(html({ etag: '"abc"', "last-modified": LAST_MODIFIED }));
      const res = await call(handlerWith(), page, { headers: NAV });

      expect(await res.text()).toContain("/_webmcp/bootstrap.test.js");
      expect(res.headers.get("etag")).toBe(`"abc-${H}"`);
      expect(res.headers.has("last-modified")).toBe(false);
    });

    it("keeps a weak ETag weak", async () => {
      origin(html({ etag: 'W/"abc"' }));
      const res = await call(handlerWith(), page, { headers: NAV });

      expect(res.headers.get("etag")).toBe(`W/"abc-${H}"`);
    });

    it("adds no ETag when origin sent none", async () => {
      origin(html({ "last-modified": LAST_MODIFIED }));
      const res = await call(handlerWith(), page, { headers: NAV });

      expect(res.headers.has("etag")).toBe(false);
      expect(res.headers.has("last-modified")).toBe(false);
    });

    it.each(["abc", '"abc', 'W/abc', '"a"b"', '"abc", "def"'])("drops a malformed origin ETag %j instead of making one up", async (etag) => {
      origin(html({ etag }));
      const res = await call(handlerWith(), page, { headers: NAV });

      expect(res.headers.has("etag")).toBe(false);
    });

    it("is suffixed on HEAD exactly as on GET, with no Last-Modified", async () => {
      origin(() => new Response(null, { status: 200, headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"', "last-modified": LAST_MODIFIED } }));
      const head = await call(handlerWith(), page, { method: "HEAD", headers: NAV });
      origin(html({ etag: '"abc"', "last-modified": LAST_MODIFIED }));
      const get = await call(handlerWith(), page, { headers: NAV });

      expect(head.status).toBe(200);
      expect(head.headers.get("etag")).toBe(`"abc-${H}"`);
      expect(head.headers.has("last-modified")).toBe(false);
      expect(head.headers.get("etag")).toBe(get.headers.get("etag"));
    });

    it("is suffixed for any request, a fetch that does not ask for HTML included", async () => {
      origin(html({ etag: '"abc"' }));
      const res = await call(handlerWith(), page, { headers: { accept: "*/*" } });

      expect(res.headers.get("etag")).toBe(`"abc-${H}"`);
    });

    it.each<[string, ConfigOverrides, () => Response]>([
      ["inject_html is off", { features: { inject_html: false } }, html({ etag: '"abc"', "last-modified": LAST_MODIFIED })],
      ["the path is excluded", { injection: { exclude_paths: ["/page"] } }, html({ etag: '"abc"', "last-modified": LAST_MODIFIED })],
      ["the page is not UTF-8", {}, html({ etag: '"abc"', "last-modified": LAST_MODIFIED }, "text/html; charset=iso-8859-1")],
      ["the answer is not HTML", {}, html({ etag: '"abc"', "last-modified": LAST_MODIFIED }, "application/json")],
    ])("keeps origin's validators when the page is not rewritten: %s", async (_label, config, answer) => {
      origin(answer);
      const res = await call(handlerWith(config), page, { headers: NAV });

      expect(res.headers.get("etag")).toBe('"abc"');
      expect(res.headers.get("last-modified")).toBe(LAST_MODIFIED);
    });
  });

  describe("the request sent to origin", () => {
    it("strips the current suffix from If-None-Match on an HTML navigation, and drops If-Modified-Since", async () => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: { ...NAV, "if-none-match": `"abc-${H}"`, "if-modified-since": LAST_MODIFIED } });

      expect(seen[0]!.headers.get("if-none-match")).toBe('"abc"');
      expect(seen[0]!.headers.has("if-modified-since")).toBe(false);
    });

    it("strips the suffix from every entry and keeps each entry weak or strong", async () => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: { ...NAV, "if-none-match": `"a-${H}", W/"b-${H}"` } });

      expect(seen[0]!.headers.get("if-none-match")).toBe('"a", W/"b"');
    });

    it.each([
      ["an image", IMAGE],
      ["a fetch with Accept */*", { accept: "*/*" }],
    ])("strips the current suffix on %s request too", async (_label, headers) => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: { ...headers, "if-none-match": `"abc-${H}", "raw"` } });

      expect(seen[0]!.headers.get("if-none-match")).toBe('"abc", "raw"');
    });

    it.each([
      ["a tag from an older injection", `"abc-${OLD}"`],
      ["a tag without a suffix (a page cached before the upgrade)", '"abc"'],
      ["*", "*"],
      ["a list in which one entry lacks the current suffix", `"a-${H}", "b-${OLD}"`],
      ["an unparseable value", `"abc-${H}" junk`],
    ])("drops If-None-Match on an HTML navigation for %s", async (_label, ifNoneMatch) => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: { ...NAV, "if-none-match": ifNoneMatch } });

      expect(seen[0]!.headers.has("if-none-match")).toBe(false);
    });

    it("drops If-Modified-Since on an HTML navigation that sends no ETag", async () => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: { ...NAV, "if-modified-since": LAST_MODIFIED } });

      expect(seen[0]!.headers.has("if-modified-since")).toBe(false);
    });

    it("forwards an image request's validators unchanged and relays origin's 304 untouched", async () => {
      const seen = origin(notModified({ etag: '"img1"', "last-modified": LAST_MODIFIED }));
      const res = await call(handlerWith(), "https://example.com/logo.png", {
        headers: { ...IMAGE, "if-none-match": '"img1"', "if-modified-since": LAST_MODIFIED },
      });

      expect(seen[0]!.headers.get("if-none-match")).toBe('"img1"');
      expect(seen[0]!.headers.get("if-modified-since")).toBe(LAST_MODIFIED);
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe('"img1"');
      expect(res.headers.get("last-modified")).toBe(LAST_MODIFIED);
    });

    it("leaves * alone on a request that does not ask for HTML", async () => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: { ...IMAGE, "if-none-match": "*" } });

      expect(seen[0]!.headers.get("if-none-match")).toBe("*");
    });

    it.each<[string, ConfigOverrides]>([
      ["inject_html is off", { features: { inject_html: false } }],
      ["the path is excluded", { injection: { exclude_paths: ["/page"] } }],
    ])("forwards an HTML navigation's raw validators unchanged when %s", async (_label, config) => {
      const seen = origin(html());
      await call(handlerWith(config), page, { headers: { ...NAV, "if-none-match": '"abc"', "if-modified-since": LAST_MODIFIED } });

      expect(seen[0]!.headers.get("if-none-match")).toBe('"abc"');
      expect(seen[0]!.headers.get("if-modified-since")).toBe(LAST_MODIFIED);
    });

    it.each(["PUT", "DELETE", "POST"])("strips the current suffix from If-Match on a %s, so origin sees its own tag", async (method) => {
      const seen = origin(() => new Response(null, { status: 204 }));
      await call(handlerWith(), page, { method, headers: { "if-match": `"abc-${H}", W/"def-${H}"` } });

      expect(seen[0]!.headers.get("if-match")).toBe('"abc", W/"def"');
    });

    it.each([
      ["a tag from an older injection", `"abc-${OLD}"`],
      ["a raw tag", '"abc"'],
      ["*", "*"],
      ["an unparseable value", "abc"],
    ])("leaves If-Match alone for %s", async (_label, ifMatch) => {
      const seen = origin(() => new Response(null, { status: 412 }));
      await call(handlerWith(), page, { method: "PUT", headers: { "if-match": ifMatch } });

      expect(seen[0]!.headers.get("if-match")).toBe(ifMatch);
    });

    it("strips If-Match on a GET for HTML too, and never drops it (rule b is about If-None-Match and If-Modified-Since)", async () => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: { ...NAV, "if-match": `"abc-${H}"` } });

      expect(seen[0]!.headers.get("if-match")).toBe('"abc"');
    });

    it("forwards a request without validators exactly as before", async () => {
      const seen = origin(html());
      await call(handlerWith(), page, { headers: NAV });

      expect(seen[0]!.headers.has("if-none-match")).toBe(false);
      expect(seen[0]!.headers.get("accept")).toBe(NAV.accept);
      expect(seen[0]!.redirect).toBe("manual");
    });
  });

  describe("a relayed 304", () => {
    const T1 = makeOriginTrialToken({ feature: "WebMCP" });

    it("gets the suffix back on its ETag, loses Last-Modified, and still carries the Origin-Trial header", async () => {
      origin(notModified({ etag: '"abc"', "last-modified": LAST_MODIFIED }));
      const res = await call(handlerWith({ origin_trial: { tokens: [T1] } }), page, {
        headers: { ...NAV, "if-none-match": `"abc-${H}"` },
      });

      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(`"abc-${H}"`);
      expect(res.headers.has("last-modified")).toBe(false);
      expect(res.headers.get("origin-trial")).toBe(T1);
      expect(res.headers.get("link")).toContain('rel="webmcp"');
    });

    it("keeps a weak ETag weak", async () => {
      origin(notModified({ etag: 'W/"abc"' }));
      const res = await call(handlerWith(), page, { headers: { ...NAV, "if-none-match": `W/"abc-${H}"` } });

      expect(res.headers.get("etag")).toBe(`W/"abc-${H}"`);
    });

    it("gets the suffix back for a fetch that revalidated a rewritten copy", async () => {
      origin(notModified({ etag: '"abc"' }));
      const res = await call(handlerWith(), page, { headers: { accept: "*/*", "if-none-match": `"abc-${H}"` } });

      expect(res.headers.get("etag")).toBe(`"abc-${H}"`);
    });

    it("keeps the ETag of a 304 that answers a tag that carried no suffix, but drops its Last-Modified", async () => {
      origin(notModified({ etag: '"raw"', "last-modified": LAST_MODIFIED }));
      const res = await call(handlerWith(), page, { headers: { accept: "*/*", "if-none-match": `"abc-${H}", "raw"` } });

      expect(res.headers.get("etag")).toBe('"raw"');
      expect(res.headers.has("last-modified")).toBe(false);
    });

    it("drops Last-Modified from a 304 without an ETag when a suffix was stripped", async () => {
      origin(notModified({ "last-modified": LAST_MODIFIED }));
      const res = await call(handlerWith(), page, { headers: { ...NAV, "if-none-match": `"abc-${H}"` } });

      expect(res.status).toBe(304);
      expect(res.headers.has("etag")).toBe(false);
      expect(res.headers.has("last-modified")).toBe(false);
    });

    it("keeps Last-Modified on a 304 when nothing was stripped", async () => {
      origin(notModified({ etag: '"img1"', "last-modified": LAST_MODIFIED }));
      const res = await call(handlerWith(), page, { headers: { ...IMAGE, "if-none-match": '"img1"' } });

      expect(res.headers.get("last-modified")).toBe(LAST_MODIFIED);
    });
  });
});

describe("worker: the User-Agent of the Worker's own origin fetches", () => {
  it("names the version from the build (CF_WEBMCP_VERSION) on the merge routes, not a fixed one", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push((init?.headers as Record<string, string>)["user-agent"]!);
        return new Response("not found", { status: 404 });
      }),
    );
    const handler = createHandler(makeDeps({}, { meta: { CF_WEBMCP_VERSION: "7.8.9" } }));

    await call(handler, "https://example.com/llms.txt");
    await call(handler, "https://example.com/robots.txt");

    expect(seen).toEqual(["cf-webmcp/7.8.9", "cf-webmcp/7.8.9"]);
  });
});

// docs/limitations.md: pages without a literal <head> get no <link> tags (the Link header is
// there regardless), and pages without </body> get the script at the end of the document.
describe("worker: pages without a literal <head> or </body>", () => {
  async function load(html: string) {
    stubOrigin({ "https://example.com/p": () => htmlResponse(html) });
    const res = await call(createHandler(makeDeps()), "https://example.com/p");
    return { body: await res.text(), link: res.headers.get("link") };
  }
  const SCRIPT = /<script src="https:\/\/example\.com\/_webmcp\/bootstrap\.test\.js"[^>]*><\/script>/;

  it("no <head>: no <link> tags, the script before </body>, and the Link header still names the documents", async () => {
    const { body, link } = await load("<!doctype html><html><body><p>hi</p></body></html>");

    expect(body).not.toContain("<link");
    expect(body).toMatch(new RegExp(`<p>hi</p>${SCRIPT.source}</body>`));
    expect(link).toContain('rel="webmcp"');
    expect(link).toContain('rel="api-catalog"');
  });

  it("no </body>: the script goes at the very end of the document, the <link> tags still go in <head>", async () => {
    const { body } = await load("<!doctype html><html><head><title>t</title></head><body><p>hi");

    expect(body).toMatch(new RegExp(`<p>hi${SCRIPT.source}$`));
    expect(body).toContain('<link rel="webmcp"');
  });

  it("neither <head> nor </body>: no <link> tags, the script at the end of the document, the Link header present", async () => {
    const { body, link } = await load("<!doctype html><html><body><p>hi");

    expect(body).not.toContain("<link");
    expect(body).toMatch(new RegExp(`<p>hi${SCRIPT.source}$`));
    expect(link).toContain('rel="webmcp"');
  });

  it("a bare fragment is passed through untouched, with the Link header", async () => {
    const { body, link } = await load("<div>plain fragment</div>");

    expect(body).toBe("<div>plain fragment</div>");
    expect(link).toContain('rel="webmcp"');
  });
});
