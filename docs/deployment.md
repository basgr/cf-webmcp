# Deployment

`cf-webmcp` is a single Cloudflare Worker per customer domain. You fork this repo, write a TOML, and run `wrangler deploy`. No SaaS layer.

## Prerequisites

- Cloudflare account with a Workers Paid plan if you expect more than 100k requests/day. Free tier works for low traffic.
- Domain managed on Cloudflare (orange-cloud DNS).
- `wrangler` CLI authenticated: `npx wrangler login`.

## Choose a template

Three starters ship in `templates/`. Pick one:

- `templates/default.toml` - generic site (sitemap + RSS + page extract).
- `templates/wordpress.toml` - WordPress core REST endpoints.
- `templates/woocommerce.toml` - WooCommerce Store API on top of WordPress.

Copy to project root:

```bash
cp templates/wordpress.toml webmcp.toml
```

Edit `webmcp.toml`:

- `[site].domain` - your domain (e.g. `example.com`).
- `[site].name`, `[site].description` - shown in the manifest and landing.
- `[origin].base_url` - your real origin URL.
- `[origin].allowed_origins` - list of origins executors may fetch. Usually just your origin.
- Tool URLs in `[[tools]]` - update `sitemap_url`, `feed_url`, `url_template` to point at your site.

## Wrangler setup

```bash
cp wrangler.example.toml wrangler.toml
```

Edit `wrangler.toml`:

- Uncomment and set the `routes` block to your domain.
- Confirm the `[[r2_buckets]]` binding (used for the fallback widget).

Create the R2 bucket if you want the fallback widget:

```bash
wrangler r2 bucket create cf-webmcp-assets
```

Set secrets:

```bash
wrangler secret put CF_WEBMCP_DEPLOY_TOKEN   # any random string; used by preflight
wrangler secret put CF_WEBMCP_HEALTH_TOKEN   # only needed if [health].token is set in TOML
```

## Two deployment modes

**Full proxy (recommended).** Your domain DNS points at Cloudflare, orange-cloud on, Worker route `*example.com/*`. Worker sees every request. All discovery surfaces active: in-page bootstrapper injection, `<link rel="webmcp">` tag, `Link:` HTTP header, manifest at `/.well-known/webmcp`, llms.txt augmentation, robots.txt augmentation, AGENTS.md at `/.well-known/agents.md` (with `/AGENTS.md` and `/agents.md` 301 aliases), API Catalog at `/.well-known/api-catalog` (RFC 9727), Agent Skill at `/.well-known/agent-skills/<slug>/SKILL.md` (with case-variant 301 aliases) and its discovery index at `/.well-known/agent-skills/index.json` (Cloudflare Agent Skills Discovery RFC v0.2.0), and TOML-driven form attribute injection.

**Route-only.** Worker routes only on the specific paths it owns (`/_webmcp/*`, `/.well-known/webmcp`, `/.well-known/agents.md`, `/.well-known/api-catalog`, `/.well-known/agent-skills/<slug>/SKILL.md`, `/.well-known/agent-skills/index.json`, `/mcp`, `/llms.txt`, `/robots.txt`, plus the AGENTS.md and SKILL.md alias paths). Lighter touch, but **in-page bootstrapper injection and form attribute injection are both disabled** because the Worker never sees HTML responses. Native-API users can still discover tools via the manifest and AGENTS.md, but auto-registration on page load does not happen and forms must hand-stamp their own attributes in origin HTML.

Recommended: full proxy. Route-only is documented for situations where the publisher cannot route everything through CF.

## Preflight

Before the first deploy, check that the paths the Worker wants to claim are free:

```bash
npm run preflight -- --config=webmcp.toml
```

Reports OK / merge / COLLISION per path. Exits non-zero on hard collisions. Pass `--force` to override.

If a path collides, either:

- Move the Worker route in your TOML (e.g. `[webmcp_landing].path = "/agents/"`).
- Disable the surface (e.g. `[features].webmcp_landing = false`).

## Pin the fallback widget (optional)

If you want desktop MCP client support (`[features].fallback_widget = true`):

```bash
npm run update-widget -- --version=v0.1.5 --sha256=<hex>
npm run upload-widget   # after wrangler.toml has the R2 binding configured
```

The sha256 is verified during download. The MIT LICENSE is preserved alongside.

`update-widget` writes `vendor/webmcp/current.json`: the version, the sha256 of the upstream file, and what visitors will actually receive (`served_sha256`, `served_sri`, `preamble_sha256`). The R2 object is one composed file, the MIT license preamble followed by the pinned `webmcp.js`, stored under `widget.<first 16 hex of served_sha256>.js`. The Worker serves it as-is, and the landing page's `<script>` carries `integrity="<served_sri>"`.

**Run `upload-widget` BEFORE you deploy** whenever the pin changes. The new Worker advertises the new widget URL and answers 503 for it until the object exists; `GET /_webmcp/health` shows `widget_asset_present`. `upload-widget` verifies the vendored file against `current.json` first and aborts on any mismatch. Do not upload `webmcp.js` by hand with `wrangler r2 object put`: it lacks the preamble, so browsers block the script with an SRI mismatch.

The vendored `webmcp.js` is gitignored. On a fresh checkout, or after pulling a release that changes the pin, run `update-widget` with the version and sha256 from `current.json` first; it re-downloads and verifies the file. The default download URL is the upstream release asset `webmcp.js`; a release without that asset (v0.1.13 is one) needs `--release-url`, for v0.1.13 `--release-url=https://raw.githubusercontent.com/jasonjmcghee/WebMCP/v0.1.13/src/webmcp.js`. The build itself reads only `current.json`, so CI builds work without the file. If `current.json` has no usable pin (`"version": "unpinned"` or no `served_*` fields), the build still succeeds but warns and ships with the widget disabled.

Wrangler 4 targets *local* storage when `r2 object put` gets neither `--local` nor `--remote`. `upload-widget` passes `--remote` explicitly so deploy uploads reach the real bucket, and `npm run upload-widget -- --local` writes to the local R2 state that `wrangler dev` reads.

The widget object is keyed by content, not by config hash, so editing your TOML never requires a re-upload. Objects for earlier pins, and any `widget.<8-hex>.js` object named after a config hash by v0.5.x and earlier, are no longer referenced and can be deleted: `wrangler r2 object delete <bucket>/widget.<hash>.js`.

## Deploy

```bash
npm run deploy
```

This chains `npm run build` (compiles TOML to TypeScript modules) and `wrangler deploy`. The first deploy provisions the Worker and binds the R2 bucket if configured. Subsequent deploys re-upload the bundle and rotate the `CONFIG_HASH`.

After deploy, hit `https://yourdomain.com/_webmcp/health` to confirm the Worker is alive and the config hash matches. With `fallback_widget = true`, `widget_asset_present` should be `true`; `false` means the widget object is missing from R2 (run `npm run upload-widget`), and `null` means the widget is not applicable or could not be checked (feature off, no pinned widget in this build, no R2 binding).

## Origin and allowed_origins safety

`[origin].base_url` and `[origin].allowed_origins` decide which hosts the Worker is permitted to fetch from. A few rules to keep this safe:

- **Never put internal/RFC1918 IPs in `allowed_origins`.** Values like `http://10.0.0.5`, `http://192.168.1.1`, or `http://169.254.169.254` would let the Worker reach private services that the publisher has accidentally exposed to Cloudflare's network. CF Workers does not expose its own metadata service, but a publisher's own private infra is fair game from inside the Worker. Stick to publicly-reachable HTTPS origins.
- **Use one origin per deployment.** `allowed_origins` is a defence-in-depth measure, not a multi-tenant feature. If you genuinely need multiple origins (e.g. CDN + API on different hosts), list all of them; otherwise keep it to one.
- **The Worker checks every redirect target before it requests it.** On its own fetches to origin, that is the tool executors and the merge routes (`/llms.txt`, `/robots.txt`, `/.well-known/agents.md`, the API catalog, the AI catalog and the agent skill, each when it merges with origin's file), the Worker does not let the runtime follow redirects. It reads each `Location`, resolves it against the current URL, and requests it only if it is an `http` or `https` URL whose origin (scheme, host and port) is in `allowed_origins`. It follows at most 5 redirects. A target that fails the check is never requested, so the `cf-webmcp-bypass` and `cf-webmcp-deploy-token` headers go only to listed origins, on every hop, and an open redirect at origin cannot leak the deploy token. If you have a legitimate cross-host redirect (apex to `www`, for example), add the target to `allowed_origins` and the Worker follows it.
- **What a refused redirect looks like.** A refusal that returns an error keeps the refused host and `Location` out of the response. The Worker writes them to its log (`wrangler tail`) as one line that starts with `cf-webmcp: executor refused an origin redirect` or `cf-webmcp: proxy refused an origin redirect`.
  - Tool executors: a redirect to an origin outside `allowed_origins` returns an `invalid_input` error. More than 5 redirects, or a `Location` that is not a usable `http` or `https` URL, returns an `internal` error. The messages are fixed text.
  - Merge routes: a redirect to an origin outside `allowed_origins` is relayed to the client as it came: the same status, the `Location` resolved to an absolute URL, no body, `Cache-Control: no-store` and `X-Robots-Tag: noindex`. The Worker sends no request to that target and no deploy token with the relay. This keeps a crawler's `/robots.txt` fetch from turning into a 5xx when origin redirects between apex and `www`. The AI catalog in `merge` mode answers with its own generated document whenever origin's answer is unusable, a refused redirect included.
  - Merge routes, other failures: more than 5 redirects, an unusable `Location`, or a `[origin].base_url` that is not in `allowed_origins` answer 502 with `X-Robots-Tag: noindex` and a fixed message. A failed connection is also a 502. The Worker stops waiting for origin after 10 seconds and answers 504 with the same header.
- **Redirects on proxied pages are not followed by the Worker.** For ordinary page requests the Worker passes an origin 3xx to the visitor's browser with the status, body and `Location` that origin sent, and adds only the `Link` header (when `[features].link_header` is on). No deploy token is attached to those requests.

## Subresource Integrity (SRI) on the injected bootstrap

Since v0.3.6 the injected `<script src="/_webmcp/bootstrap.<hash>.js" defer>` tag carries `integrity="sha384-..."` and `crossorigin="anonymous"`. Browsers refuse to execute the bootstrap if its body has been substituted between server and client (compromised CDN node, intermediary cache poisoning). The fallback widget's `<script>` on the landing page carries the same attributes. Toggle via `[features].subresource_integrity` (default `true`).

The URL and the hash always describe the same bytes: `<hash>` in `bootstrap.<hash>.js` is the first 16 hex of the sha256 of the bootstrap body, so a browser that cached an older bootstrap under its immutable URL can never be handed a newer body (and an SRI failure) at that URL.

If the origin publishes a Content Security Policy with `script-src` restrictions, three cases:

- **`script-src 'self'`** (or anything that lists same-origin) - works without changes; the bootstrap is same-origin so the source-list match covers it. SRI on the tag is independent of CSP and continues to verify the body.
- **`script-src 'strict-dynamic' ...`** (nonce/hash-propagating policy) - the injected `<script src=...>` tag is parser-inserted, not loaded by an already-trusted script, so `'strict-dynamic'` will NOT auto-trust it. Either pin the bootstrap in `script-src` with its SRI hash (see next bullet), or add `nonce-<value>` to the policy and stamp a matching `nonce` on the tag (cf-webmcp does not emit nonces today, so the hash route is simpler).
- **`script-src 'sha384-X'`** (explicit hash allowlist) - add the bootstrap hash from `src/generated/config.ts::BOOTSTRAP_SRI` to your CSP's `script-src` list. The CSP hash-source for an external script and the SRI `integrity` value both hash the response body, so the same `sha384-X` string serves both. **The bootstrap URL and its SRI hash rotate whenever the bootstrap bytes change**: any change to the resolved config (the file embeds the config hash, so every such change moves it), and also a cf-webmcp upgrade whose generated bootstrap differs, even with an unchanged TOML. Update `script-src` with each deploy that changes `BOOTSTRAP_SRI`. The widget has its own hash, `WIDGET_SRI` in the same file; it changes only when the widget pin or the license preamble changes, not when you edit the TOML.

Note: `'unsafe-inline'` has no effect on the bootstrap because the tag uses `src=...` rather than an inline body.

SRI does not defend against prompt-injection content embedded in TOML descriptions; see [`docs/security.md`](security.md) for that boundary.

## Bot Management / WAF

Some Cloudflare products (Bot Management, custom WAF rules, rate-limiting) will see executor calls and origin fetches as bot traffic and may block them. The Worker sends:

- `User-Agent: cf-webmcp/<version>` on origin fetches
- `cf-webmcp-bypass: 1` and `cf-webmcp-deploy-token: <token>` headers, only on requests to origins (scheme, host and port) listed in `allowed_origins`, redirect targets included

Configure your WAF / Bot Management to allow requests with these headers. Otherwise tool calls will return `origin_4xx` or `rate_limited` envelope errors.

## Cloudflare AI crawler defaults (September 2026)

Cloudflare classifies bots into three categories - **Search** (crawling for search results), **Agent** (user-directed agents visiting a page on behalf of a human), and **Training** (crawling to train or fine-tune models). Since **September 15, 2026, new zones block Agent and Training bots by default on ad-monetized pages**; Search stays allowed. Existing zones keep their settings.

This matters for cf-webmcp deployments because the **Agent category is exactly the audience cf-webmcp serves** (ChatGPT-style live fetchers, browser-use agents), and the blocking happens at the WAF layer **before the Worker runs**. On a new zone with defaults, agents can be 403'd on the HTML pages where the injected bootstrap and form attributes live - the WebMCP surface looks dead even though the Worker is deployed correctly. Discovery endpoints under `/.well-known/*` and `/_webmcp/*` are typically unaffected (they are not ad-monetized pages), but the pages agents act on are.

What to do:

- **Review Security -> AI traffic in the Cloudflare dashboard** after creating a new zone. If you deploy cf-webmcp, allow the Agent category (at least for the paths agents need). All plan tiers have these controls.
- **Beware the multi-purpose crawler trap.** Crawlers that serve several functions (Googlebot, Bingbot, Applebot do both Search and Training) are blocked according to *all* of their behaviors: blocking Training blocks Googlebot entirely, which de-indexes you from search. Read the category descriptions carefully before blocking.
- **Verified-bot status no longer grants blanket access.** Verification only admits a bot within the categories you allow.

### Managed robots.txt and Content Signals

Cloudflare's managed robots.txt feature **prepends** its block to whatever your zone serves at `/robots.txt` ("combining both into a single response"), so it composes with cf-webmcp's merged robots.txt rather than replacing it. Two things to know before enabling it:

- Its default rule adds a preference signal (`Content-signal: search=yes, ai-train=no, use=reference`) for all user agents. That is a preference, not a block, and does not conflict with cf-webmcp.
- Its per-bot rules add **`Disallow: /` for GPTBot, ClaudeBot, CCBot, Google-Extended, and other AI crawlers**. That tells those crawlers to skip *every* path - including `/llms.txt`, the WebMCP manifest, and the other discovery surfaces cf-webmcp publishes for them. If your goal is agent discoverability, enabling managed robots.txt works against it; prefer cf-webmcp's robots.txt merge mode and set your own policy.

Content-use signals themselves (`Content-Signal:`, the `use=` parameter) remain publisher policy and out of cf-webmcp's scope; the merge mode preserves any such lines your origin or Cloudflare adds. See [`docs/scope.md`](scope.md).

## Caching and the deploy/cache-bust cycle

The Worker uses three cache tiers:

- Deploy-time constants (manifest, landing, llms.txt, robots.txt) - `max-age=300, s-maxage=86400, stale-while-revalidate=604800`, plus `ETag: "<config_hash>"`. Deploy bumps the hash; clients revalidate cheaply.
- Content-addressed immutable assets (bootstrap.<hash>.js, widget.<hash>.js) - `max-age=31536000, immutable`. `<hash>` is derived from the served bytes (bootstrap: sha256 of the script; widget: sha256 of the R2 object, from `vendor/webmcp/current.json`), so the URL changes exactly when the bytes change and each URL is safe to cache forever. A request for any other `bootstrap.<x>.js` or `widget.<x>.js` under the namespace (a URL from a previous deploy) gets `404` with `Cache-Control: no-store` and `X-Robots-Tag: noindex`, and is never proxied to origin.
- Tool executor responses - per-tool TTL, cache key derived from `tool_name + sha256(body)`.

No manual cache purge is needed for the Worker's own assets between deploys; CF edge caches roll forward automatically as the hashes change. One exception is HTML that a cache in front of the Worker or an origin page cache keeps: such a page still points at the previous bootstrap URL, which now answers 404, so tools are not registered on that view until the page is refreshed. Purge cached HTML after a deploy that rotates the bootstrap, or keep HTML TTLs short. The same applies briefly to the `/mcp` landing page after a widget pin change: its `stale-while-revalidate` window can serve one view that still references the previous widget URL; the next load is correct.

## Costs

See [docs/costs.md](costs.md) for a sketch of free-tier vs paid-tier math.
