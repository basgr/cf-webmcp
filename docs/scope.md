# Scope

`cf-webmcp` is a Cloudflare Worker that adds **WebMCP** to a website. It is not "the agent-ready everything Worker". This page lists what's in scope and what isn't, so feature requests get clear, fast answers.

## In scope

- **WebMCP manifest** at `/.well-known/webmcp.json`
- **In-page tool registration** via injected `<script>` and `<link rel="webmcp">`
- **HTTP `Link` header** with `rel="webmcp"` on every response
- **`/mcp` landing page** for desktop MCP client pairing
- **Fallback widget** (`jasonjmcghee/WebMCP`) for desktop bridge clients
- **Five executor types** for server-side tool calls: `sitemap_filter`, `rss_feed`, `dom_extract`, `http_json`, `http_get`
- **Form attribute injection** stamping W3C declarative form attributes onto matching `<form>` elements via TOML config
- **`/llms.txt`** augmentation (merge with origin's file, marker-block idempotency)
- **`/robots.txt`** augmentation (marker-block, blocks the Worker's private namespace)
- **`/.well-known/agents.md`** publication with `/AGENTS.md` and `/agents.md` 301 aliases
- **`/.well-known/api-catalog`** ([RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html)) publication pointing at the WebMCP manifest
- **`/.well-known/agent-skills/<slug>/SKILL.md`** publication (Anthropic-format Agent Skill) with case-variant 301 aliases
- **Build-time SSRF allow-list** validation
- **Per-IP and per-tool rate limiting**
- **`/_webmcp/health`** operational endpoint

That's the surface. Each item exists because it's part of how a WebMCP-aware agent (browser-native or desktop-bridged) finds and calls tools on a publisher's site.

## Out of scope

The following are real, useful things, but they are not WebMCP and would dilute the project if bundled in. They belong elsewhere - in the publisher's CMS, in a separate Worker, or in a different project entirely.

### Alternative protocols

- **MCP server cards.** MCP is a JSON-RPC protocol distinct from WebMCP. cf-webmcp does not publish MCP server descriptors (`/.well-known/mcp/server-card.json`) and does not run a streamable HTTP MCP endpoint. Desktop MCP clients bridge into a WebMCP site via the fallback widget, which is a runtime concern, not a discovery one. Publishers running cf-webmcp *and* a separately-deployed MCP JSON-RPC endpoint at `POST /mcp` should be aware that cf-webmcp claims `GET /mcp` for its landing page by default; the two paths share a URL but differ by method. cf-webmcp's current router does not split on method, so a publisher needing both should move the landing page (`[webmcp_landing].path = "/pair"`) to free `/mcp` for the MCP JSON-RPC endpoint.
- *(Removed in v0.3.0)* ~~Agent Skills (Anthropic).~~ Originally listed as out-of-scope on the grounds that the manifest covered the same ground. Reversed in v0.3.0 after observing real-world adoption (Cloudflare Browser Run docs, isitagentready.com audits) and that the *operational hints* niche - "when to use which tool", "common pitfalls" - was not actually covered by either the structured manifest or the prose `agents.md`. cf-webmcp now publishes a `SKILL.md` at `/.well-known/agent-skills/site/SKILL.md`. See [`docs/agent-skills.md`](agent-skills.md).
- **OpenAPI / AsyncAPI generation.** The WebMCP manifest already describes our tools in a WebMCP-native shape. cf-webmcp does not project that into OpenAPI.

### Authentication

- **OAuth Authorization Server metadata (RFC 8414)**, **OAuth Protected Resource (RFC 9728)**. cf-webmcp's tools are public reads by design. Authenticated tools are out of scope. Publishers needing auth should front the Worker with their own auth layer or wait for a future cf-webmcp version that supports it.

### Bot policy

- **AI-bot UA rules in robots.txt** (`User-agent: GPTBot`, `ClaudeBot`, etc.). Publisher policy. cf-webmcp only augments robots.txt to disallow its own private namespace; it does not opine on whether GPTBot is allowed to crawl your homepage.
- **Content Signals.** Publisher content policy. Belongs in the CMS or origin.
- **Web Bot Auth.** Bot signs requests; server verifies. Server-side verification is a security policy concern, not a WebMCP discovery concern.

### Origin

- **API discovery for the publisher's other APIs.** cf-webmcp does not crawl your origin to find other APIs and add them to the catalog. If you have OpenAPI documents or other APIs, you publish them in `/.well-known/api-catalog` yourself; cf-webmcp's merge mode preserves what's there.
- **Markdown content negotiation.** If origin serves HTML, that's what gets proxied. cf-webmcp does not convert pages to Markdown on the fly.

### Commerce

- **x402, MPP, UCP, ACP, or any agentic-commerce protocol.** Distinct space. Not WebMCP.

### General-purpose stuff

- **Image transformation, A/B testing, analytics, edge auth, geo-routing.** Worth doing, not by cf-webmcp.

## How feature requests get triaged

If a proposed feature is on the **in scope** list above, file an issue and let's discuss.

If it's on the **out of scope** list, the answer is "not here, but you can do it in your own Worker or origin." We're happy to suggest where the right place is.

If it's adjacent to WebMCP and you think it belongs, make the case in an issue and we'll evaluate against the "is this WebMCP discovery?" test. The bar to expand scope is high - tightly-scoped projects stay maintainable; sprawling ones don't.
