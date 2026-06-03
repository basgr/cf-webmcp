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

## Route-only mode loses in-page injection

Two deployment modes are supported:

- Full proxy (recommended): Worker sees every request, injects on HTML.
- Route-only: Worker only sees explicit paths (`/_webmcp/*`, `/.well-known/webmcp`, etc.). The in-page bootstrapper is never served because the Worker never sees HTML responses.

In route-only mode, browser-native agents must discover tools via the manifest. There is no auto-registration on page load.

## Native API surface is still a draft

The W3C WebMCP draft (`webmachinelearning/webmcp`) is moving. The bootstrapper calls `navigator.modelContext.registerTool` per the current draft. If the draft changes shape, the bootstrapper is one file to update.

Cloudflare Browser Run lab sessions expose `navigator.modelContextTesting` for the **consumer** side (the headless agent calling `listTools` / `executeTool`). That is a separate surface from the producer API we register against. We do not target it.

## Tool catalogue is static at deploy

Every deploy recompiles the TOML and bumps `CONFIG_HASH`. There is no runtime way to add or remove tools without a redeploy. This is intentional: simpler mental model, smaller attack surface, no runtime TOML parsing.

If you need rapidly-changing tools, redeploy. Wrangler deploys take ~5 seconds.

## Auto-suggested alternative paths from preflight

Preflight reports collisions but does not propose alternative paths. The publisher reads the message, edits the TOML, re-runs. Heuristics for picking a good alternative path are too site-specific to automate well.

## No telemetry from deployed Workers

By design: the project sends no data back to anyone. There is no usage tracking, no error reporting, no opt-in metric collection. The publisher owns their data; the Worker is a local artefact.

## What about Shopify?

Out of scope. Shopify is likely to ship native WebMCP support themselves with merchant integration. Building on top of Shopify with this Worker would commoditise quickly. WooCommerce gets the ecommerce use case via WordPress.
