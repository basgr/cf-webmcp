# AGENTS.md

`cf-webmcp` publishes a Markdown file at `/.well-known/agents.md` describing the site's WebMCP surface in prose-readable form. Two common variants (`/AGENTS.md` and `/agents.md`) 301-redirect to the canonical path so any agent that follows the convention finds it regardless of which path it tried.

This is the "user manual" companion to the manifest. The manifest is the typed contract that programmatic clients consume; AGENTS.md is the prose explanation that acting agents (Cursor, Claude Desktop, Codex, browser agents) read to understand how to behave on the site.

## What gets published

The canonical file is generated from your TOML and merged into origin content (or synthesized if no origin file exists). Default content:

- A `## WebMCP on this site` heading and a one-line site description
- Available tools - the imperative ones (`[[tools]]` from TOML) and, while `[features].inject_html` is on, the form tools (`[[forms]]` from TOML), with descriptions. With HTML injection off the Worker stamps no form, so no form tool exists and none is listed.
- Manifest URL for programmatic consumers (only while `[features].manifest` is on). It covers `[[tools]]` only, and says so when form tools exist.
- How agents connect, written from the config:
  - Browser-native registration. With `inject_html` on: on pages that load the cf-webmcp script, the tools that are not forms register on `document.modelContext` (Chrome 146 to 149: the deprecated `navigator.modelContext`), and a form tool exists only on pages that carry its form. With `inject_html` off: the tools register when the landing page loads, if it uses the default template (which loads the bootstrap); with a custom template, or with the landing off, there is no such line.
  - The landing page. With the desktop-bridge widget on (`[features].fallback_widget = true` and a widget pinned in the build) the block tells desktop MCP clients to pair at the landing page and notes that the widget only starts there. With the widget off, the default, it links the landing page as the "WebMCP page", which with the default template lists the tools that are not forms; nothing says to pair. With `[features].webmcp_landing = false` the landing page is not mentioned.
- Operational notes: the exec endpoint (for the tools that are not forms), the response envelope, `Retry-After` (sent with the Worker's own rate limit, not with an origin 429), and the health endpoint, linked only when it answers without a token: `[health].public` on and neither `[health].token` nor the `CF_WEBMCP_HEALTH_TOKEN` secret set.
- What to avoid: cross-origin executor calls without CORS config, retrying sooner than `Retry-After`, etc.

The Worker wraps this in `<!-- cf-webmcp:begin -->` / `<!-- cf-webmcp:end -->` markers so origin content around it is preserved across deploys.

## Config

Defaults (every TOML inherits these from the schema unless overridden):

```toml
[features]
agents_md = true

[agents_md]
path    = "/.well-known/agents.md"
mode    = "merge"                       # merge | replace | passthrough | synthesize
aliases = ["/AGENTS.md", "/agents.md"]
```

### Field reference

| Field | Default | Description |
|-------|---------|-------------|
| `[features].agents_md` | `true` | Master toggle. `false` disables the route entirely. Aliases also stop redirecting when off. |
| `[agents_md].path` | `/.well-known/agents.md` | Canonical path the Worker serves. The most-cited community location. |
| `[agents_md].mode` | `merge` | How to combine origin content with the cf-webmcp block. See modes below. |
| `[agents_md].aliases` | `["/AGENTS.md", "/agents.md"]` | List of paths that 301-redirect to the canonical path. Set `[]` to disable. |

### Modes

- **`merge`** (default). Fetch origin's file, splice the cf-webmcp block inside `<!-- cf-webmcp:begin -->` / `<!-- cf-webmcp:end -->` markers (or append if marker absent). Idempotent on re-run: subsequent deploys replace the block content cleanly, never duplicating. Origin's file is read up to 1 MiB: a larger one is relayed as it came, and one whose body fails mid-read is answered with the block alone for a minute (see [Merge routes and the 1 MiB cap](deployment.md#merge-routes-and-the-1-mib-cap)).
- **`synthesize`**. Ignore origin entirely. The published file is purely the cf-webmcp block. Use this when you have no origin file and want the Worker to be the single source.
- **`replace`**. Same shape as synthesize, semantically different intent: "I know origin has something, replace it". Build behaviour is identical to synthesize today; the distinction lives in the doc for clarity.
- **`passthrough`**. Route not registered. Origin owns the file outright. Use when you want full control of `/AGENTS.md` from your own template/CMS.

## The 301 redirect aliases

Two paths 301-redirect to canonical by default:

- `GET /AGENTS.md` → `301` → `/.well-known/agents.md`
- `GET /agents.md` → `301` → `/.well-known/agents.md`

The redirect itself is cacheable. Defaults:

```
Cache-Control: public, max-age=86400, s-maxage=604800
```

A day in the browser, a week at the edge. Redirects are stable; aggressive caching is appropriate.

The default aliases sit at the apex and the redirect carries no `X-Robots-Tag`. An alias you put under `/.well-known/` or the namespace (`aliases = ["/.well-known/AGENTS.md"]`) answers with `X-Robots-Tag: noindex`, like every answer there.

### Why have aliases at all?

The AGENTS.md convention started in code-repo tooling (Cursor, Aider, Codex), where the canonical location is `/AGENTS.md` at the repo root. Some web adopters publish at the same path; others use `/agents.md`; others use `/.well-known/agents.md`. Rather than picking one and being wrong half the time, cf-webmcp picks the most web-native option (`/.well-known/`) as canonical and 301-aliases the two common variants. An agent that tries any of the three finds the same content.

### Configuring aliases

```toml
[agents_md]
aliases = ["/AGENTS.md", "/agents.md"]   # default
aliases = ["/AGENTS.md"]                  # uppercase only
aliases = []                              # disable redirects entirely
```

If you set `aliases = []` and a request hits `/AGENTS.md`, cf-webmcp passes it through to origin. If origin has nothing there, the visitor gets a 404.

## Caching

The canonical file has the same cache shape as llms.txt and robots.txt: short browser TTL with longer edge TTL, plus `stale-while-revalidate` and `stale-if-error`. Defaults:

```
Cache-Control: public, max-age=300, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=86400
```

Configurable per surface in the `[cache]` block:

```toml
[cache]
agents_md_max_age           = 300
agents_md_s_maxage          = 21600
agents_md_swr               = 86400
agents_md_sie               = 86400
agents_md_redirect_max_age  = 86400
agents_md_redirect_s_maxage = 604800
```

## Discovery surface map

With AGENTS.md added, cf-webmcp publishes five complementary surfaces from one TOML:

| Surface | Format | Audience |
|---------|--------|----------|
| `/.well-known/webmcp` | JSON | Programmatic agents, typed contracts |
| `<link rel="webmcp">` on every page | HTML | Crawlers parsing HTML |
| `Link: rel="webmcp"` HTTP header | HTTP | Agents that only do `HEAD` requests |
| `/llms.txt` | Markdown | LLM retrieval/training crawlers |
| `/.well-known/agents.md` | Markdown | Acting agents (Cursor, Claude Desktop, browser agents) |

All five are merged into origin content where possible (`llms.txt`, `agents.md`, `robots.txt`) so the publisher's existing files are preserved. None of the five depend on the others; an agent that finds any one of them can discover all the rest through embedded links.

## Verifying after deploy

```bash
# canonical
curl -s https://yourdomain.com/.well-known/agents.md | head

# aliases redirect cleanly
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://yourdomain.com/AGENTS.md
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://yourdomain.com/agents.md
```

You should see `301` plus the canonical URL on both alias probes, and a 200 Markdown response with a `## WebMCP on this site` heading on the canonical probe.

## Convention status (mid-2026)

AGENTS.md as a website surface is an emerging convention - widely adopted in dev tooling (Cursor, Aider, Claude Code), still settling for the public-web case. The path under `/.well-known/` follows IETF conventions for machine-discoverable resources; the bare-root and lowercase variants follow community usage. None of these is yet formally standardised.

cf-webmcp's defaults reflect current best practice. If the community converges on a different canonical path, change `[agents_md].path`. If aliases drop in popularity, set `aliases = []`. The TOML field is the lever; the implementation is stable.

## What this is not

- **Not a CMS replacement.** The Worker generates a block of Markdown; it does not give you a way to author the rest of the AGENTS.md file from config. Hand-write the surrounding content in origin's `/.well-known/agents.md` (or wherever you point `[agents_md].path`).
- **Not site documentation.** Use llms.txt for "what's on this site". AGENTS.md is "how to act on this site as an agent". Overlap exists; the audiences differ.
- **Not a security boundary.** Agents reading AGENTS.md may or may not follow what it says. Operational constraints (rate limits, CORS) are enforced by the Worker, not by anything you write in AGENTS.md.
