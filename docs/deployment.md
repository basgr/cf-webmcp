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

## Deploy

```bash
npm run deploy
```

This chains `npm run build` (compiles TOML to TypeScript modules) and `wrangler deploy`. The first deploy provisions the Worker and binds the R2 bucket if configured. Subsequent deploys re-upload the bundle and rotate the `CONFIG_HASH`.

After deploy, hit `https://yourdomain.com/_webmcp/health` to confirm the Worker is alive and the config hash matches.

## Origin and allowed_origins safety

`[origin].base_url` and `[origin].allowed_origins` decide which hosts the Worker is permitted to fetch from. A few rules to keep this safe:

- **Never put internal/RFC1918 IPs in `allowed_origins`.** Values like `http://10.0.0.5`, `http://192.168.1.1`, or `http://169.254.169.254` would let the Worker reach private services that the publisher has accidentally exposed to Cloudflare's network. CF Workers does not expose its own metadata service, but a publisher's own private infra is fair game from inside the Worker. Stick to publicly-reachable HTTPS origins.
- **Use one origin per deployment.** `allowed_origins` is a defence-in-depth measure, not a multi-tenant feature. If you genuinely need multiple origins (e.g. CDN + API on different hosts), list all of them; otherwise keep it to one.
- **The Worker double-checks the post-redirect URL.** If your origin 301s to a host outside `allowed_origins`, the Worker refuses to relay the response. This is intentional and prevents an open-redirect at origin from defeating the allow-list. If you have a legitimate cross-host redirect, add the target to `allowed_origins`.

## Subresource Integrity (SRI) on the injected bootstrap

Since v0.3.6 the injected `<script src="/_webmcp/bootstrap.<hash>.js" defer>` tag carries `integrity="sha384-..."` and `crossorigin="anonymous"`. Browsers refuse to execute the bootstrap if its body has been substituted between server and client (compromised CDN node, intermediary cache poisoning). Toggle via `[features].subresource_integrity` (default `true`).

If the origin publishes a Content Security Policy with `script-src` restrictions, three cases:

- **`script-src 'self'`** (or anything that lists same-origin) - works without changes; the bootstrap is same-origin so the source-list match covers it. SRI on the tag is independent of CSP and continues to verify the body.
- **`script-src 'strict-dynamic' ...`** (nonce/hash-propagating policy) - the injected `<script src=...>` tag is parser-inserted, not loaded by an already-trusted script, so `'strict-dynamic'` will NOT auto-trust it. Either pin the bootstrap in `script-src` with its SRI hash (see next bullet), or add `nonce-<value>` to the policy and stamp a matching `nonce` on the tag (cf-webmcp does not emit nonces today, so the hash route is simpler).
- **`script-src 'sha384-X'`** (explicit hash allowlist) - add the bootstrap hash from `src/generated/config.ts::BOOTSTRAP_SRI` to your CSP's `script-src` list. The CSP hash-source for an external script and the SRI `integrity` value both hash the response body, so the same `sha384-X` string serves both. It rotates whenever the bootstrap rotates (any TOML change that affects the bootstrap output).

Note: `'unsafe-inline'` has no effect on the bootstrap because the tag uses `src=...` rather than an inline body.

SRI does not defend against prompt-injection content embedded in TOML descriptions; see [`docs/security.md`](security.md) for that boundary.

## Bot Management / WAF

Some Cloudflare products (Bot Management, custom WAF rules, rate-limiting) will see executor calls and origin fetches as bot traffic and may block them. The Worker sends:

- `User-Agent: cf-webmcp/<version>` on origin fetches
- `cf-webmcp-bypass: 1` and `cf-webmcp-deploy-token: <token>` headers

Configure your WAF / Bot Management to allow requests with these headers. Otherwise tool calls will return `origin_4xx` or `rate_limited` envelope errors.

## Caching and the deploy/cache-bust cycle

The Worker uses three cache tiers:

- Deploy-time constants (manifest, landing, llms.txt, robots.txt) - `max-age=300, s-maxage=86400, stale-while-revalidate=604800`, plus `ETag: "<config_hash>"`. Deploy bumps the hash; clients revalidate cheaply.
- Versioned immutable assets (bootstrap.<hash>.js, widget.<hash>.js) - `max-age=31536000, immutable`. New deploys ship at a new URL; old versions age out.
- Tool executor responses - per-tool TTL, cache key derived from `tool_name + sha256(body)`.

No manual cache purge is needed between deploys. CF edge caches roll forward automatically as the hash changes.

## Costs

See [docs/costs.md](costs.md) for a sketch of free-tier vs paid-tier math.
