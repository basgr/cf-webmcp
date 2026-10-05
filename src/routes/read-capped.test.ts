import { describe, expect, it } from "vitest";
import {
  MERGE_MAX_BYTES,
  ORIGIN_FAILURE_CACHE_CONTROL,
  declaredLength,
  readCapped,
  readTextCapped,
} from "./read-capped";

const ENC = new TextEncoder();
const MIB = 1024 * 1024;

/** `total` bytes in chunks of `chunk` bytes (each `fill`), failing once `failAfter` bytes were sent. */
function stream(total: number, opts: { chunk?: number; fill?: number; failAfter?: number } = {}): ReadableStream<Uint8Array> {
  const chunk = opts.chunk ?? 64 * 1024;
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
      const n = Math.min(chunk, total - sent);
      controller.enqueue(new Uint8Array(n).fill(opts.fill ?? 0x61));
      sent += n;
    },
  });
}

const readAll = async (s: ReadableStream<Uint8Array>): Promise<number> => {
  const reader = s.getReader();
  let n = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) return n;
    n += r.value.byteLength;
  }
};

describe("the shared limits", () => {
  it("cap merged origin bodies at 1 MiB and serve a stand-in for 60 seconds", () => {
    expect(MERGE_MAX_BYTES).toBe(MIB);
    expect(ORIGIN_FAILURE_CACHE_CONTROL).toBe("public, max-age=60, s-maxage=60");
  });
});

describe("declaredLength", () => {
  it("reads Content-Length, and is 0 when it is missing or not a number", () => {
    expect(declaredLength(new Response("x", { headers: { "content-length": "123" } }))).toBe(123);
    expect(declaredLength(new Response("x", { headers: { "content-length": " 77 " } }))).toBe(77);
    expect(declaredLength(new Response(null, { status: 200 }))).toBe(0);
    for (const bad of ["abc", "-5", "1e9", "12 34", ""]) {
      expect(declaredLength(new Response("x", { headers: { "content-length": bad } })), bad).toBe(0);
    }
  });
});

describe("readCapped", () => {
  it("returns the bytes of a body at or under the limit", async () => {
    const r = await readCapped(stream(1000, { chunk: 300 }), 1000);
    expect(r.kind).toBe("bytes");
    if (r.kind === "bytes") expect(r.bytes.byteLength).toBe(1000);
  });

  it("treats no body as an empty one", async () => {
    const r = await readCapped(null, 10);
    expect(r).toEqual({ kind: "bytes", bytes: new Uint8Array(0) });
  });

  it("past the limit stops reading and hands back a stream of every byte, read and unread", async () => {
    const r = await readCapped(stream(5000, { chunk: 100 }), 1000);
    expect(r.kind).toBe("too_large");
    if (r.kind === "too_large") expect(await readAll(r.rest)).toBe(5000);
  });

  it("does not pull the rest of an endless body before it says too large", async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1024));
      },
    });
    const r = await readCapped(endless, 10 * 1024);
    expect(r.kind).toBe("too_large");
    // 10 KiB of cap, 1 KiB chunks: stopped just past it, with at most a little read-ahead.
    expect(pulls).toBeLessThan(40);
    if (r.kind === "too_large") await r.rest.cancel();
  });

  it("throws when the body fails before the limit", async () => {
    await expect(readCapped(stream(10_000, { chunk: 1000, failAfter: 3000 }), 1_000_000)).rejects.toThrow("connection reset");
  });

  it("the relayed stream errors when the rest of the body fails", async () => {
    const r = await readCapped(stream(10_000, { chunk: 1000, failAfter: 5000 }), 1500);
    expect(r.kind).toBe("too_large");
    if (r.kind === "too_large") await expect(readAll(r.rest)).rejects.toThrow("connection reset");
  });
});

describe("readTextCapped", () => {
  it("decodes a body under the cap as UTF-8 text, dropping a byte order mark like Response.text()", async () => {
    const body = new Uint8Array([0xef, 0xbb, 0xbf, ...ENC.encode("héllo ✓")]);
    const r = await readTextCapped(new Response(body, { headers: { "content-type": "text/plain" } }));
    expect(r).toEqual({ kind: "text", text: "héllo ✓" });
    expect(await new Response(body).text()).toBe("héllo ✓");
  });

  it("reads an empty body as empty text", async () => {
    expect(await readTextCapped(new Response(null, { status: 200 }))).toEqual({ kind: "text", text: "" });
  });

  it("takes a body of exactly the cap", async () => {
    const r = await readTextCapped(new Response(stream(MIB)));
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.text.length).toBe(MIB);
  });

  it("relays a body over the cap by its Content-Length without reading it", async () => {
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled = true;
        c.enqueue(new Uint8Array(10));
      },
    }, { highWaterMark: 0 });
    const upstream = new Response(body, { status: 200, headers: { "content-type": "text/plain", "content-length": String(MIB + 1) } });
    const r = await readTextCapped(upstream);
    expect(r.kind).toBe("relay");
    if (r.kind === "relay") expect(r.upstream).toBe(upstream);
    expect(pulled).toBe(false);
  });

  it("relays a body over the cap that carries no Content-Length, every byte, with origin's status and headers", async () => {
    const upstream = new Response(stream(MIB + 100_000), {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/plain; charset=utf-8", "x-origin": "yes" },
    });
    const r = await readTextCapped(upstream);
    expect(r.kind).toBe("relay");
    if (r.kind === "relay") {
      expect(r.upstream.status).toBe(200);
      expect(r.upstream.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(r.upstream.headers.get("x-origin")).toBe("yes");
      expect(new Uint8Array(await r.upstream.arrayBuffer()).byteLength).toBe(MIB + 100_000);
    }
  });

  it("reports a body that fails before the cap, and does not throw", async () => {
    const r = await readTextCapped(new Response(stream(10 * 64 * 1024, { failAfter: 2 * 64 * 1024 })));
    expect(r).toEqual({ kind: "failed" });
  });

  it("takes the cap as an argument", async () => {
    expect((await readTextCapped(new Response("0123456789"), 10)).kind).toBe("text");
    expect((await readTextCapped(new Response("0123456789a"), 10)).kind).toBe("relay");
  });
});
