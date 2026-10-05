import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { resolveUrl, originFetch, mapOriginStatus, readWithLimit, isAbortError } from "./common";
import { isAbortError as isAbortErrorFromSafeFetch } from "../safe-fetch";

const ctx = {
  allowedOrigins: ["https://example.com"],
  deployToken: "deploy-token-x",
  timeoutMs: 1000,
  version: "0.0.0-test",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveUrl", () => {
  it("resolves a clean template", () => {
    const r = resolveUrl(ctx, {
      urlTemplate: "https://example.com/p?q={{query}}",
      input: { query: "hello" },
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.url.toString()).toBe("https://example.com/p?q=hello");
  });

  it("keeps URL on example.com even when input looks like a URL", () => {
    // URL-encoding in query position prevents the host from being changed
    // by user input. The resulting URL stays inside the allow-listed origin.
    const r = resolveUrl(ctx, {
      urlTemplate: "https://example.com/p?q={{query}}",
      input: { query: "https://evil.example.com/" },
    });
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.url.origin).toBe("https://example.com");
    expect(r.url.searchParams.get("q")).toBe("https://evil.example.com/");
  });

  it("rejects when template resolves outside allowed_origins", () => {
    const r = resolveUrl(ctx, {
      urlTemplate: "https://other.example.com/{{p}}",
      input: { p: "x" },
    });
    if (r.ok) throw new Error("expected rejection");
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.message).toContain("not in allowed_origins");
  });

  it("returns invalid_input on missing required param", () => {
    const r = resolveUrl(ctx, {
      urlTemplate: "https://example.com/{{slug}}",
      input: {},
    });
    if (r.ok) throw new Error("expected rejection");
    expect(r.error.code).toBe("invalid_input");
  });
});

describe("originFetch", () => {
  it("strips visitor cookies and sets the bypass header", async () => {
    const seen: { headers: Record<string, string> } = { headers: {} };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const h = init.headers as Record<string, string> | undefined;
        if (h) seen.headers = h;
        return new Response("ok", { status: 200 });
      }),
    );
    const r = await originFetch(ctx, new URL("https://example.com/x"), {});
    expect(r).toBeInstanceOf(Response);
    expect(seen.headers["cookie"]).toBeUndefined();
    expect(seen.headers["cf-webmcp-bypass"]).toBe("1");
    expect(seen.headers["cf-webmcp-deploy-token"]).toBe("deploy-token-x");
    expect(seen.headers["user-agent"]).toBe("cf-webmcp/0.0.0-test");
  });

  it("names the version of the context in the User-Agent, whatever it is, and not a fixed one", async () => {
    const agents: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        agents.push((init.headers as Record<string, string>)["user-agent"]!);
        return new Response("ok", { status: 200 });
      }),
    );
    for (const version of ["0.6.0", "0.6.1-rc.1", "12.0.3"]) {
      await originFetch({ ...ctx, version }, new URL("https://example.com/x"), {});
    }
    expect(agents).toEqual(["cf-webmcp/0.6.0", "cf-webmcp/0.6.1-rc.1", "cf-webmcp/12.0.3"]);
    expect(agents).not.toContain("cf-webmcp/1.0");
  });

  it("maps timeout to envelope error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((_, reject) => {
            // never resolves - controller.abort will kick in
            setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
          }),
      ),
    );
    const r = await originFetch({ ...ctx, timeoutMs: 10 }, new URL("https://example.com/x"));
    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("timeout");
  });
});

describe("originFetch with a run-wide signal", () => {
  it("hands the caller's signal to fetch and leaves it armed after the headers arrive", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.signal ?? undefined;
        return new Response("ok", { status: 200 });
      }),
    );

    const r = await originFetch({ ...ctx, timeoutMs: 20, signal: controller.signal }, new URL("https://example.com/x"));

    expect(r).toBeInstanceOf(Response);
    expect(seen).toBe(controller.signal);
    // The local per-fetch timer must not exist: waiting past timeoutMs must not abort the shared signal.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(controller.signal.aborted).toBe(false);
  });

  it("maps an abort of the caller's signal to a timeout error", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          }),
      ),
    );
    const pending = originFetch({ ...ctx, signal: controller.signal }, new URL("https://example.com/x"));
    controller.abort();

    const r = await pending;
    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("timeout");
  });
});

/** A scripted 3xx response. */
function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

type FetchInit = Omit<RequestInit, "headers"> & { headers: Record<string, string> };

/** Stub fetch with one handler per exact URL; anything else answers 599. Returns the mock. */
function stubFetch(routes: Record<string, (init: FetchInit) => Response | Promise<Response>>) {
  const mock = vi.fn(async (url: string, init: FetchInit) => {
    const route = routes[url];
    if (!route) return new Response(`unscripted ${url}`, { status: 599 });
    return route(init);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

function calledUrls(mock: ReturnType<typeof stubFetch>): string[] {
  return mock.mock.calls.map((c) => c[0]);
}

const twoHostCtx = { ...ctx, allowedOrigins: ["https://example.com", "https://cdn.example.com"] };

describe("originFetch redirects", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The JSON detail of the single console.error line a refused redirect writes. */
  function loggedDetail(): Record<string, unknown> {
    expect(errorLog).toHaveBeenCalledTimes(1);
    const line = errorLog.mock.calls[0]![0] as string;
    expect(line.startsWith("cf-webmcp: executor refused an origin redirect: ")).toBe(true);
    return JSON.parse(line.slice(line.indexOf("{")));
  }

  it("never sends a request to an off-list redirect target, and returns invalid_input", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "https://evil.example/steal"),
      "https://evil.example/steal": () => new Response("should never be fetched", { status: 200 }),
    });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.retriable).toBe(false);
    expect(r.error.message).toBe("origin redirected to an origin outside allowed_origins; refused to follow");
    expect(calledUrls(fetchMock)).toEqual(["https://example.com/a"]);
  });

  it("keeps the refused host out of the envelope and puts the detail in one log line instead", async () => {
    stubFetch({ "https://example.com/a": () => redirect(302, "https://intranet.corp.example:8443/admin?token=abc") });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    if (r instanceof Response) throw new Error("expected error");
    expect(JSON.stringify(r.error)).not.toMatch(/intranet|corp|8443|admin|abc/);
    expect(JSON.stringify(r.error)).not.toContain(ctx.deployToken);
    expect(loggedDetail()).toEqual({
      start: "https://example.com/a",
      kind: "off_list",
      origin: "https://intranet.corp.example:8443",
      redirected: true,
      status: 302,
      target: "https://intranet.corp.example:8443/admin",
    });
  });

  it("uses redirect: manual on every hop", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(301, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => new Response("done", { status: 200 }),
    });

    await originFetch(twoHostCtx, new URL("https://example.com/a"));

    expect(fetchMock.mock.calls.map((c) => c[1].redirect)).toEqual(["manual", "manual"]);
  });

  it("follows A to an allowed A2, sends the token to both, and returns the final body", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(301, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => new Response("final body", { status: 200 }),
    });

    const r = await originFetch(twoHostCtx, new URL("https://example.com/a"));

    if (!(r instanceof Response)) throw new Error(JSON.stringify(r));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("final body");
    expect(calledUrls(fetchMock)).toEqual(["https://example.com/a", "https://cdn.example.com/b"]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers["cf-webmcp-bypass"]).toBe("1");
      expect(init.headers["cf-webmcp-deploy-token"]).toBe("deploy-token-x");
    }
  });

  it("resolves a relative Location against the current URL", async () => {
    const fetchMock = stubFetch({
      "https://example.com/dir/a": () => redirect(302, "../new?x=1"),
      "https://example.com/new?x=1": () => new Response("ok", { status: 200 }),
    });

    const r = await originFetch(ctx, new URL("https://example.com/dir/a"));

    expect(r).toBeInstanceOf(Response);
    expect(calledUrls(fetchMock)).toEqual(["https://example.com/dir/a", "https://example.com/new?x=1"]);
  });

  it("refuses a protocol-relative Location that resolves off-list", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "//evil.example/x"),
    });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.message).toBe("origin redirected to an origin outside allowed_origins; refused to follow");
    expect(calledUrls(fetchMock)).toEqual(["https://example.com/a"]);
  });

  it("re-checks the allow-list on every hop: A to allowed A2 to off-list B never reaches B", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => redirect(302, "https://evil.example/c"),
    });

    const r = await originFetch(twoHostCtx, new URL("https://example.com/a"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
    expect(calledUrls(fetchMock)).toEqual(["https://example.com/a", "https://cdn.example.com/b"]);
  });

  it("follows exactly 5 redirects", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 5; i++) routes[`https://example.com/h${i}`] = () => redirect(302, `/h${i + 1}`);
    routes["https://example.com/h5"] = () => new Response("end", { status: 200 });
    const fetchMock = stubFetch(routes);

    const r = await originFetch(ctx, new URL("https://example.com/h0"));

    if (!(r instanceof Response)) throw new Error(JSON.stringify(r));
    expect(await r.text()).toBe("end");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("gives up on the 6th redirect with an internal, non-retriable error and does not request a 7th URL", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 6; i++) routes[`https://example.com/h${i}`] = () => redirect(302, `/h${i + 1}`);
    routes["https://example.com/h6"] = () => new Response("end", { status: 200 });
    const fetchMock = stubFetch(routes);

    const r = await originFetch(ctx, new URL("https://example.com/h0"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error).toEqual({ code: "internal", message: "too many redirects (more than 5)", retriable: false });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(calledUrls(fetchMock)).not.toContain("https://example.com/h6");
  });

  it("gives up on a redirect loop", async () => {
    const fetchMock = stubFetch({ "https://example.com/loop": () => redirect(302, "/loop") });

    const r = await originFetch(ctx, new URL("https://example.com/loop"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("internal");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("switches to GET and drops the body on a 303", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(303, "/b"),
      "https://example.com/b": () => new Response("ok", { status: 200 }),
    });

    await originFetch(ctx, new URL("https://example.com/a"), { method: "POST", body: '{"q":1}' });

    const [first, second] = fetchMock.mock.calls;
    expect(first![1].method).toBe("POST");
    expect(first![1].body).toBe('{"q":1}');
    expect(second![1].method).toBe("GET");
    expect(second![1].body).toBeUndefined();
  });

  it.each([301, 302])("switches to GET and drops the body on a %i", async (status) => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(status, "/b"),
      "https://example.com/b": () => new Response("ok", { status: 200 }),
    });

    await originFetch(ctx, new URL("https://example.com/a"), { method: "POST", body: "payload" });

    const second = fetchMock.mock.calls[1]!;
    expect(second[1].method).toBe("GET");
    expect(second[1].body).toBeUndefined();
  });

  it.each([307, 308])("replays the method and the buffered body on a %i", async (status) => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(status, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => new Response("ok", { status: 200 }),
    });

    await originFetch(twoHostCtx, new URL("https://example.com/a"), { method: "POST", body: '{"q":"x"}' });

    const [first, second] = fetchMock.mock.calls;
    expect(second![1].method).toBe("POST");
    expect(second![1].body).toBe('{"q":"x"}');
    expect(second![1].body).toBe(first![1].body);
  });

  it("returns a redirect status without a Location header as the final response", async () => {
    stubFetch({ "https://example.com/a": () => new Response(null, { status: 302 }) });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    if (!(r instanceof Response)) throw new Error(JSON.stringify(r));
    expect(r.status).toBe(302);
    expect(mapOriginStatus(r.status)?.code).toBe("internal");
  });

  it("maps an unparseable Location to a generic non-retriable internal error and logs the truncated value", async () => {
    const bad = "http://" + "x".repeat(300) + ":notaport?q=secret";
    const fetchMock = stubFetch({ "https://example.com/a": () => redirect(302, bad) });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error).toEqual({
      code: "internal",
      message: "origin returned an unusable redirect location",
      retriable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(loggedDetail()).toEqual({
      start: "https://example.com/a",
      kind: "malformed_location",
      location: bad.slice(0, 200),
    });
  });

  it("refuses a redirect to a non-http scheme without requesting it, with the same generic internal error", async () => {
    const fetchMock = stubFetch({ "https://example.com/a": () => redirect(302, "javascript:alert(1)") });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error).toEqual({
      code: "internal",
      message: "origin returned an unusable redirect location",
      retriable: false,
    });
    expect(calledUrls(fetchMock)).toEqual(["https://example.com/a"]);
  });

  it("refuses a blob: redirect whose origin looks allowed, and keeps its URL out of the envelope", async () => {
    // new URL("blob:https://example.com/abc").origin === "https://example.com": an origin check alone passes it,
    // and workerd would then throw a TypeError that quotes the whole URL, query included.
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "blob:https://example.com/abc?q=secret"),
      "blob:https://example.com/abc?q=secret": () => new Response("should never be fetched", { status: 200 }),
    });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error).toEqual({
      code: "internal",
      message: "origin returned an unusable redirect location",
      retriable: false,
    });
    expect(JSON.stringify(r.error)).not.toContain("secret");
    expect(calledUrls(fetchMock)).toEqual(["https://example.com/a"]);
  });

  it("refuses a non-http(s) starting URL without sending anything", async () => {
    const fetchMock = stubFetch({});

    const r = await originFetch(ctx, new URL("blob:https://example.com/x?q=secret"));

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("invalid_input");
    expect(r.error.retriable).toBe(false);
    expect(JSON.stringify(r.error)).not.toContain("secret");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs a refused redirect chain that is too long, and keeps the envelope generic", async () => {
    stubFetch({ "https://example.com/loop": () => redirect(302, "/loop") });

    await originFetch(ctx, new URL("https://example.com/loop"));

    expect(loggedDetail()).toEqual({ start: "https://example.com/loop", kind: "too_many_redirects", maxHops: 5 });
  });

  it("sends no secret header on any hop when bypassEnabled is false, even with a token configured", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => new Response("ok", { status: 200 }),
    });

    const r = await originFetch(twoHostCtx, new URL("https://example.com/a"), { bypassEnabled: false });

    expect(r).toBeInstanceOf(Response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers["cf-webmcp-bypass"]).toBeUndefined();
      expect(init.headers["cf-webmcp-deploy-token"]).toBeUndefined();
      expect(JSON.stringify(init.headers)).not.toContain("deploy-token-x");
      expect(init.headers["user-agent"]).toBe("cf-webmcp/0.0.0-test");
    }
  });

  it("cancels the body of an intermediate redirect response before following it", async () => {
    let cancelled = false;
    stubFetch({
      "https://example.com/a": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode("redirect page"));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302, headers: { location: "/b" } },
        ),
      "https://example.com/b": () => new Response("ok", { status: 200 }),
    });

    const r = await originFetch(ctx, new URL("https://example.com/a"));

    expect(r).toBeInstanceOf(Response);
    expect(cancelled).toBe(true);
  });

  it("does not send the token headers when no deploy token is configured", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "/b"),
      "https://example.com/b": () => new Response("ok", { status: 200 }),
    });

    await originFetch({ ...ctx, deployToken: "" }, new URL("https://example.com/a"));

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers["cf-webmcp-bypass"]).toBeUndefined();
      expect(init.headers["cf-webmcp-deploy-token"]).toBeUndefined();
    }
  });
});

describe("originFetch deadline across redirect hops", () => {
  function abortable(init: FetchInit): Promise<Response> {
    return new Promise((_, reject) => {
      init.signal!.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  }

  it("uses the run-wide signal for every hop, and a stall on hop 2 times out", async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "/b"),
      "https://example.com/b": abortable,
    });

    const pending = originFetch({ ...ctx, timeoutMs: 20, signal: controller.signal }, new URL("https://example.com/a"));
    setTimeout(() => controller.abort(), 20);
    const r = await pending;

    if (r instanceof Response) throw new Error("expected error");
    expect(r.error.code).toBe("timeout");
    expect(fetchMock.mock.calls.map((c) => c[1].signal)).toEqual([controller.signal, controller.signal]);
  });

  it("without a run-wide signal, one local timer covers the whole chain", async () => {
    vi.useFakeTimers();
    try {
      stubFetch({
        // Hop 1 answers after 20ms, hop 2 stalls until aborted.
        "https://example.com/a": () => new Promise((resolve) => setTimeout(() => resolve(redirect(302, "/b")), 20)),
        "https://example.com/b": abortable,
      });

      const pending = originFetch({ ...ctx, timeoutMs: 30 }, new URL("https://example.com/a"));
      let result: Awaited<typeof pending> | undefined;
      void pending.then((r) => {
        result = r;
      });

      await vi.advanceTimersByTimeAsync(20); // hop 1 answers, hop 2 starts
      expect(result).toBeUndefined();
      // A per-hop timer would give hop 2 a fresh 30ms and still be pending at t=30.
      await vi.advanceTimersByTimeAsync(10);

      if (result === undefined || result instanceof Response) throw new Error("expected a timeout at t=30");
      expect(result.error.code).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("readWithLimit abort handling", () => {
  function stalling(first = "partial") {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(first));
        },
      }),
    );
  }

  it("reports aborted (not a partial body) when the signal fires mid-read", async () => {
    const controller = new AbortController();
    const pending = readWithLimit(stalling(), 1000, controller.signal);
    setTimeout(() => controller.abort(), 20);

    const r = await pending;

    expect(r).toEqual({ ok: false, reason: "aborted" });
  });

  it("reports aborted straight away when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    expect(await readWithLimit(stalling(), 1000, controller.signal)).toEqual({ ok: false, reason: "aborted" });
  });

  it("reports too_large with a reason when the cap is exceeded", async () => {
    expect(await readWithLimit(new Response("a".repeat(50)), 10)).toEqual({ ok: false, reason: "too_large" });
  });

  it("returns the text on success", async () => {
    expect(await readWithLimit(new Response("hello"), 10)).toEqual({ ok: true, text: "hello" });
  });

  it("counts bytes, so a multi-byte body over the cap is too large", async () => {
    // 6 characters, 12 bytes.
    expect(await readWithLimit(new Response("é".repeat(6)), 10)).toEqual({ ok: false, reason: "too_large" });
  });

  it("propagates a stream error that is not an abort", async () => {
    const broken = new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.error(new Error("socket reset"));
        },
      }),
    );
    await expect(readWithLimit(broken, 10)).rejects.toThrow("socket reset");
  });
});

describe("isAbortError", () => {
  it("is the one from safe-fetch, re-exported for the executors", () => {
    expect(isAbortError).toBe(isAbortErrorFromSafeFetch);
  });
});

describe("mapOriginStatus", () => {
  it("returns null for 2xx", () => {
    expect(mapOriginStatus(200)).toBeNull();
  });

  it("maps 5xx", () => {
    expect(mapOriginStatus(503)?.code).toBe("origin_5xx");
  });

  it("maps 404", () => {
    expect(mapOriginStatus(404)?.code).toBe("not_found");
  });

  it("maps 429", () => {
    expect(mapOriginStatus(429)?.code).toBe("rate_limited");
  });

  it("maps generic 4xx", () => {
    expect(mapOriginStatus(403)?.code).toBe("origin_4xx");
  });
});
