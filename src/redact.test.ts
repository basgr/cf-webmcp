import { describe, expect, it } from "vitest";
import { REDACTED, redactEnvelope, redactResponse, redactText } from "./redact";
import type { Envelope } from "./envelope";

const TOKEN = "SECRET-DEPLOY-TOKEN-0123456789";

describe("redactText", () => {
  it("replaces every occurrence of the token", () => {
    expect(redactText(`a ${TOKEN} b ${TOKEN}${TOKEN}`, TOKEN)).toBe(`a ${REDACTED} b ${REDACTED}${REDACTED}`);
  });

  it("replaces the form JSON writes inside a string too, for a token with characters JSON escapes", () => {
    const token = 'tok"en\\x';
    const json = JSON.stringify({ echoed: token });
    expect(json).not.toContain(token);
    expect(redactText(json, token)).toBe(JSON.stringify({ echoed: REDACTED }));
  });

  it("changes nothing when there is no token", () => {
    expect(redactText("a [redacted] b", "")).toBe("a [redacted] b");
  });
});

describe("redactEnvelope", () => {
  it("replaces the token anywhere in the envelope, keys and nested values included", () => {
    const envelope: Envelope = { ok: true, data: { body: `x-token: ${TOKEN}`, list: [TOKEN], [TOKEN]: 1 } };
    const out = redactEnvelope(envelope, TOKEN);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out).toEqual({ ok: true, data: { body: `x-token: ${REDACTED}`, list: [REDACTED], [REDACTED]: 1 } });
  });

  it("replaces it in an error message", () => {
    const out = redactEnvelope({ ok: false, error: { code: "internal", message: `failed with ${TOKEN}`, retriable: false } }, TOKEN);
    expect(out).toEqual({ ok: false, error: { code: "internal", message: `failed with ${REDACTED}`, retriable: false } });
  });

  it("returns the envelope itself when there is no token or nothing to replace", () => {
    const envelope: Envelope = { ok: true, data: { body: "plain" } };
    expect(redactEnvelope(envelope, "")).toBe(envelope);
    expect(redactEnvelope(envelope, TOKEN)).toBe(envelope);
  });

  it("answers a fixed internal error when replacing would break the JSON (a token made of JSON syntax)", () => {
    const out = redactEnvelope({ ok: true, data: { a: 1 } }, '":');
    expect(out).toEqual({ ok: false, error: { code: "internal", message: "the tool's answer could not be returned", retriable: false } });
  });
});

/** A body that arrives in the given pieces. */
function chunked(pieces: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

describe("redactResponse", () => {
  it("replaces the token in the body wherever the chunks split it", async () => {
    const text = `head ${TOKEN} middle ${TOKEN}tail`;
    for (let a = 0; a <= text.length; a++) {
      for (const b of [a, Math.min(text.length, a + 3), Math.min(text.length, a + TOKEN.length)]) {
        const pieces = [text.slice(0, a), text.slice(a, b), text.slice(b)];
        const res = redactResponse(new Response(chunked(pieces), { status: 200 }), TOKEN);
        expect(await res.text(), `split at ${a} and ${b}`).toBe(`head ${REDACTED} middle ${REDACTED}tail`);
      }
    }
  });

  it("passes a body without the token through byte for byte, a non-UTF-8 one included", async () => {
    const bytes = new Uint8Array([0xff, 0x00, 0x53, 0x45, 0xfe, 0x0a]);
    const res = redactResponse(new Response(bytes, { status: 200 }), TOKEN);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("finds a token that ends the body", async () => {
    const res = redactResponse(new Response(chunked(["abc", TOKEN.slice(0, 5), TOKEN.slice(5)])), TOKEN);
    expect(await res.text()).toBe(`abc${REDACTED}`);
  });

  it("drops every header whose value holds the token, keeps the rest, the status and the status text", async () => {
    const res = redactResponse(
      new Response("body", {
        status: 503,
        statusText: "Busy",
        headers: { "x-echo": `token=${TOKEN}`, "content-type": "text/plain", "x-other": "kept", "content-length": "4" },
      }),
      TOKEN,
    );
    expect(res.status).toBe(503);
    expect(res.statusText).toBe("Busy");
    expect(res.headers.get("x-echo")).toBeNull();
    expect(res.headers.get("x-other")).toBe("kept");
    expect(res.headers.get("content-type")).toBe("text/plain");
    // The body can change length, so origin's Content-Length cannot stay.
    expect(res.headers.get("content-length")).toBeNull();
    expect(await res.text()).toBe("body");
  });

  it("keeps a body-less answer body-less", async () => {
    const res = redactResponse(new Response(null, { status: 301, headers: { location: `https://example.com/?t=${TOKEN}` } }), TOKEN);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBeNull();
    expect(res.body).toBeNull();
  });

  it("returns the response itself when there is no token", () => {
    const res = new Response("x", { headers: { "x-echo": "a" } });
    expect(redactResponse(res, "")).toBe(res);
  });
});
