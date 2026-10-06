import { describe, expect, it } from "vitest";
import { REDACTED, redactEnvelope, redactingStream, redactResponse, redactText } from "./redact";
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

/** `bytes` through redactingStream in pieces of `chunkSize` bytes (0: one piece), and how long that took. */
async function throughStream(bytes: Uint8Array, chunkSize: number, secret: string): Promise<{ ms: number; out: Uint8Array }> {
  const pieces: Uint8Array[] = [];
  if (chunkSize === 0) pieces.push(bytes);
  else for (let at = 0; at < bytes.byteLength; at += chunkSize) pieces.push(bytes.subarray(at, at + chunkSize));
  const start = performance.now();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of pieces) controller.enqueue(p);
      controller.close();
    },
  });
  const out = new Uint8Array(await new Response(body.pipeThrough(redactingStream(secret))).arrayBuffer());
  return { ms: performance.now() - start, out };
}

/**
 * The replacement as the stream defines it, the slow and obvious way: from the left, at every
 * position the longest form that starts there is replaced, and the scan goes on after it.
 */
function referenceRedact(text: string, secret: string): string {
  const escaped = JSON.stringify(secret).slice(1, -1);
  const forms = escaped === secret ? [secret] : [escaped, secret];
  let out = "";
  let i = 0;
  while (i < text.length) {
    const hit = forms.find((f) => text.startsWith(f, i));
    if (hit === undefined) {
      out += text[i];
      i++;
    } else {
      out += REDACTED;
      i += hit.length;
    }
  }
  return out;
}

describe("redactingStream runs in linear time", () => {
  const MIB = 1024 * 1024;

  // A token that starts with a character JSON escapes has two forms with different first bytes
  // (`"` and `\`). Searching again for the absent one at every position took 151 s for this body.
  it.each([
    ["one chunk", 0],
    ["64 KiB chunks", 64 * 1024],
  ])("a token that starts with a quote, over 1 MiB of quotes in %s: under 100 ms", async (_label, chunkSize) => {
    const secret = '"' + "k9".repeat(20);
    const body = new Uint8Array(MIB).fill(0x22);
    const { ms, out } = await throughStream(body, chunkSize, secret);
    expect(ms).toBeLessThan(100);
    // Unchanged (a byte-wise toEqual on 1 MiB takes seconds).
    expect(out.byteLength).toBe(MIB);
    expect(out.findIndex((b) => b !== 0x22)).toBe(-1);
  });

  // Every position starts a near-match that fails only at the last byte: comparing each one
  // byte by byte took 1.5 s for 2 MiB at 256 characters.
  it.each([
    ["one chunk", 0],
    ["64 KiB chunks", 64 * 1024],
  ])("2 MiB of the token's own prefix in %s: under 100 ms, and the token at the very end is found", async (_label, chunkSize) => {
    const secret = "a".repeat(255) + "b";
    const text = "a".repeat(2 * MIB) + "b";
    const { ms, out } = await throughStream(new TextEncoder().encode(text), chunkSize, secret);
    expect(ms).toBeLessThan(100);
    expect(new TextDecoder().decode(out)).toBe("a".repeat(2 * MIB - 255) + REDACTED);
  });
});

describe("redactingStream: a token JSON escapes, split everywhere", () => {
  // Two forms of different lengths; for the last two, both forms start with the same byte.
  it.each([
    ["a quote inside", 'tok"en-0123456789abcdef'],
    ["a quote first", '"token-0123456789abcdef'],
    ["a backslash first", "\\token-0123456789abcdef"],
    ["two backslashes first, the forms overlap", "\\\\tok-0123456789abcdef"],
    ["a control character", "tok\nen-0123456789abcdef"],
    // The only token whose two forms can start at the same byte: the literal one is a prefix of
    // the escaped one, and there the longer must win.
    ["only backslashes", "\\".repeat(16)],
  ])("%s: every 2-way and 3-way split gives what one chunk gives", async (_label, secret) => {
    const escaped = JSON.stringify(secret).slice(1, -1);
    expect(escaped).not.toBe(secret);
    const text = `<${secret}|${escaped}${secret}${escaped}${escaped.slice(0, 5)}${secret.slice(0, 7)}>`;
    const expected = referenceRedact(text, secret);
    expect(expected).not.toContain(secret);
    expect(expected).not.toContain(escaped);
    const bytes = new TextEncoder().encode(text);
    const run = async (pieces: Uint8Array[]) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const p of pieces) controller.enqueue(p);
          controller.close();
        },
      });
      return new Response(body.pipeThrough(redactingStream(secret))).text();
    };
    expect(await run([bytes])).toBe(expected);
    expect(await run(Array.from(bytes, (b) => new Uint8Array([b])))).toBe(expected);
    for (let i = 0; i <= bytes.length; i++) {
      expect(await run([bytes.slice(0, i), bytes.slice(i)]), `split at ${i}`).toBe(expected);
      for (let j = i; j <= bytes.length; j++) {
        const out = await run([bytes.slice(0, i), bytes.slice(i, j), bytes.slice(j)]);
        if (out !== expected) expect(out, `split at ${i} and ${j}`).toBe(expected);
      }
    }
  });
});

describe("redactingStream agrees with the reference on random bodies and random chunk splits", () => {
  it("3,000 cases over an alphabet of a, b, quote and backslash", async () => {
    // A fixed linear congruential generator, so a failure names a case that can be replayed.
    let seed = 0x2f6b1d;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const alphabet = ["a", "b", '"', "\\"];
    const pick = (len: number) => Array.from({ length: len }, () => alphabet[rand(alphabet.length)]).join("");
    for (let c = 0; c < 3000; c++) {
      const secret = pick(16 + rand(5));
      const escaped = JSON.stringify(secret).slice(1, -1);
      const parts: string[] = [];
      for (let p = rand(8); p >= 0; p--) {
        const kind = rand(5);
        if (kind === 0) parts.push(secret);
        else if (kind === 1) parts.push(escaped);
        else if (kind === 2) parts.push(secret.slice(0, rand(secret.length)));
        else if (kind === 3) parts.push(escaped.slice(rand(escaped.length)));
        else parts.push(pick(rand(6)));
      }
      const text = parts.join("");
      const bytes = new TextEncoder().encode(text);
      const cuts = Array.from({ length: rand(5) }, () => rand(bytes.length + 1)).sort((x, y) => x - y);
      const pieces: Uint8Array[] = [];
      let from = 0;
      for (const cut of cuts) {
        pieces.push(bytes.slice(from, cut));
        from = cut;
      }
      pieces.push(bytes.slice(from));
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const p of pieces) controller.enqueue(p);
          controller.close();
        },
      });
      const out = await new Response(body.pipeThrough(redactingStream(secret))).text();
      expect(out, `case ${c}: ${JSON.stringify({ secret, text, cuts })}`).toBe(referenceRedact(text, secret));
    }
  });
});
