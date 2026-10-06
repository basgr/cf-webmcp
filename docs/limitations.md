# Known limitations

Things `cf-webmcp` v1 does not do, and why.

## SPAs and client-side routing

The Worker injects the bootstrapper into the initial HTML response. After that, single-page apps (React, Vue, modern WordPress block themes with hydration) change the URL client-side without ever touching the Worker again.

Effect: the tool catalogue registered on first page load is **site-wide**. The same tools are available on every "route" within an SPA session, even if conceptually they only apply to certain pages.

Workaround: site-wide tools is fine for most v1 use cases (most sites expose 3-10 tools). Route-conditional tools are not in v1 scope.

## Multi-language sitemaps

Plugins like WPML and Polylang produce nested sitemap indices (`/sitemap_index.xml` pointing to per-language sitemaps). The `sitemap_filter` executor follows a single sitemap URL only; it does not crawl an index.

Workaround: define one tool per language with the leaf sitemap URL, or point at a single combined sitemap if your site exposes one.

## Service workers on the customer site

If the publisher's site has a service worker that intercepts fetches with broad scopes, it may interpose on `/_webmcp/exec/*` requests and either cache them incorrectly or break them entirely. This is rare in practice (most service workers exclude POST and scope themselves narrowly), but worth knowing about.

Workaround: configure the service worker to bypass `/_webmcp/*` paths.

## Non-UTF-8 origins

HTMLRewriter is UTF-8 only. The Worker skips bootstrapper injection on responses with non-UTF-8 charset declarations (e.g. older WordPress sites serving `Content-Type: text/html; charset=windows-1252`). The page passes through untouched.

Workaround: configure the origin to serve UTF-8.

## Pages without a literal `<head>` get no `<link>` tags

The Worker adds its `<link rel="webmcp">` (and the other discovery `<link>` tags) by appending to the `<head>` element. HTML that omits the `<head>` tag entirely, which the HTML spec allows, has no element for the rewriter to append to, so those pages get no `<link>` tags. The same discovery data is sent in the HTTP `Link` response header, which does not depend on the page markup: it is on every proxied response (HTML or not, a page without a literal `<head>` included) while `features.link_header` is on, so agents that read headers still find the documents. (With every discovery surface off there is nothing to advertise, and no header is added.)

The bootstrap `<script>` does not depend on `<head>`. It goes before `</body>`, and a page without `</body>` gets it at the very end of the document (minified HTML often omits `</body>`). That includes a page with no `<body>` at all, as long as it has a doctype, an `<html>` or a `<head>` tag. Bare fragments with no doctype, `<html>`, `<head>` or `<body>` tag, such as an AJAX partial, are passed through untouched, with only the `Link` header added.

## The bootstrap goes before the first `</body>` the rewriter sees

HTMLRewriter is a streaming tokenizer, not a tree builder, so it also reports a `body` element that sits inside `<template>` or inline `<svg>`. The Worker puts the bootstrap `<script>` before the end of the first `body` element it is told about. On a page where `<template><body></body></template>` comes before the real `</body>`, the script lands inside the template, whose content is inert: it never runs, and the page registers no tools. A `body` tag inside inline SVG (`<svg><body/></svg>`) moves the script into the SVG markup the same way; whether it runs there depends on how the browser's parser reads that markup. The `<link>` tags and the `Link` header are not affected. Workaround: keep `body` tags out of templates and inline SVG at origin.

## Merge routes: no deadline on the body, no rate limit

The merge routes (`/llms.txt`, `/robots.txt`, `/.well-known/agents.md`, the API catalog, the ARD manifest and the agent skill, in a merge mode) wait at most 10 seconds for origin's response headers, then answer `504`. There is no deadline on the body after that: an origin that sends its headers and then trickles the body keeps the request, and the Worker's fetch, open for as long as it takes, both while the Worker reads up to 1 MiB to merge and while it relays a larger file. These routes are also outside the Worker's rate limiter, which counts tool calls (`POST <namespace>/exec/<tool>`) only, so every request to them fetches origin's file. If they need a limit, use a Cloudflare rate limiting rule on their paths, and keep origin's files small and fast.

## HTML injection fails open only on setup errors

Selectors in `[[forms]]` and `dom_extract` are checked against a strict grammar when the config is compiled (see [`docs/form-injection.md`](form-injection.md)), so most typos fail the build. Because the check cannot promise that Cloudflare's HTMLRewriter takes everything it accepts, the Worker also guards each form selector and each param selector separately at request time: when HTMLRewriter rejects one, only that form or param is skipped (one log line names it), and the bootstrap script, the `<link>` tags and the other forms are injected as usual.

If building the HTML rewriter throws for any other reason, the Worker logs the error and serves the origin page unchanged, without the injected tags and form attributes.

An error raised while the response body is already streaming to the visitor cannot be recovered this way: the status line and headers have been sent. The Worker does not use `ctx.passThroughOnException()` as a second net. It forwards to the zone's origin server rather than to `[origin].base_url`, and it does nothing on Custom Domains and `workers.dev` routes.

## `dom_extract` follows explicit end tags only

`dom_extract` reads a page with Cloudflare's HTMLRewriter, which is a streaming tokenizer, not a tree builder: it does not know that a `<p>` is closed by the next `<p>`, or a `<li>` by the next `<li>`. The `selector` region and every `strip` element end at their own explicit end tag. HTML that leaves end tags out therefore runs on, until the end tag of the enclosing element closes what was left open: with `strip = ["p"]`, `<main>A<p>P1<p>P2</p>B</main>` yields `A`, because the second `<p>` opens one more level and the single `</p>` closes only one, so `B` stays hidden until `</main>`. The same happens with an unclosed `<li>`. When an enclosing element's end tag is there, it closes them: `<main>A<ul><li>x<li>y</ul>B</main>` with `strip = ["li"]` yields `AB`, because `</ul>` ends both items. Void tags (`br`, `img`, `input`, `hr`) and self-closing elements are fine; the problem is only elements that omit their end tag. Workaround: do not list such elements in `strip` (strip their container instead, such as `ul`, `nav` or `aside`), or fix the markup at origin.

## A path placeholder cannot climb out of its path

In a `url_template`, a placeholder in the path (`https://example.com/api/{{id}}`) is written into the path with its slashes kept, so that a multi-segment value such as `blog/hello-world` works. The URL parser resolves `.` and `..` segments, so `id = "../../admin"` would have sent the request to `https://example.com/admin`, with the deploy-token bypass headers attached. Two checks stop that, for every executor that reads a `url_template` (`dom_extract`, `http_json`, `http_get`):

- A caller's value in a path position is refused (`invalid_input`, naming the placeholder, never echoing the value) when it holds a `.` or `..` segment. Segments are split on `/` and on `\`, and percent-escapes are decoded first, up to five layers (`%2e%2e`, `.%2E`, `..%2F`, `..%5C` and `%252e%252e` are all `..`). Names such as `v1.2`, `file.json`, `..foo` and `...` are fine, and so is a `.` or `..` that the publisher wrote into a default or a `map:` value.
- After the template is resolved, the pathname the URL parser produced must still start with the static path in front of the template's first placeholder, cut after its last `/` (`/api/` for the template above, `/api/items` when the first placeholder is in the query, `/` for a template rooted at the origin such as `https://example.com{{path}}` or `https://example.com/{{path}}`, which keeps accepting any ordinary path). This also catches a `..` that the template itself contributes (`/files/..{{x}}` with `x = "/admin"`).

A `%2F` or `%5C` a caller writes is not decoded on the way out: the percent sign is escaped, so `a%2Fb` reaches origin as the literal text `a%252Fb`, never as a slash. The checks decode it only to see whether it would form a dot segment. Query-position values are not affected: `..` there is text. The query starts at the template's own first `?` (or `#`); a `?` or `#` inside a placeholder's `default:` or `map:` value does not count, so `https://example.com/api/{{a|default:v?1}}/{{b}}` still checks `b` as a path value.

## A path that starts with `//` is answered 400

A request whose path starts with `//` once the URL parser has read it (`//host/x`, `///x`, `/\host/x`, `/.//host/x`) gets `400` with the plain-text body `bad request path` and never reaches origin, so a page that origin serves at such a path is unreachable through the Worker; `/a//b` and every other path are proxied as before.

## Route-only mode loses in-page injection

Two deployment modes are supported:

- Full proxy (recommended): Worker sees every request, injects on HTML.
- Route-only: Worker only sees explicit paths (`/_webmcp/*`, `/.well-known/webmcp`, etc.). The in-page bootstrapper is never served because the Worker never sees HTML responses.

In route-only mode, browser-native agents must discover tools via the manifest. There is no auto-registration on page load.

## Native API surface is still a draft

The W3C WebMCP draft (`webmachinelearning/webmcp`) is moving. The bootstrapper calls `registerTool` on `document.modelContext` (current draft), falling back to the deprecated `navigator.modelContext` alias for 146-149 builds. If the draft changes shape again, the bootstrapper is one file to update.

Cloudflare Browser Run lab sessions expose `navigator.modelContextTesting` for the **consumer** side (the headless agent calling `listTools` / `executeTool`). That is a separate surface from the producer API we register against. We do not target it.

## Zone-level AI bot blocking runs in front of the Worker

Cloudflare's AI traffic controls (bot classification into Search / Agent / Training categories, WAF rules, managed challenges) execute **before** the Worker. If the zone blocks the Agent category, user-directed agents - exactly the audience cf-webmcp publishes tools for - are stopped at the edge and the Worker never sees the request. cf-webmcp cannot detect or override this from inside the Worker; it is a zone security setting only the publisher can change.

Since September 15, 2026, **new** Cloudflare zones block Agent and Training bots by default on ad-monetized pages. Existing zones keep their settings. See the "Cloudflare AI crawler defaults" section in [`docs/deployment.md`](deployment.md) for what to configure.

## Tool catalogue is static at deploy

Every deploy recompiles the TOML. `CONFIG_HASH` changes when a value in the validated config changes (in the TOML or in the TOML it inherits), or when an upgrade adds or changes a default. There is no runtime way to add or remove tools without a redeploy. This is intentional: simpler mental model, smaller attack surface, no runtime TOML parsing.

If you need rapidly-changing tools, redeploy. Wrangler deploys take ~5 seconds.

## Auto-suggested alternative paths from preflight

Preflight reports collisions but does not propose alternative paths. The publisher reads the message, edits the TOML, re-runs. Heuristics for picking a good alternative path are too site-specific to automate well.

## No telemetry from deployed Workers

By design: the project sends no data back to anyone. There is no usage tracking, no error reporting, no opt-in metric collection. The publisher owns their data; the Worker is a local artefact.

## What about Shopify?

Out of scope. Shopify is likely to ship native WebMCP support themselves with merchant integration. Building on top of Shopify with this Worker would commoditise quickly. WooCommerce gets the ecommerce use case via WordPress.
