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
| `/.well-known/api-catalog` | [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html) Linkset (RFC 9264) pointing at the manifest |
| `/.well-known/agents.md` (+ `/AGENTS.md`, `/agents.md` 301 aliases) | AGENTS.md augmentation block for acting agents |
| `/.well-known/agent-skills/<slug>/SKILL.md` (+ case-variant 301 aliases) | Anthropic-format Agent Skill, auto-generated from `[[tools]]` plus publisher hints |
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
- `/llms.txt` augmented with a WebMCP block (idempotent merge with origin's file)
- `/robots.txt` augmented with `Disallow: /_webmcp/` (idempotent merge)
- `/.well-known/agents.md` for acting agents, with `/AGENTS.md` and `/agents.md` 301-redirecting to it
- `/.well-known/api-catalog` ([RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html)) Linkset entry pointing at the WebMCP manifest. Also advertised in the `Link` header and as `<link rel="api-catalog">` on every response.
- `/.well-known/agent-skills/<slug>/SKILL.md` Anthropic-format Agent Skill with auto-generated tool list + publisher-written hints. Also advertised via `rel="agent-skills"` in the `Link` header and as a `<link>` tag.
- `/mcp` landing page that branches at runtime between native, pair, and disabled states

Plus five executor types (`sitemap_filter`, `rss_feed`, `dom_extract`, `http_json`, `http_get`) for the imperative tool path, and a `[[forms]]` block for the declarative form path.

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

## Acknowledgements

- Suganthan Mohanadasan, ["WebMCP: I Made My Website AI Agent Ready"](https://suganthan.com/blog/webmcp-implementation-guide/) - the implementation guide that informed the publisher-side discovery patterns.
- [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP) - the fallback widget that bridges desktop MCP clients to WebMCP sites.
- [webmachinelearning/webmcp](https://github.com/webmachinelearning/webmcp) - the W3C draft.

## License

MIT. See [LICENSE](LICENSE).
