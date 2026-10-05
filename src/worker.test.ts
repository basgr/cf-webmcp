/**
 * Worker-level tests. These drive the real request pipeline (router, route
 * handlers, proxy, HTMLRewriter injection) through createHandler() with an
 * injected config, so each case can vary config and canned origin responses
 * without touching the generated modules.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, PROXY_ORIGIN_TIMEOUT_MS, type Env } from "./handler";
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
    const relayRoutes = [
      { name: "llms.txt", path: "/llms.txt" },
      { name: "robots.txt", path: "/robots.txt" },
      { name: "agents.md", path: "/.well-known/agents.md" },
      { name: "api-catalog", path: "/.well-known/api-catalog" },
      { name: "agent-skills (merge)", path: "/.well-known/agent-skills/site/SKILL.md" },
    ];
    const deps = () => makeDeps({ agent_skills: { mode: "merge" } });

    it.each(relayRoutes)("$name: answers the origin's 301 with the resolved Location, no body, no-store, noindex", async ({ path }) => {
      const fetchMock = stubOrigin({
        [`https://example.com${path}`]: () => redirectTo(301, `https://www.example.com${path}`),
        [`https://www.example.com${path}`]: () => textResponse("should never be fetched"),
      });
      const handler = createHandler(deps());

      const res = await call(handler, `https://example.com${path}`, undefined, tokenEnv);

      expect(res.status).toBe(301);
      expect(res.headers.get("location")).toBe(`https://www.example.com${path}`);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      const body = await res.text();
      expect(body).toBe("");
      // Exactly one request, to origin; none to the other host, and the token is on that one only.
      expect(urlsOf(fetchMock)).toEqual([`https://example.com${path}`]);
      expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)["cf-webmcp-deploy-token"]).toBe("deploy-token-x");
      expectNoToken(res, body);
    });

    it("ai-catalog in merge mode keeps serving its synthesized document (200), after one request", async () => {
      const fetchMock = stubOrigin({
        "https://example.com/.well-known/ai-catalog.json": () =>
          redirectTo(301, "https://www.example.com/.well-known/ai-catalog.json"),
      });
      const handler = createHandler(
        makeDeps(
          { features: { ai_catalog: true }, ai_catalog: { mode: "merge" } },
          { assets: { aiCatalogJson: '{"synthesized":true}' } },
        ),
      );

      const res = await call(handler, "https://example.com/.well-known/ai-catalog.json", undefined, tokenEnv);

      expect(res.status).toBe(200);
      expect(await res.text()).toBe('{"synthesized":true}');
      expect(res.headers.get("content-type")).toBe("application/ai-catalog+json");
      expect(urlsOf(fetchMock)).toEqual(["https://example.com/.well-known/ai-catalog.json"]);
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
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
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
        routes[i === 0 ? "https://example.com/llms.txt" : `https://example.com/h${i}`] = () =>
          redirectTo(302, `/h${i + 1}`);
      }
      const fetchMock = stubOrigin(routes);
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

      await expect502(res, "origin redirected too many times");
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it("an unparseable Location, which is logged but not echoed", async () => {
      stubOrigin({ "https://example.com/llms.txt": () => redirectTo(302, "http://:notaport?q=secret") });
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

      await expect502(res, "origin returned an unusable redirect location");
      const line = errorLog.mock.calls[0]![0] as string;
      expect(line.startsWith("cf-webmcp: proxy refused an origin redirect: ")).toBe(true);
      expect(line).toContain("http://:notaport?q=secret");
    });

    it("a blob: Location whose origin looks allowed: nothing is requested for it", async () => {
      const fetchMock = stubOrigin({
        "https://example.com/llms.txt": () => redirectTo(302, "blob:https://example.com/abc?q=secret"),
      });
      const handler = createHandler(makeDeps());

      const res = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

      await expect502(res, "origin returned an unusable redirect location");
      expect(urlsOf(fetchMock)).toEqual(["https://example.com/llms.txt"]);
    });

    it("base_url itself outside allowed_origins: nothing is sent, and only the log names the origin", async () => {
      const fetchMock = stubOrigin({});
      const handler = createHandler(
        makeDeps({ origin: { base_url: "https://other.example", allowed_origins: ["https://example.com"] } }),
      );

      const res = await call(handler, "https://example.com/llms.txt", undefined, tokenEnv);

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

    const res = await call(handler, "https://example.com/robots.txt", undefined, tokenEnv);

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

    const pending = call(handler, "https://example.com/llms.txt", undefined, tokenEnv);
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
