# cf-webmcp

[![CI](https://github.com/basgr/cf-webmcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/basgr/cf-webmcp/actions/workflows/ci.yml) [![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Cloudflare Worker that sits in front of a website and equips it with [WebMCP](https://github.com/webmachinelearning/webmcp). One TOML file in, every WebMCP-aware browser sees the site's tools out.

> Not affiliated with Cloudflare. The `cf-` prefix only reflects that the project runs exclusively on Cloudflare primitives - this is not an official Cloudflare product.

## What it does

For each request, the Worker does one of two things:

**1. Handle a Worker-owned path directly.**

| Path | What lives there |
|------|------------------|
| `/.well-known/webmcp.json` | Tool-catalogue manifest, machine-readable JSON |
| `/.well-known/api-catalog` | RFC 9727 Linkset (RFC 9264) pointing at the manifest |
| `/.well-known/agents.md` (+ `/AGENTS.md`, `/agents.md` 301 aliases) | AGENTS.md augmentation block for acting agents |
| `/.well-known/agent-skills/<slug>/SKILL.md` (+ case-variant 301 aliases) | Anthropic-format Agent Skill, auto-generated from `[[tools]]` plus publisher hints |
| `/.well-known/agent-skills/index.json` | Cloudflare Agent Skills Discovery RFC v0.2.0 index with build-time SHA-256 digest |
| `/llms.txt` | Origin's llms.txt with a WebMCP block merged in |
| `/robots.txt` | Origin's robots.txt with `Disallow: /_webmcp/` merged in |
| `/mcp` | Landing page: native-API, desktop-pairing, or disabled state |
| `/_webmcp/exec/<tool>` | Tool execution endpoint (POST) |
| `/_webmcp/bootstrap.<hash>.js` | In-page tool registration script |
| `/_webmcp/widget.<hash>.js` | Optional desktop-bridge widget |
| `/_webmcp/health` | Operational health endpoint |

**2. Otherwise, proxy to origin and modify the response on the way back.**

- **HTTP `Link` header** added to every proxied response (HTML, PDF, image, JSON, anything). One entry per discovery surface: `rel="webmcp"` to the manifest, `rel="api-catalog"` to the catalog, `rel="agent-skills"` to the SKILL.md. An agent doing a `HEAD` request finds all three without parsing a body.
- **On HTML responses only** (status 200, `text/html`, UTF-8, path not in `[injection].exclude_paths`), HTMLRewriter injects:
  - matching `<link>` tags into `<head>` (`rel="webmcp"`, `rel="api-catalog"`, `rel="agent-skills"`),
  - one `<script src="/_webmcp/bootstrap.<hash>.js" defer>` before `</body>` that auto-registers the tools via `navigator.modelContext`,
  - W3C declarative form attributes (`toolname`, `tooldescription`, `toolparamdescription`, `toolautosubmit`) stamped onto matching `<form>` elements when a `[[forms]]` block matches the current path.

Non-HTML responses (PDFs, images, JSON, CSS, JS, etc.) pass through with their body unchanged but with the `Link` header added.

The tool catalogue lives in one TOML file. Five server-side executor types (`sitemap_filter`, `rss_feed`, `dom_extract`, `http_json`, `http_get`) cover the imperative tool path; `[[forms]]` blocks cover the declarative-form path. Three deploy templates ship: `default`, `wordpress`, `woocommerce` (Store API).

## Discovery surfaces

cf-webmcp publishes the same tool catalogue through multiple complementary surfaces, all driven from the single TOML:

- `/.well-known/webmcp.json` (manifest, machine-readable)
- `<link rel="webmcp">` injected into every HTML page
- `Link: rel="webmcp"` HTTP header on every response
- `/llms.txt` augmented with a WebMCP block (idempotent merge with origin's file). Also advertised in the `Link` header and as `<link rel="describedby" type="text/markdown">` via the IANA-registered RFC 8288 relation, so generic agent-aware scanners that only recognise standard rels find a description of the site.
- `/robots.txt` augmented with `Disallow: /_webmcp/` (idempotent merge)
- `/.well-known/agents.md` for acting agents, with `/AGENTS.md` and `/agents.md` 301-redirecting to it
- `/.well-known/api-catalog` ([RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html)) Linkset entry pointing at the WebMCP manifest. Also advertised in the `Link` header and as `<link rel="api-catalog">` on every response.
- `/.well-known/agent-skills/<slug>/SKILL.md` Anthropic-format Agent Skill with auto-generated tool list + publisher-written hints. Also advertised via `rel="agent-skills"` in the `Link` header and as a `<link>` tag.
- `/.well-known/agent-skills/index.json` ([Cloudflare Agent Skills Discovery RFC](https://github.com/cloudflare/agent-skills-discovery-rfc) v0.2.0) wraps the SKILL.md in a spec-compliant index with a build-time SHA-256 digest for integrity verification. `links.agent_skills_index` field added to the manifest.
- `/mcp` landing page that branches at runtime between native, pair, and disabled states

Plus five executor types (`sitemap_filter`, `rss_feed`, `dom_extract`, `http_json`, `http_get`) for the imperative tool path, and a `[[forms]]` block for the declarative form path.

> [!NOTE]
> **Every surface above is opt-in.** Each one maps to a single boolean in your `[features]` block. If you disagree with a convention or do not want to publish it, flip the flag off and the route disappears, the link advertisement drops out, and no fingerprint is left. `llms.txt` is the most widely-debated example: set `llms_txt = false` and cf-webmcp stops claiming the path entirely. Same applies to `agents.md`, `api-catalog`, `agent-skills`, `fallback_widget`, form-attribute injection, and the in-page `<script>` bootstrap. Defaults are "on" because cf-webmcp's value is publishing discovery surfaces; opting out is one TOML edit away. See [`docs/scope.md`](docs/scope.md) for what is in and out of scope at the project level.

## Quick start

```bash
git clone https://github.com/basgr/cf-webmcp
cd cf-webmcp
cp templates/default.toml webmcp.toml
cp wrangler.example.toml wrangler.toml
# edit webmcp.toml: set [site], [origin], and tool URLs
# edit wrangler.toml: set the route for your domain
npm install
npm run build
wrangler deploy
```

## Validation

You can verify a cf-webmcp deployment with a tool that does not know anything about your TOML or config - it only sees the rendered page. Lighthouse 13.3.0 ships an **agentic-browsing** audit category that does exactly this.

Running it against the demo's `/forms` page (Chrome Canary 150.x, verified 28 Aug 2026, WebMCP flag on) returns a perfect category score:

- `agent-accessibility-tree` - pass
- `webmcp-registered-tools` - finds all 3 imperative tools from the injected bootstrap plus both declarative form tools (the cf-webmcp-stamped form and a hand-stamped control)
- `webmcp-form-coverage` - not applicable (every form on the page is already annotated)
- `webmcp-schema-validity` - pass (generated `inputSchema` blocks validate)
- `llms-txt` - pass

A third-party auditor seeing only the HTTP response confirms both the auto-injected and the manually-stamped tools, which is the same vantage point external agent-readiness checkers use.

## Documentation

Full reference docs live in [`docs/`](docs/):

**Getting started**

- [Deployment](docs/deployment.md) - full-proxy vs route-only modes, wrangler config, Bot Management bypass.
- [Local testing](docs/local-testing.md) - `wrangler dev` against the bundled `templates/example-site/` fixture.
- [Browser support](docs/browser-support.md) - enabling the WebMCP flag in Chrome and verifying it.

**Configuration**

- [Customisation](docs/customisation.md) - overriding the `/mcp` landing template, placeholders, runtime state branching.
- [Form injection](docs/form-injection.md) - the `[[forms]]` block, declarative `toolname` / `tooldescription` / `toolparamdescription` / `toolautosubmit` attribute stamping.
- [AGENTS.md](docs/agents-md.md) - `/.well-known/agents.md` publication + 301 aliases.
- [API catalog (RFC 9727)](docs/api-catalog.md) - the `/.well-known/api-catalog` Linkset.
- [Agent Skills](docs/agent-skills.md) - the `/.well-known/agent-skills/<slug>/SKILL.md` publication.

**Operations**

- [Costs](docs/costs.md) - Workers, R2, and cache pricing under typical traffic.
- [Privacy](docs/privacy.md) - what's logged, what's stripped from origin fetches, GDPR posture.
- [Upgrade](docs/upgrade.md) - `schema_version` policy, tool-name immutability, breaking-change procedure.
- [Limitations](docs/limitations.md) - SPA story, multi-language sites, service workers, other known edges.

**Project**

- [Scope](docs/scope.md) - what cf-webmcp is and is not. Read this before opening a feature request.
- [Security model](docs/security.md) - tool descriptions are not a security boundary; what cf-webmcp does and does not defend against.

## Acknowledgements

- Suganthan Mohanadasan, ["WebMCP: I Made My Website AI Agent Ready"](https://suganthan.com/blog/webmcp-implementation-guide/) - the implementation guide that informed the publisher-side discovery patterns.
- [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP) - the fallback widget that bridges desktop MCP clients to WebMCP sites.
- [webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp) - the W3C draft.

## License

MIT. See [LICENSE](LICENSE).
