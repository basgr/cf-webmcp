import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithManualRedirects, logRedirectFailure, MAX_REDIRECT_HOPS } from "./safe-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
});

type FetchInit = Omit<RequestInit, "headers"> & { headers: Record<string, string> };

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { location } });
}

function stubFetch(routes: Record<string, (init: FetchInit) => Response>) {
  const mock = vi.fn(async (url: string, init: FetchInit) => {
    const route = routes[url];
    return route ? route(init) : new Response(`unscripted ${url}`, { status: 599 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const signal = new AbortController().signal;
const base = {
  allowedOrigins: ["https://example.com", "https://cdn.example.com"],
  headers: { "user-agent": "test-agent", accept: "text/plain" },
  secretHeaders: { "x-secret": "s3cret" },
  signal,
};

describe("fetchWithManualRedirects", () => {
  it("allows 5 hops by default", () => {
    expect(MAX_REDIRECT_HOPS).toBe(5);
  });

  it("returns a non-redirect response unchanged after a single request", async () => {
    const fetchMock = stubFetch({ "https://example.com/a": () => new Response("hi", { status: 200 }) });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(await r.response.text()).toBe("hi");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1].redirect).toBe("manual");
    expect(fetchMock.mock.calls[0]![1].method).toBe("GET");
    expect(fetchMock.mock.calls[0]![1].signal).toBe(signal);
  });

  it("refuses an off-list starting URL without sending anything, and says it was not a redirect", async () => {
    const fetchMock = stubFetch({});

    const r = await fetchWithManualRedirects(new URL("https://evil.example/a"), {}, base);

    expect(r).toEqual({ ok: false, failure: { kind: "off_list", origin: "https://evil.example", redirected: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("flags an off-list redirect target as redirected, and requests nothing there", async () => {
    const fetchMock = stubFetch({ "https://example.com/a": () => redirect(302, "https://evil.example:8443/b?token=1") });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    // The refused origin carries no path or query; status and the resolved absolute target are
    // there so a caller can relay the redirect itself.
    expect(r).toEqual({
      ok: false,
      failure: {
        kind: "off_list",
        origin: "https://evil.example:8443",
        redirected: true,
        status: 302,
        target: "https://evil.example:8443/b?token=1",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports the status of the hop that pointed off-list and the Location resolved against that hop", async () => {
    stubFetch({
      "https://example.com/a": () => redirect(301, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => redirect(307, "//evil.example/c?x=1#frag"),
    });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    expect(r).toMatchObject({
      ok: false,
      failure: { kind: "off_list", redirected: true, status: 307, target: "https://evil.example/c?x=1#frag" },
    });
  });

  it.each(["data:text/html,hi", "javascript:alert(1)", "ftp://example.com/x", "ws://example.com/x"])(
    "refuses a redirect to %s as an unsupported scheme, without requesting it",
    async (location) => {
      const fetchMock = stubFetch({ "https://example.com/a": () => redirect(302, location) });

      const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

      expect(r).toEqual({
        ok: false,
        failure: { kind: "unsupported_scheme", protocol: new URL(location).protocol, redirected: true },
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses a blob: Location even though its origin is an allowed https origin", async () => {
    // new URL("blob:https://example.com/abc").origin is "https://example.com", so an allow-list check
    // alone would let it through and workerd would then throw with the full URL in the message.
    expect(new URL("blob:https://example.com/abc?q=secret").origin).toBe("https://example.com");
    const fetchMock = stubFetch({ "https://example.com/a": () => redirect(302, "blob:https://example.com/abc?q=secret") });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    expect(r).toEqual({ ok: false, failure: { kind: "unsupported_scheme", protocol: "blob:", redirected: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a blob: starting URL without sending anything", async () => {
    const fetchMock = stubFetch({});

    const r = await fetchWithManualRedirects(new URL("blob:https://example.com/x"), {}, base);

    expect(r).toEqual({ ok: false, failure: { kind: "unsupported_scheme", protocol: "blob:", redirected: false } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks the scheme on every hop, not only the first redirect", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(302, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => redirect(302, "blob:https://example.com/c"),
    });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    expect(r).toMatchObject({ ok: false, failure: { kind: "unsupported_scheme", redirected: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("compares origins after normalising the allow-list entries (trailing slash, path)", async () => {
    stubFetch({
      "https://example.com/a": () => redirect(302, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => new Response("ok", { status: 200 }),
    });

    const r = await fetchWithManualRedirects(
      new URL("https://example.com/a"),
      {},
      { ...base, allowedOrigins: ["https://example.com/", "https://cdn.example.com/some/path"] },
    );

    expect(r.ok).toBe(true);
  });

  it("ignores allow-list entries that are not URLs instead of throwing", async () => {
    stubFetch({ "https://example.com/a": () => new Response("ok", { status: 200 }) });

    const r = await fetchWithManualRedirects(
      new URL("https://example.com/a"),
      {},
      { ...base, allowedOrigins: ["not a url", "https://example.com"] },
    );

    expect(r.ok).toBe(true);
  });

  it("attaches the secret headers on every hop and keeps the plain headers", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(301, "https://cdn.example.com/b"),
      "https://cdn.example.com/b": () => new Response("ok", { status: 200 }),
    });

    await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.headers).toEqual({ "user-agent": "test-agent", accept: "text/plain", "x-secret": "s3cret" });
    }
  });

  it("never gives the secret headers to a host it refuses", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(301, "https://evil.example/b"),
      "https://evil.example/b": () => new Response("leak", { status: 200 }),
    });

    await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    const everySentHeader = fetchMock.mock.calls.flatMap(([url, init]) => [url, JSON.stringify(init.headers)]);
    expect(everySentHeader.join("\n")).not.toContain("evil.example");
    expect(everySentHeader.join("\n")).toContain("s3cret"); // the first, allowed hop did carry it
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges header names case-insensitively: a secret replaces a same-named plain header instead of combining with it", async () => {
    const fetchMock = stubFetch({ "https://example.com/a": () => new Response("ok", { status: 200 }) });

    await fetchWithManualRedirects(
      new URL("https://example.com/a"),
      {},
      {
        ...base,
        headers: { "CF-WEBMCP-DEPLOY-TOKEN": "plain", "User-Agent": "test-agent" },
        secretHeaders: { "cf-webmcp-deploy-token": "s3cret" },
      },
    );

    const sent = fetchMock.mock.calls[0]![1].headers;
    expect(sent["cf-webmcp-deploy-token"]).toBe("s3cret");
    expect(JSON.stringify(sent)).not.toContain("plain");
    expect(Object.keys(sent).filter((k) => k.toLowerCase() === "cf-webmcp-deploy-token")).toHaveLength(1);
    expect(sent["user-agent"]).toBe("test-agent");
  });

  it("drops content-type and content-length (any case) when a 303 turns a POST into a GET", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(303, "/b"),
      "https://example.com/b": () => new Response("ok", { status: 200 }),
    });

    await fetchWithManualRedirects(
      new URL("https://example.com/a"),
      { method: "POST", body: "{}" },
      { ...base, headers: { ...base.headers, "Content-Type": "application/json", "content-length": "2" } },
    );

    const [first, second] = fetchMock.mock.calls;
    expect(first![1].headers["content-type"]).toBe("application/json");
    expect(second![1].method).toBe("GET");
    expect(second![1].body).toBeUndefined();
    expect(Object.keys(second![1].headers).map((k) => k.toLowerCase())).not.toContain("content-type");
    expect(Object.keys(second![1].headers).map((k) => k.toLowerCase())).not.toContain("content-length");
    expect(second![1].headers["user-agent"]).toBe("test-agent");
  });

  it("keeps content-type and the body when a 307/308 replays the request", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(308, "/b"),
      "https://example.com/b": () => new Response("ok", { status: 200 }),
    });

    await fetchWithManualRedirects(
      new URL("https://example.com/a"),
      { method: "POST", body: '{"a":1}' },
      { ...base, headers: { ...base.headers, "content-type": "application/json" } },
    );

    const second = fetchMock.mock.calls[1]!;
    expect(second[1].method).toBe("POST");
    expect(second[1].body).toBe('{"a":1}');
    expect(second[1].headers["content-type"]).toBe("application/json");
  });

  describe("method rewriting follows the Fetch spec", () => {
    async function followOnce(status: number, method: string, body?: string) {
      const fetchMock = stubFetch({
        "https://example.com/a": () => redirect(status, "/b"),
        "https://example.com/b": () => new Response("ok", { status: 200 }),
      });
      await fetchWithManualRedirects(
        new URL("https://example.com/a"),
        { method, body },
        { ...base, headers: { ...base.headers, "content-type": "text/plain" } },
      );
      const second = fetchMock.mock.calls[1]![1];
      return { method: second.method, body: second.body, contentType: second.headers["content-type"] };
    }

    it.each([301, 302])("%i turns a POST into a GET and drops body and content-type", async (status) => {
      expect(await followOnce(status, "POST", "x")).toEqual({ method: "GET", body: undefined, contentType: undefined });
    });

    it.each([301, 302])("%i keeps a PUT, with its body and content-type", async (status) => {
      expect(await followOnce(status, "PUT", "x")).toEqual({ method: "PUT", body: "x", contentType: "text/plain" });
    });

    it.each([301, 302, 303])("%i keeps HEAD as HEAD", async (status) => {
      expect(await followOnce(status, "HEAD")).toMatchObject({ method: "HEAD", body: undefined });
    });

    it.each(["POST", "PUT", "DELETE"])("303 turns %s into a GET and drops body and content-type", async (method) => {
      expect(await followOnce(303, method, "x")).toEqual({ method: "GET", body: undefined, contentType: undefined });
    });

    it("303 keeps a GET as GET", async () => {
      expect(await followOnce(303, "GET")).toMatchObject({ method: "GET", body: undefined });
    });

    it.each([307, 308])("%i keeps any method, body and content-type", async (status) => {
      expect(await followOnce(status, "PUT", "x")).toEqual({ method: "PUT", body: "x", contentType: "text/plain" });
    });
  });

  it("stays GET after a 307 on a GET, and never passes a body with a GET", async () => {
    const fetchMock = stubFetch({
      "https://example.com/a": () => redirect(307, "/b"),
      "https://example.com/b": () => new Response("ok", { status: 200 }),
    });

    await fetchWithManualRedirects(new URL("https://example.com/a"), { body: "ignored" }, base);

    for (const [, init] of fetchMock.mock.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
    }
  });

  it("returns a redirect status that has no Location header as the final response", async () => {
    stubFetch({ "https://example.com/a": () => new Response(null, { status: 301 }) });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.response.status).toBe(301);
  });

  it("does not treat 300, 304 or 305 as redirects to follow", async () => {
    for (const status of [300, 304, 305]) {
      const fetchMock = stubFetch({
        "https://example.com/a": () => new Response(null, { status, headers: { location: "https://evil.example/" } }),
      });

      const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

      if (!r.ok) throw new Error(JSON.stringify(r));
      expect(r.response.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it("honours a custom maxHops", async () => {
    const fetchMock = stubFetch({ "https://example.com/a": () => redirect(302, "/a") });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, { ...base, maxHops: 2 });

    expect(r).toEqual({ ok: false, failure: { kind: "too_many_redirects", maxHops: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("truncates the Location it reports for an unparseable value to 200 characters", async () => {
    stubFetch({ "https://example.com/a": () => redirect(302, "http://" + "y".repeat(400) + ":notaport") });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    if (r.ok || r.failure.kind !== "malformed_location") throw new Error(JSON.stringify(r));
    expect(r.failure.location).toHaveLength(200);
    expect(r.failure.location.startsWith("http://yyyy")).toBe(true);
  });

  it("lets a fetch rejection (abort, network error) propagate to the caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }),
    );

    await expect(fetchWithManualRedirects(new URL("https://example.com/a"), {}, base)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("logRedirectFailure", () => {
  it("writes one console.error line: a fixed prefix and JSON, with the start URL cut to origin and path", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const nasty = "http://bad" + String.fromCharCode(1) + '"quote\nbreak';

    logRedirectFailure("executor", new URL("https://example.com/search?q=private#h"), {
      kind: "malformed_location",
      location: nasty,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]).toHaveLength(1);
    const line = spy.mock.calls[0]![0] as string;
    expect(line.startsWith("cf-webmcp: executor refused an origin redirect: {")).toBe(true);
    expect([...line].some((ch) => ch.charCodeAt(0) < 0x20)).toBe(false);
    expect(line).not.toContain("private");
    expect(JSON.parse(line.slice(line.indexOf("{")))).toEqual({
      start: "https://example.com/search",
      kind: "malformed_location",
      location: nasty,
    });
    spy.mockRestore();
  });
});
