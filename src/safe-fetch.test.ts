import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithManualRedirects, MAX_REDIRECT_HOPS } from "./safe-fetch";

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

    // The refused origin carries no path or query, so a Location cannot smuggle text into the message.
    expect(r).toEqual({ ok: false, failure: { kind: "off_list", origin: "https://evil.example:8443", redirected: true } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names the scheme when the redirect target has an opaque origin", async () => {
    stubFetch({ "https://example.com/a": () => redirect(302, "data:text/html,hi") });

    const r = await fetchWithManualRedirects(new URL("https://example.com/a"), {}, base);

    expect(r).toEqual({ ok: false, failure: { kind: "off_list", origin: "data:", redirected: true } });
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

  it("drops content-type and content-length (any case) when a 301/302/303 turns the request into a GET", async () => {
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
    expect(first![1].headers["Content-Type"]).toBe("application/json");
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
