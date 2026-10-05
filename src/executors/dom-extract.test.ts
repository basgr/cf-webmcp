import { afterEach, describe, expect, it, vi } from "vitest";
import { runDomExtract, type DomExtractConfig } from "./dom-extract";
import type { ExecutorContext } from "./common";

const ctx: ExecutorContext = {
  allowedOrigins: ["https://example.com"],
  deployToken: "",
  timeoutMs: 1000,
  version: "0.0.0-test",
};

const config: DomExtractConfig = {
  url_template: "https://example.com/page",
  selector: "main",
  strip: ["nav", "script"],
  max_chars: 8000,
};

function stubPage(html: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("runDomExtract", () => {
  it("extracts the text of the selected region and strips noise tags", async () => {
    stubPage(
      "<html><body><nav>menu</nav><main>Hello <b>big</b> world<script>var x = 1;</script></main><footer>f</footer></body></html>",
    );

    const r = await runDomExtract(ctx, config, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.text).toBe("Hello big world");
    expect(r.data.truncated).toBe(false);
  });

  it("keeps the text after a nested <article> inside <main>", async () => {
    stubPage("<html><body><main>Intro <article>Nested story</article> Outro</main><footer>f</footer></body></html>");

    const r = await runDomExtract(ctx, { ...config, selector: "main, article, [role=main]" }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.text).toBe("Intro Nested story Outro");
  });

  it("keeps the text after any nested element the selector also matches, at every depth", async () => {
    stubPage("<html><body><section>a<section>b<section>c</section>d</section>e</section>f</body></html>");

    const r = await runDomExtract(ctx, { ...config, selector: "section" }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    // "f" is outside the outermost match.
    expect(r.data.text).toBe("abcde");
  });

  it("stops at the end of the outermost match, and starts again at the next one", async () => {
    stubPage("<html><body>x<main>a<article>b</article>c</main>y<article>d</article>z</body></html>");

    const r = await runDomExtract(ctx, { ...config, selector: "main, article" }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.text).toBe("abcd");
  });

  it("does not throw on void tags in strip, and keeps the text after them", async () => {
    stubPage(
      '<html><body><main>Hello<br>world <img src="x.png"> and <input type="text"> more<hr> end</main></body></html>',
    );

    const r = await runDomExtract(ctx, { ...config, strip: ["img", "br", "input", "hr", "nav"] }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.text).toBe("Helloworld and more end");
  });

  it("still strips the content of a non-void tag listed next to void ones", async () => {
    stubPage("<html><body><main>a<br>b<nav>menu</nav>c<img src=x>d</main></body></html>");

    const r = await runDomExtract(ctx, { ...config, strip: ["br", "nav", "img"] }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.text).toBe("abcd");
  });

  it("clamps to max_chars and reports truncation", async () => {
    stubPage(`<html><body><main>${"word ".repeat(200)}</main></body></html>`);

    const r = await runDomExtract(ctx, { ...config, max_chars: 50 }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.truncated).toBe(true);
    expect(r.data.text.length).toBeLessThanOrEqual(50);
    expect(r.data.text.startsWith("word word")).toBe(true);
  });

  it("stops reading a very large page once max_chars is reached", async () => {
    let pulls = 0;
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        if (pulls === 1) return c.enqueue(enc.encode("<html><body><main>"));
        if (pulls > 5000) return c.close();
        c.enqueue(enc.encode("lorem ipsum dolor sit amet ".repeat(40)));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })),
    );

    const r = await runDomExtract(ctx, { ...config, max_chars: 200 }, {});

    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(r.data.truncated).toBe(true);
    expect(pulls).toBeLessThan(500);
  });

  it("returns a timeout error when the run-wide signal aborts a stalled body", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("<html><body><main>partial"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/html" } })),
    );
    setTimeout(() => controller.abort(), 30);

    const r = await runDomExtract({ ...ctx, signal: controller.signal }, config, {});

    if (r.ok) throw new Error("expected error");
    expect(r.error.code).toBe("timeout");
  });
});
