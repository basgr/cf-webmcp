import { describe, it, expect } from "vitest";
import { aiCatalogResponse, ardRedirect } from "./ai-catalog";
import type { Config } from "../config-types";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    schema_version: 1,
    site: {
      domain: "example.com",
      name: "Example",
      description: "desc",
      locale: "en",
      public_url: "https://example.com",
    },
    origin: { base_url: "https://example.com", allowed_origins: ["https://example.com"], forward_cookies: false },
    features: {
      inject_html: true,
      webmcp_landing: true,
      manifest: true,
      link_header: true,
      link_tag: true,
      llms_txt: true,
      robots_txt: true,
      agents_md: true,
      api_catalog: true,
      ai_catalog: true,
      agent_skills: true,
      agent_skills_index: true,
      subresource_integrity: true,
      fallback_widget: true,
    },
    manifest: { path: "/.well-known/webmcp.json", aliases: ["/.well-known/webmcp"] },
    webmcp_landing: { path: "/mcp" },
    llms_txt: { path: "/llms.txt", mode: "merge" },
    robots_txt: { path: "/robots.txt", mode: "merge" },
    agents_md: { path: "/.well-known/agents.md", mode: "merge", aliases: ["/AGENTS.md", "/agents.md"] },
    api_catalog: { path: "/.well-known/api-catalog", mode: "merge" },
    ai_catalog: { path: "/.well-known/ard.json", aliases: ["/.well-known/ai-catalog.json"], mode: "synthesize", skill_type: "application/ai-skill+md", host_identifier: "", representative_queries: [], tags: [] },
    agent_skills: { path: "/.well-known/agent-skills/site/SKILL.md", mode: "synthesize", name: "", description: "", aliases: ["/.well-known/agent-skills/site/SKILLS.md", "/.well-known/agent-skills/site/skill.md", "/.well-known/agent-skills/site/skills.md"], hints: [] },
    agent_skills_index: { path: "/.well-known/agent-skills/index.json", mode: "synthesize" },
    origin_trial: { tokens: [] },
    paths: { namespace: "/_webmcp" },
    injection: { exclude_paths: [] },
    cache: {
      manifest_max_age: 300,
      manifest_s_maxage: 86400,
      manifest_swr: 604800,
      manifest_sie: 86400,
      landing_max_age: 300,
      landing_s_maxage: 86400,
      landing_swr: 86400,
      landing_sie: 86400,
      llms_txt_max_age: 300,
      llms_txt_s_maxage: 3600,
      llms_txt_swr: 86400,
      llms_txt_sie: 86400,
      robots_txt_max_age: 300,
      robots_txt_s_maxage: 3600,
      robots_txt_swr: 86400,
      robots_txt_sie: 86400,
      agents_md_max_age: 300,
      agents_md_s_maxage: 21600,
      agents_md_swr: 86400,
      agents_md_sie: 86400,
      agents_md_redirect_max_age: 86400,
      agents_md_redirect_s_maxage: 604800,
      api_catalog_max_age: 300,
      api_catalog_s_maxage: 21600,
      api_catalog_swr: 86400,
      api_catalog_sie: 86400,
      ai_catalog_max_age: 300,
      ai_catalog_s_maxage: 21600,
      ai_catalog_swr: 86400,
      ai_catalog_sie: 86400,
      agent_skills_max_age: 300,
      agent_skills_s_maxage: 21600,
      agent_skills_swr: 86400,
      agent_skills_sie: 86400,
      agent_skills_redirect_max_age: 86400,
      agent_skills_redirect_s_maxage: 604800,
      agent_skills_index_max_age: 300,
      agent_skills_index_s_maxage: 21600,
      agent_skills_index_swr: 86400,
      agent_skills_index_sie: 86400,
      bootstrap_max_age: 31536000,
      widget_max_age: 31536000,
      executor_defaults: { max_age: 0, s_maxage: 300, swr: 1800, sie: 86400 },
    },
    cors: { allowed_origins: [] },
    health: { public: true, token: "" },
    dev: { origin: "http://localhost:8080" },
    rate_limit: { requests_per_minute_per_ip: 60 },
    tools: [
      {
        name: "search_pages",
        description: "Search.",
        input_schema: { type: "object", required: [], properties: {} },
        executor: { type: "sitemap_filter", sitemap_url: "https://example.com/sitemap.xml", max_results: 20 },
      },
    ],
    forms: [],
    ...overrides,
  };
}

const cfg = makeConfig();

const SYNTH_BODY =
  JSON.stringify({ host: { displayName: "Example", identifier: "did:web:example.com" }, entries: [] }, null, 2) + "\n";

const noProxy = async () => new Response(null, { status: 404 });

const JSON_UTF8 = "application/json; charset=utf-8";

describe("aiCatalogResponse (synthesize)", () => {
  it("serves the ARD manifest as application/json with CORS, noindex and nosniff", async () => {
    const res = await aiCatalogResponse(
      new Request("https://example.com/.well-known/ard.json"),
      cfg,
      SYNTH_BODY,
      noProxy,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe(SYNTH_BODY);
  });

  it("sets correct cache-control header", async () => {
    const res = await aiCatalogResponse(
      new Request("https://example.com/.well-known/ard.json"),
      cfg,
      SYNTH_BODY,
      noProxy,
    );
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=300");
    expect(cc).toContain("s-maxage=21600");
    expect(cc).toContain("stale-while-revalidate=86400");
  });

  it("returns exactly the synthesized body as-is and never asks origin", async () => {
    const body = '{"entries":[],"host":{"displayName":"Test"}}\n';
    const asked: string[] = [];
    const res = await aiCatalogResponse(
      new Request("https://example.com/.well-known/ard.json"),
      cfg,
      body,
      async (u) => {
        asked.push(u.toString());
        return new Response(null, { status: 404 });
      },
    );
    expect(await res.text()).toBe(body);
    expect(asked).toEqual([]);
  });
});

describe("ardRedirect", () => {
  it("301s an alias to the canonical path with CORS, noindex and the ARD cache settings", () => {
    const res = ardRedirect(cfg);
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/.well-known/ard.json");
    // A browser follows a cross-origin redirect only when the redirect itself passes CORS.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=300");
    expect(cc).toContain("s-maxage=21600");
  });

  it("points at a custom canonical path", () => {
    const res = ardRedirect(makeConfig({ ai_catalog: { ...cfg.ai_catalog, path: "/.well-known/agents/ard.json" } }));
    expect(res.headers.get("location")).toBe("/.well-known/agents/ard.json");
  });
});

const OUR_ID = "urn:air:example.com:skill:example";

const SYNTH_ONE = JSON.stringify(
  { host: { displayName: "Example", identifier: "did:web:example.com" },
    entries: [{ identifier: OUR_ID, displayName: "Example", type: "application/ai-skill+md", url: "https://example.com/.well-known/agent-skills/site/SKILL.md" }] },
  null, 2) + "\n";

const OTHER = { identifier: "urn:air:example.com:agent:other", displayName: "Other", type: "application/a2a-agent-card+json", url: "https://example.com/a.json" };

const originDoc = (entries: unknown[], ct = "application/json") =>
  new Response(JSON.stringify({ host: { displayName: "O", identifier: "did:web:example.com" }, entries }), { status: 200, headers: { "content-type": ct } });

const req = new Request("https://example.com/.well-known/ard.json");

const CANONICAL = "https://example.com/.well-known/ard.json";
const PREDECESSOR = "https://example.com/.well-known/ai-catalog.json";

/** A proxy answering by URL (404 for anything not listed) that records what was asked. */
function originBy(answers: Record<string, () => Response>) {
  const asked: string[] = [];
  const proxy = async (u: URL) => {
    asked.push(u.toString());
    const answer = answers[u.toString()];
    return answer ? answer() : new Response("not found", { status: 404 });
  };
  return { proxy, asked };
}

describe("aiCatalogResponse (merge)", () => {
  const cfgMerge = { ...cfg, ai_catalog: { ...cfg.ai_catalog, mode: "merge" as const } };

  it("appends our entry to a valid origin document and is idempotent", async () => {
    const res1 = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => originDoc([OTHER]));
    expect(res1.status).toBe(200);
    expect(res1.headers.get("content-type")).toBe(JSON_UTF8);
    expect(res1.headers.get("access-control-allow-origin")).toBe("*");
    expect(res1.headers.get("x-robots-tag")).toBe("noindex");
    const body1 = await res1.text();
    const doc = JSON.parse(body1);
    expect(doc.entries.map((e: { identifier: string }) => e.identifier)).toEqual([OTHER.identifier, OUR_ID]);
    // Origin's other members stay as they were; nothing is added at the top level.
    expect(doc.host).toEqual({ displayName: "O", identifier: "did:web:example.com" });
    expect(Object.keys(doc).sort()).toEqual(["entries", "host"]);
    // Idempotent: feed our own output back as the origin -> byte identical.
    const res2 = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
      new Response(body1, { status: 200, headers: { "content-type": "application/json" } }));
    expect(await res2.text()).toBe(body1);
  });

  it("keeps origin's entry when it already has our identifier, and does not duplicate it", async () => {
    const theirs = { identifier: OUR_ID, displayName: "Their own skill", type: "application/ai-skill+md", url: "https://example.com/theirs/SKILL.md" };
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => originDoc([theirs, OTHER]));
    const doc = JSON.parse(await res.text());
    expect(doc.entries).toHaveLength(2);
    expect(doc.entries[0]).toEqual(theirs);
    expect(doc.entries[1]).toEqual(OTHER);
  });

  it("keeps a valid origin document when we have no entry to add (agent_skills off)", async () => {
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_BODY, async () => originDoc([OTHER]));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    expect(JSON.parse(await res.text()).entries).toEqual([OTHER]);
  });

  it("accepts the predecessor's application/ai-catalog+json and a missing content type", async () => {
    for (const ct of ["application/ai-catalog+json", ""]) {
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => {
        const r = originDoc([OTHER]);
        const headers = new Headers(r.headers);
        if (ct) headers.set("content-type", ct);
        else headers.delete("content-type");
        // Bytes, not a string: a string body would get a default text/plain content type.
        const res = new Response(new TextEncoder().encode(await r.text()), { status: 200, headers });
        expect(res.headers.get("content-type")).toBe(ct || null);
        return res;
      });
      expect(JSON.parse(await res.text()).entries, ct || "(none)").toHaveLength(2);
    }
  });

  it("falls back to origin's predecessor path when the canonical path is 404, and merges that document", async () => {
    const { proxy, asked } = originBy({ [PREDECESSOR]: () => originDoc([OTHER], "application/ai-catalog+json") });
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, proxy);
    expect(asked).toEqual([CANONICAL, PREDECESSOR]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    const ids = JSON.parse(await res.text()).entries.map((e: { identifier: string }) => e.identifier);
    expect(ids).toEqual([OTHER.identifier, OUR_ID]);
  });

  it("serves the generated document when both the canonical and the predecessor path are 404", async () => {
    const { proxy, asked } = originBy({});
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, proxy);
    expect(asked).toEqual([CANONICAL, PREDECESSOR]);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    expect(await res.text()).toBe(SYNTH_ONE);
  });

  it("asks origin once when the configured path is the predecessor path itself", async () => {
    const cfgOld = { ...cfgMerge, ai_catalog: { ...cfgMerge.ai_catalog, path: "/.well-known/ai-catalog.json", aliases: [] } };
    const { proxy, asked } = originBy({});
    const res = await aiCatalogResponse(new Request(PREDECESSOR), cfgOld, SYNTH_ONE, proxy);
    expect(asked).toEqual([PREDECESSOR]);
    expect(await res.text()).toBe(SYNTH_ONE);
  });

  it("does not consult the predecessor path when the canonical path answers anything but 404", async () => {
    for (const answer of [() => originDoc([OTHER]), () => new Response("boom", { status: 500 })]) {
      const { proxy, asked } = originBy({ [CANONICAL]: answer, [PREDECESSOR]: () => originDoc([]) });
      await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, proxy);
      expect(asked).toEqual([CANONICAL]);
    }
  });

  it.each([
    { name: "unparseable JSON", body: "not json" },
    { name: "an entry without a string identifier", body: JSON.stringify({ entries: [{ noId: true }] }) },
    { name: "no entries array", body: JSON.stringify({ specVersion: "1.0", host: { displayName: "O" } }) },
    { name: "a top-level array", body: JSON.stringify([{ identifier: "a" }]) },
  ])("relays an origin JSON document that fails the structural check unchanged, with noindex ($name)", async ({ body }) => {
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json", "x-origin": "1" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-origin")).toBe("1");
    expect(await res.text()).toBe(body);
  });

  it("applies the same rules to the predecessor document: invalid JSON or HTML is relayed, a 5xx gets the generated document", async () => {
    const invalid = originBy({ [PREDECESSOR]: () => new Response('{"entries":{}}', { status: 200, headers: { "content-type": "application/json" } }) });
    const r1 = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, invalid.proxy);
    expect(r1.headers.get("x-robots-tag")).toBe("noindex");
    expect(await r1.text()).toBe('{"entries":{}}');

    const html = originBy({ [PREDECESSOR]: () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) });
    const r2 = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, html.proxy);
    expect(r2.headers.get("content-type")).toBe("text/html");
    expect(r2.headers.get("x-robots-tag")).toBe("noindex");

    const failed = originBy({ [PREDECESSOR]: () => new Response("boom", { status: 503 }) });
    const r3 = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, failed.proxy);
    expect(r3.status).toBe(200);
    expect(await r3.text()).toBe(SYNTH_ONE);
  });

  it.each([
    { name: "a relayed redirect", response: () => new Response(null, { status: 301, headers: { location: "https://www.example.com/x" } }) },
    { name: "a 403", response: () => new Response("no", { status: 403 }) },
    { name: "a 500", response: () => new Response("boom", { status: 500 }) },
    { name: "a 502 from the proxy helper", response: () => new Response("origin request failed", { status: 502 }) },
    { name: "a 504 from the proxy helper", response: () => new Response("origin did not answer in time", { status: 504 }) },
  ])("serves the generated document, not the origin answer, after $name", async ({ response }) => {
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => response());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(JSON_UTF8);
    expect(await res.text()).toBe(SYNTH_ONE);
  });

  it("relays a 200 that is not JSON unchanged, with noindex", async () => {
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
      new Response("<html>hi</html>", { status: 200, headers: { "content-type": "text/html" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(await res.text()).toBe("<html>hi</html>");
  });

  it("does not add our entry when origin lists an entry with our url under another identifier", async () => {
    const sameUrl = { identifier: "urn:air:example.com:skill:their-name", displayName: "Theirs", type: "application/ai-skill+md", url: "https://example.com/.well-known/agent-skills/site/SKILL.md" };
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => originDoc([sameUrl, OTHER]));
    const doc = JSON.parse(await res.text());
    expect(doc.entries).toEqual([sameUrl, OTHER]);
  });

  it("adds our entry next to an origin entry that has neither our identifier nor our url", async () => {
    const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => originDoc([OTHER, { identifier: "urn:air:example.com:data:x", data: {} }]));
    const ids = JSON.parse(await res.text()).entries.map((e: { identifier: string }) => e.identifier);
    expect(ids).toEqual([OTHER.identifier, "urn:air:example.com:data:x", OUR_ID]);
  });

  describe("cache-control of the generated document", () => {
    const SHORT = "public, max-age=60, s-maxage=60";
    const NORMAL = "public, max-age=300, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=86400";

    it.each<{ name: string; answers: Record<string, () => Response> }>([
      { name: "a 500 at the canonical path", answers: { [CANONICAL]: () => new Response("boom", { status: 500 }) } },
      { name: "a relayed redirect", answers: { [CANONICAL]: () => new Response(null, { status: 302, headers: { location: "https://www.example.com/x" } }) } },
      { name: "the proxy's 502", answers: { [CANONICAL]: () => new Response("origin request failed", { status: 502 }) } },
      { name: "the proxy's 504", answers: { [CANONICAL]: () => new Response("origin did not answer in time", { status: 504 }) } },
      { name: "a 410", answers: { [CANONICAL]: () => new Response("gone", { status: 410 }) } },
      { name: "a 503 at the predecessor after a canonical 404", answers: { [PREDECESSOR]: () => new Response("boom", { status: 503 }) } },
    ])("is short after $name (origin failed)", async ({ answers }) => {
      const { proxy } = originBy(answers);
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, proxy);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SYNTH_ONE);
      expect(res.headers.get("cache-control")).toBe(SHORT);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("is the normal one after a 404 at both paths (origin has no manifest)", async () => {
      const { proxy } = originBy({});
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, proxy);
      expect(res.headers.get("cache-control")).toBe(NORMAL);
    });

    it("is the normal one in synthesize mode and on a merged document", async () => {
      expect((await aiCatalogResponse(req, cfg, SYNTH_ONE, noProxy)).headers.get("cache-control")).toBe(NORMAL);
      expect((await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => originDoc([OTHER]))).headers.get("cache-control")).toBe(NORMAL);
    });
  });

  describe("a relayed document keeps origin's bytes and headers", () => {
    const BOM = new Uint8Array([0xef, 0xbb, 0xbf]);
    const bytes = (text: string, bom = false) => {
      const body = new TextEncoder().encode(text);
      if (!bom) return body;
      const out = new Uint8Array(BOM.length + body.length);
      out.set(BOM, 0);
      out.set(body, BOM.length);
      return out;
    };

    it("adds no content type when origin sent none", async () => {
      const raw = bytes('{"entries":{}}');
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => {
        const r = new Response(raw, { status: 200 });
        expect(r.headers.get("content-type")).toBeNull();
        return r;
      });
      expect(res.headers.get("content-type")).toBeNull();
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(raw);
    });

    it("relays a byte order mark as it came", async () => {
      const raw = bytes('{"entries":[{"noId":true}]}', true);
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(raw, { status: 200, headers: { "content-type": "application/json" } }));
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(raw);
    });

    it("still merges a valid document that starts with a byte order mark", async () => {
      const raw = bytes(JSON.stringify({ entries: [OTHER] }), true);
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(raw, { status: 200, headers: { "content-type": "application/json" } }));
      expect(res.headers.get("content-type")).toBe(JSON_UTF8);
      const ids = JSON.parse(await res.text()).entries.map((e: { identifier: string }) => e.identifier);
      expect(ids).toEqual([OTHER.identifier, OUR_ID]);
    });

    it("merges application/ld+json and relays application/json-seq", async () => {
      const ld = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => originDoc([OTHER], "application/ld+json"));
      expect(JSON.parse(await ld.text()).entries).toHaveLength(2);
      const seq = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () => originDoc([OTHER], "application/json-seq"));
      expect(seq.headers.get("content-type")).toBe("application/json-seq");
      expect(seq.headers.get("x-robots-tag")).toBe("noindex");
    });
  });

  describe("size cap: origin documents over 1 MiB are not merged", () => {
    const MIB = 1024 * 1024;
    /** A valid ARD document padded with spaces: mergeable, if it were read. */
    const VALID_DOC = new TextEncoder().encode(JSON.stringify({ entries: [OTHER] }));
    /**
     * A stream of `total` bytes in 64 KiB chunks: the valid document, then spaces.
     * Optionally fails after `failAfter` bytes.
     */
    function stream(total: number, failAfter?: number): ReadableStream<Uint8Array> {
      let sent = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (failAfter !== undefined && sent >= failAfter) {
            controller.error(new Error("connection reset"));
            return;
          }
          if (sent >= total) {
            controller.close();
            return;
          }
          const n = Math.min(64 * 1024, total - sent);
          const chunk = new Uint8Array(n).fill(0x20);
          if (sent === 0) chunk.set(VALID_DOC.subarray(0, n), 0);
          controller.enqueue(chunk);
          sent += n;
        },
      });
    }
    async function expectRelayedUnchanged(res: Response, total: number) {
      expect(res.status).toBe(200);
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      // Origin's own content type: the document was not merged.
      expect(res.headers.get("content-type")).toBe("application/json");
      const body = new Uint8Array(await res.arrayBuffer());
      expect(body.byteLength).toBe(total);
      expect(body.subarray(0, VALID_DOC.length)).toEqual(VALID_DOC);
    }

    it("relays a body whose Content-Length is over 1 MiB unread, with noindex", async () => {
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(stream(MIB + 1), { status: 200, headers: { "content-type": "application/json", "content-length": String(MIB + 1) } }));
      await expectRelayedUnchanged(res, MIB + 1);
    });

    it("relays a body without Content-Length that turns out to be over 1 MiB, every byte of it", async () => {
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(stream(MIB + 100_000), { status: 200, headers: { "content-type": "application/json" } }));
      await expectRelayedUnchanged(res, MIB + 100_000);
    });

    it("merges a body of exactly 1 MiB", async () => {
      const doc = JSON.stringify({ entries: [OTHER] });
      const padded = doc + " ".repeat(MIB - doc.length);
      expect(new TextEncoder().encode(padded).byteLength).toBe(MIB);
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(new TextEncoder().encode(padded), { status: 200, headers: { "content-type": "application/json" } }));
      expect(res.headers.get("content-type")).toBe(JSON_UTF8);
      expect(JSON.parse(await res.text()).entries).toHaveLength(2);
    });

    it("serves the generated document with the short cache when the body fails mid-stream", async () => {
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(stream(10 * 64 * 1024, 2 * 64 * 1024), { status: 200, headers: { "content-type": "application/json" } }));
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(SYNTH_ONE);
      expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    });
  });

  it("does NOT merge when origin content-type is text/json or text/plain - relays unchanged", async () => {
    // text/json and text/plain look JSON-ish but are not application/* types.
    const jsonBody = JSON.stringify({ host: { displayName: "O" }, entries: [OTHER] });
    for (const ct of ["text/json", "text/plain"]) {
      const res = await aiCatalogResponse(req, cfgMerge, SYNTH_ONE, async () =>
        new Response(jsonBody, { status: 200, headers: { "content-type": ct } }));
      expect(res.headers.get("x-robots-tag")).toBe("noindex");
      expect(res.headers.get("content-type")).toBe(ct);
      expect(await res.text()).toBe(jsonBody);
    }
  });
});
