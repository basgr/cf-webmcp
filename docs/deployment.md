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
- `[origin].base_url` - your real origin URL. Only its origin (scheme, host and port) is used: proxied requests and the merge routes go to that origin with the request's own path, and a path in `base_url` is ignored.
- `[origin].allowed_origins` - list of origins executors may fetch. Usually just your origin.
- Tool URLs in `[[tools]]` - update `sitemap_url`, `feed_url`, `url_template` to point at your site.
- `[origin_trial].tokens` - your token for Chrome's WebMCP origin trial, so Chrome visitors get WebMCP without a flag on the HTML pages the Worker proxies and on the landing page (in route-only mode only on the landing page; see [`docs/browser-support.md`](browser-support.md#the-chrome-origin-trial)).

Two keys in the templates do nothing, and you can delete them: `[origin].forward_cookies` (executors and the Worker's other origin fetches never send the visitor's cookies, whatever it says; the build warns when it is `true`) and `[dev].origin` (nothing reads it; `npm run dev:origin` takes its port from `ORIGIN_PORT`).

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
openssl rand -hex 32                         # a deploy token: 64 hex characters
wrangler secret put CF_WEBMCP_DEPLOY_TOKEN   # sent in a header on the Worker's origin fetches so your origin's WAF can allow them
wrangler secret put CF_WEBMCP_HEALTH_TOKEN   # optional: bearer token for /_webmcp/health; replaces [health].token when set
```

Make the deploy token 32 or more characters of `A-Z`, `a-z`, `0-9`, `_` and `-`; `openssl rand -hex 32` gives one. An origin that echoes request headers can hand the token back, and the Worker takes it out of what it answers, but it matches only two forms: the value as written, and the form `JSON.stringify` writes inside a string. Percent-encoding, JSON escapes (the `\/` some writers put for a slash included), HTML entities and the Worker's own handling of a redirect `Location` leave a token of those characters as it is (a host name aside, which the URL parser writes in lower case, as `openssl rand -hex` writes the token), so the value as written is the form an echo of it takes. A token with other characters can come back in a form the Worker does not match. Nothing helps against an origin that transforms the whole value (base64, a change of letter case, a JSON writer that escapes every character as `\uXXXX`). A token under 16 characters is not searched for at all: replacing so short a string would replace it in ordinary text and drop every header that happens to contain it, so the Worker logs a warning (once per isolate) instead. Preflight warns about a token under 32 characters or with other characters. See [`docs/security.md`](security.md#defence-in-depth-in-cf-webmcp-itself).

## Two deployment modes

**Full proxy (recommended).** Your domain DNS points at Cloudflare, orange-cloud on, Worker route `*example.com/*`. Worker sees every request. All discovery surfaces active: in-page bootstrapper injection, `<link rel="webmcp">` tag, `Link:` HTTP header, manifest at `/.well-known/webmcp`, llms.txt augmentation, robots.txt augmentation, AGENTS.md at `/.well-known/agents.md` (with `/AGENTS.md` and `/agents.md` 301 aliases), API Catalog at `/.well-known/api-catalog` (RFC 9727), Agent Skill at `/.well-known/agent-skills/<slug>/SKILL.md` (with case-variant 301 aliases) and its discovery index at `/.well-known/agent-skills/index.json` (Cloudflare Agent Skills Discovery RFC v0.2.0), and TOML-driven form attribute injection.

**Route-only.** Worker routes only on the specific paths it owns (`/_webmcp/*`, `/.well-known/webmcp` and its `/.well-known/webmcp.json` alias, `/.well-known/agents.md`, `/.well-known/api-catalog`, `/.well-known/agent-skills/<slug>/SKILL.md`, `/.well-known/agent-skills/index.json`, `/mcp`, `/llms.txt`, `/robots.txt`, plus the AGENTS.md and SKILL.md alias paths, and with `ai_catalog` on `/.well-known/ard.json` and its `/.well-known/ai-catalog.json` alias). Lighter touch, but **in-page bootstrapper injection and form attribute injection are both disabled** because the Worker never sees HTML responses. Native-API users can still discover tools via the manifest and AGENTS.md, but auto-registration on page load does not happen and forms must hand-stamp their own attributes in origin HTML.

Recommended: full proxy. Route-only is documented for situations where the publisher cannot route everything through CF.

## Preflight

Before the first deploy, check that the paths the Worker wants to claim are free:

```bash
npm run preflight -- --config=webmcp.toml
```

Reports OK / merge / COLLISION per path. Exits non-zero on hard collisions. Pass `--force` to override. Each probe gets 10 seconds. A probe that fails, or gets no response headers in that time, is an ERROR row and a warning, not a collision; so is a merge row whose body (which preflight reads to judge it) does not finish in time. Any other row is judged by the status and headers alone.

The arguments are `--config`, `--origin` and `--force`, and nothing else. `--config` and `--origin` take a value, written `--config=webmcp.toml` or `--config webmcp.toml` (the two forms are the same). An unknown flag, a stray argument, a flag without a value (`--origin` alone, or `--origin` followed by another flag) and a flag given twice are usage errors: the message goes to stderr, nothing is read or requested, and the exit code is 2. The other exit codes are 0 (no hard collision, or `--force`) and 1 (a hard collision).

Preflight asks `[origin].base_url` as an ordinary client. Once that hostname is routed through the Worker, those requests land on the Worker, and preflight reads the Worker's own answers (the landing page, the manifest, the merged files) back as collisions and merges, so the result says nothing about your origin. Run it before you route the hostname, or against a direct origin hostname with `--origin`: `npm run preflight -- --config=webmcp.toml --origin=https://origin.example.com`. `--origin` takes an `http` or `https` origin with no path, query or userinfo, and changes only the host the probes (and the deploy token) go to. The config is untouched, so the config hash in the result still equals the build's and the result is not flagged stale; editing a copy of the TOML to change `[origin].base_url` would change the hash every time. `CF_WEBMCP_DEPLOY_TOKEN`, if set in your environment, goes out in the same two headers the Worker sends to origin; the Worker does not check those headers, they only let a rule at your origin recognise the request. Like the Worker, preflight sends them only to an origin listed in `[origin].allowed_origins`: a `base_url` outside the list stops preflight with the build's own error before any request (exit code 2), and an `--origin` host outside it is probed without them, with a line that says so (add the host to `allowed_origins` if it should get them). Preflight warns when the token would go over plain `http` to a host other than `localhost`, a name under `.localhost` or a loopback address, and when the token is under 32 characters or has a character outside `A-Z`, `a-z`, `0-9`, `_` and `-` (see [Wrangler setup](#wrangler-setup) above; the warning names neither the token nor its length).

For a directory-form landing path such as `/mcp/`, preflight probes both `/mcp/` and `/mcp`, because the Worker answers browser GETs on both (the second with a redirect); a 200 from origin on either is a collision. Preflight also POSTs a JSON-RPC `initialize` to the same paths. If origin answers 200 with JSON or an event stream, an MCP server lives there. That is a warning, not a collision: GET and HEAD requests get the landing page unless their Accept header asks for text/event-stream; every other method goes to origin, so the server stays reachable for `POST`, `DELETE` and streaming `GET` (see [`docs/scope.md`](scope.md)). A network error skips the probe and never fails preflight. The probe is a real `initialize`, so a stateful MCP server may open a session for it.

With `[features].ai_catalog = true`, preflight probes the ARD manifest path and each of its aliases. In `synthesize` mode a 200 at any of them is a collision. In `merge` mode it also probes `/.well-known/ai-catalog.json`, which the merge reads after a 404 at `ard.json`. At either path:

- a JSON ARD document is a merge;
- JSON that fails the structural check is a warning (the Worker relays it unchanged);
- text or HTML is a collision;
- any status other than 200, 404 or a redirect is a warning, because the Worker serves its generated document there.

When origin answers at `ard.json`, the predecessor is reported as redirected, not merged. See [`docs/ard.md`](ard.md#preflight).

A path is a merge row only in a mode where the Worker fetches origin's file to merge into it: `/llms.txt`, `/.well-known/agents.md` and the agent skill in `merge` mode, `/robots.txt` always, the API catalog and the ARD manifest in `merge` mode. In `synthesize` and `replace` mode the Worker answers without asking origin, so a file at origin is shadowed, and the row is a claim: any 200 is a collision, like the other synthesized routes. Content types are judged the way the Worker judges them (for example, a 200 without a `Content-Type` is mergeable, `text/x-markdown` is mergeable for the agent skill only, and `text/markdown` is not mergeable for `/robots.txt`). The API catalog row is JSON-aware: a valid linkset is a merge, JSON that is not a linkset is a warning (the Worker serves its generated catalog instead of it), and HTML is a collision. The API catalog is not probed when it is not served (with `[features].manifest = false`, see [`docs/api-catalog.md`](api-catalog.md)), and neither is the skills index when it is not served (see [`docs/agent-skills.md`](agent-skills.md)).

A file that origin serves over 1 MiB at a merge row (`/llms.txt`, `/robots.txt`, `/.well-known/agents.md`, the agent skill, the API catalog and the ARD manifest, each in a merge mode) is reported as "too large to merge, relayed unchanged", a warning: the Worker relays it as it came and adds nothing (see [Merge routes and the 1 MiB cap](#merge-routes-and-the-1-mib-cap)). The size is judged before the content, as the Worker does, so an oversize file is a warning even when it is not valid JSON.

If a path collides, either:

- Move the Worker route in your TOML (e.g. `[webmcp_landing].path = "/agents/"`).
- Disable the surface (e.g. `[features].webmcp_landing = false`).

## Pin the fallback widget (optional)

The widget is off unless you switch it on: `[features].fallback_widget` defaults to `false` (the default, WordPress and WooCommerce templates set it to `true` explicitly). Read [Known limits of the desktop bridge](#known-limits-of-the-desktop-bridge) first. If you want desktop MCP client support (`[features].fallback_widget = true`):

```bash
npm run update-widget -- --version=v0.1.13 --sha256=<the "sha256" field of vendor/webmcp/current.json>
npm run upload-widget   # after wrangler.toml has the R2 binding configured
```

For the release this cf-webmcp version pins (v0.1.13), `--sha256` is the `sha256` field of `vendor/webmcp/current.json`; for another release, it is the sha256 of that release's `src/webmcp.js`. `update-widget` checks the downloaded file against it and refuses a mismatch. It does not fetch the upstream LICENSE: when `vendor/webmcp/<version>/LICENSE` does not exist, it writes a placeholder there that points at the upstream file, to be replaced with the real text (the committed v0.1.13 directory has it). What visitors receive carries the license notice of `src/widget-preamble.ts`, a short MIT comment that links to the upstream LICENSE.

`update-widget` writes `vendor/webmcp/current.json`: the version, the sha256 of the upstream file, and what visitors will actually receive (`served_sha256`, `served_sri`, `preamble_sha256`). The R2 object is one composed file, the MIT license preamble followed by the pinned `webmcp.js`, stored under `widget.<first 16 hex of served_sha256>.js`. The Worker serves it as-is, and the landing page's `<script>` carries `integrity="<served_sri>"`.

**Run `upload-widget` BEFORE you deploy** whenever the pin changes. The new Worker advertises the new widget URL and answers 503 for it until the object exists; `GET /_webmcp/health` shows `widget_asset_present`. `upload-widget` verifies the vendored file against `current.json` first and aborts on any mismatch. Do not upload `webmcp.js` by hand with `wrangler r2 object put`: it lacks the preamble, so browsers block the script with an SRI mismatch.

The vendored `webmcp.js` is gitignored. On a fresh checkout, or after pulling a release that changes the pin, run `update-widget` with the version and sha256 from `current.json` first; it re-downloads and verifies the file. The default download URL is `src/webmcp.js` at the version's tag, `https://raw.githubusercontent.com/jasonjmcghee/WebMCP/<version>/src/webmcp.js`; `--release-url` overrides it. (Release v0.1.13 attaches no `webmcp.js` asset. Earlier releases attach a minified build under that name, a different file with a different sha256.) The build itself reads only `current.json`, so CI builds work without the file. If `current.json` has no usable pin (`"version": "unpinned"`, no `served_*` fields, or a version that is not a release tag `vX.Y.Z` like `v0.1.13`), the build still succeeds but warns and ships with the widget disabled. `update-widget` refuses any other `--version` before it downloads anything.

The landing page's pairing steps name the bridge of the same release in every command, `@jason.today/webmcp@<version without the v>`, derived from `current.json` at build time, so a pin change moves them all. The visitor starts the bridge with `--foreground` in a terminal, adds `npx -y @jason.today/webmcp@<version> --mcp` to the MCP client by hand (the page shows the Claude Desktop JSON entry, the Cursor file and the Claude Code command), and gets a pairing token from the client or from `--new`. The page never offers the bridge's own `--config` shortcut; the limits below say why.

Wrangler 4 targets *local* storage when `r2 object put` gets neither `--local` nor `--remote`. `upload-widget` passes `--remote` explicitly so deploy uploads reach the real bucket, and `npm run upload-widget -- --local` writes to the local R2 state that `wrangler dev` reads. Each target reads the bucket name from its own wrangler config and hands that file to wrangler as `--config`: `wrangler.toml` for a deploy upload, `wrangler.dev.toml` for `--local` (the config `npm run dev:worker` starts `wrangler dev` with). `CF_WEBMCP_WRANGLER_CONFIG` overrides both. `upload-widget` runs wrangler through a shell (Windows needs one for `wrangler.cmd`), so before it runs it refuses a bucket name that breaks R2's naming rule (3 to 63 lower-case letters, digits and hyphens, a letter or digit at each end) and a wrangler config path or temporary directory that holds `$`, a backtick, `%`, a quote, `;`, `&`, `|`, `<`, `>` or a line break.

The widget object is keyed by content, not by config hash, so editing your TOML never requires a re-upload. Objects for earlier pins, and any `widget.<8-hex>.js` object named after a config hash by v0.5.x and earlier, are no longer referenced and can be deleted: `wrangler r2 object delete <bucket>/widget.<hash>.js`.

### Known limits of the desktop bridge

The widget pairs the landing page with `@jason.today/webmcp`, a third-party bridge program the visitor runs on their own computer. cf-webmcp pins the release (v0.1.13) and words the pairing steps around the limits of that release; it cannot remove them. Line numbers refer to the upstream source at tag v0.1.13.

- **Windows needs `--foreground`.** Without it the bridge forks its websocket daemon with no terminal attached (`src/websocket-server.js:1252-1277`). On Windows the daemon then calls `process.stdin.setRawMode`, which only a terminal has (`src/websocket-server.js:1504-1514`), and exits at once, so nothing listens for the widget. Run in the foreground in a terminal, it keeps running. The landing tells every visitor to use `--foreground`.
- **The first `--foreground` run on a computer has to be restarted.** It writes the bridge's server token to `~/.webmcp/.env` (`src/websocket-server.js:1421-1427`), but checks the client's side against the value it loaded when it started (`src/config.js:28-31`, `src/websocket-server.js:111-118`), which was empty, so it refuses that side until it is started again. Step 1 on the landing says so. (The forked daemon reads the file the parent has just written, so it does not have this problem, but on Windows it does not run at all.)
- **Start the bridge before the MCP client, and restart the client after the bridge restarts.** The client's side of the bridge (`--mcp`) connects to the daemon when it starts. It reconnects without its token (`src/server.js:216-222`), and the daemon refuses that with 401, so only a first connection to a running daemon works. After a bridge restart, or a reboot, start the bridge and then restart the client.
- **The daemon listens on all network interfaces, not only on localhost** (`httpServer.listen(port)` with no host, `src/websocket-server.js:1459`), on port 4797 unless `--port` says otherwise. Websocket connections are token-gated: the client's side needs the server token from `~/.webmcp/.env`, and a page needs a single-use pairing token, which it trades for a session token. A plain HTTP GET to the port answers `MCP WebSocket server is running` with `Access-Control-Allow-Origin: *` (`src/websocket-server.js:30-45`), so any web page the visitor opens can tell whether the bridge is running.
- **The bridge's `--config <client>` shortcut is not used.** It writes `npx -y @jason.today/webmcp@latest --mcp` into the client's config, so the client would run whatever release is newest, not the pinned one (`src/config.js:56-87`). On Windows, `--config claude` and `--config cline` write under the env-paths data directory (`%LOCALAPPDATA%\Claude\Data\` for Claude Desktop, `src/config.js:89-94`), which Claude Desktop does not read: it reads `%APPDATA%\Claude\claude_desktop_config.json`.
- **The widget disconnects after 30 minutes without mouse movement, clicks, key presses or scrolling on the page.** cf-webmcp sets the widget's `inactivityTimeout` to 30 minutes (the upstream default is 5). Tool calls do not reset the timer. After a disconnect the visitor needs a new pairing token.
- **Upstream releases have stopped at v0.1.13** (GitHub release 2025-03-22, npm 2025-03-23). The repository's main branch has two commits since then. One guards the Windows `setRawMode` call with `process.stdin.isTTY`, which would let the forked daemon run on Windows, but no release contains it. The first-run token and reconnect problems above are unchanged on main.

## Deploy

```bash
npm run deploy
```

This chains `npm run build` (compiles TOML to TypeScript modules) and `wrangler deploy`. The first deploy provisions the Worker and binds the R2 bucket if configured. Subsequent deploys re-upload the bundle. `CONFIG_HASH` changes when a value in the validated config changes (in the TOML or in the TOML it inherits), or when an upgrade adds or changes a default: the hash covers the validated config with every default filled in.

After deploy, hit `https://yourdomain.com/_webmcp/health` to confirm the Worker is alive and the config hash matches. If the `CF_WEBMCP_HEALTH_TOKEN` secret or `[health].token` is set, send it as `Authorization: Bearer <token>`; the secret wins when both are set. With `[health].public = false` and a token set, the endpoint answers 401 without it; with no token at all, it answers 404. With `fallback_widget = true`, `widget_asset_present` should be `true`; `false` means the widget object is missing from R2 (run `npm run upload-widget`), and `null` means the widget is not applicable or could not be checked (feature off, no pinned widget in this build, no R2 binding).

## Origin and allowed_origins safety

`[origin].base_url` and `[origin].allowed_origins` decide which hosts the Worker is permitted to fetch from. A few rules to keep this safe:

- **Never put internal/RFC1918 IPs in `allowed_origins`.** Values like `http://10.0.0.5`, `http://192.168.1.1`, or `http://169.254.169.254` would let the Worker reach private services that the publisher has accidentally exposed to Cloudflare's network. CF Workers does not expose its own metadata service, but a publisher's own private infra is fair game from inside the Worker. Stick to publicly-reachable HTTPS origins.
- **List origins, not URLs.** Only the origin of an `allowed_origins` entry counts (scheme, host and port). A path, query or fragment in it is ignored, so `https://example.com/blog` allows every path on `https://example.com`. The build warns about such an entry; write the origin alone.
- **No credentials in an origin URL.** `base_url` and every `allowed_origins` entry are refused when they hold userinfo (`https://user:password@example.com`, an empty `https://@example.com` included): the Worker uses only their scheme, host and port, so the credentials would never be sent. The same goes for a tool's `sitemap_url` and `feed_url` and for the part of a `url_template` between `://` and the path (its placeholders aside): the Worker's request to origin carries no userinfo. Let origin recognise the Worker by its deploy-token headers instead (see [Bot Management / WAF](#bot-management--waf)).
- **Use one origin per deployment.** `allowed_origins` is a defence-in-depth measure, not a multi-tenant feature. If you genuinely need multiple origins (e.g. CDN + API on different hosts), list all of them; otherwise keep it to one.
- **The Worker checks every redirect target before it requests it.** On its own fetches to origin, that is the tool executors and the merge routes (`/llms.txt`, `/robots.txt`, `/.well-known/agents.md`, the API catalog, the ARD manifest and the agent skill, each when it merges with origin's file), the Worker does not let the runtime follow redirects. It reads each `Location`, resolves it against the current URL, and requests it only if it is an `http` or `https` URL whose origin (scheme, host and port) is in `allowed_origins`. It follows at most 5 redirects. A target that fails the check is never requested, so the `cf-webmcp-bypass` and `cf-webmcp-deploy-token` headers go only to listed origins, on every hop, and an open redirect at origin cannot leak the deploy token. If you have a legitimate cross-host redirect (apex to `www`, for example), add the target to `allowed_origins` and the Worker follows it.
- **What a refused redirect looks like.** A refusal that returns an error keeps the refused host and `Location` out of the response. The Worker writes them to its log (`wrangler tail`) as one line that starts with `cf-webmcp: executor refused an origin redirect` or `cf-webmcp: proxy refused an origin redirect`.
  - Tool executors: a redirect to an origin outside `allowed_origins` returns an `invalid_input` error. More than 5 redirects, or a `Location` that is not a usable `http` or `https` URL, returns an `internal` error. The messages are fixed text.
  - Merge routes: a redirect to an origin outside `allowed_origins` is relayed to the client as it came: the same status, the `Location` resolved to an absolute URL (any userinfo removed; left out when it holds the deploy token, like any header of origin's that does), no body and `Cache-Control: no-store`. The relay carries `X-Robots-Tag: noindex` on the routes under `/.well-known/` (`agents.md`, the API catalog and the agent skill) and no `X-Robots-Tag` on `/llms.txt` and `/robots.txt` at their default apex paths, which never carry one, whatever they answer. (The exception belongs to the path: if `[llms_txt].path` or `[robots_txt].path` is set under the namespace or `/.well-known/`, that file carries `noindex` on every answer like any other route there.) The Worker sends no request to that target and no deploy token with the relay. This keeps a crawler's `/robots.txt` fetch from turning into a 5xx when origin redirects between apex and `www`. The ARD manifest (`/.well-known/ard.json`) in `merge` mode differs: it never relays a redirect or an error. When origin answers 404 at its path, it asks origin for the predecessor path `/.well-known/ai-catalog.json` and judges that answer by the same rules. It answers with its own generated document whenever the origin fetch ends in anything but a 200 (a 404 at both paths, a redirect, a 5xx, a failed fetch or a timeout included); after anything but a 404 at both paths, and after a body that fails while it is read, it does so with `Cache-Control: public, max-age=60, s-maxage=60`. A 200 declared as JSON (`application/json`, any `application/<x>+json`, or no `Content-Type`) of at most 1 MiB gets our entry merged in when it passes the structural check (an object with an `entries` array of objects with a string `identifier`), and is relayed unchanged (origin's bytes and headers) with `X-Robots-Tag: noindex` when it does not. A larger one, and any other 200, is relayed with `X-Robots-Tag: noindex` too. See [`docs/ard.md`](ard.md#merge-mode).
  - Merge routes, other failures: more than 5 redirects, an unusable `Location`, or a `[origin].base_url` that is not in `allowed_origins` answer 502 with a fixed message. A failed connection is also a 502. If origin has not sent its response headers within 10 seconds, the Worker gives up and answers 504. The 502 and the 504 carry `X-Robots-Tag: noindex` on the routes under `/.well-known/` and no `X-Robots-Tag` on `/llms.txt` and `/robots.txt` at their apex paths. (The ARD manifest answers its generated document instead, see above.) The deadline ends when the headers arrive, so it does not limit how long origin takes to send the body.
  - Merge routes, an origin answer they cannot merge: a 5xx, an HTML page, a non-text type or a text body over 1 MiB (see [Merge routes and the 1 MiB cap](#merge-routes-and-the-1-mib-cap)) is relayed as it came. Under `/.well-known/` the Worker sets `X-Robots-Tag: noindex` on it; on `/llms.txt` and `/robots.txt` at their apex paths it removes any `X-Robots-Tag`, including one origin sent. The ARD manifest relays only a 200: one that is not JSON (an HTML page, say), JSON that fails its structural check, or a body over 1 MiB. It replaces every non-200 answer with its generated document.
- **Redirects on proxied pages are not followed by the Worker.** For ordinary page requests the Worker passes an origin 3xx to the visitor's browser with the status, body and `Location` that origin sent, and adds only the `Link` header (when `[features].link_header` is on). No deploy token is attached to those requests.

## Merge routes and the 1 MiB cap

The merge routes fetch origin's file and splice their block into it: `/llms.txt`, `/robots.txt`, `/.well-known/agents.md`, the API catalog, the agent skill and the ARD manifest, each in `merge` mode (`/robots.txt` has no other served mode). A route in `synthesize` or `replace` mode never fetches origin's file, so none of this applies to it. They read at most 1 MiB (1,048,576 bytes) of origin's body. Beyond that, and when the read fails, all six do the same, except `/robots.txt` on a failed read:

- **A file over 1 MiB is relayed, not merged.** The size is judged from `Content-Length` when origin sends one (then not a byte is read for the check), otherwise by reading until the body passes the cap. Either way the visitor gets origin's response as it came: its status, its headers (`ETag` included) and the body, streamed through, with no block added. If the stream fails after the cap, the visitor gets a truncated body and cannot tell: the status line and headers have been sent, the same as for any proxied response. A file of exactly 1 MiB is still merged. `X-Robots-Tag` follows the route: `noindex` on the routes under `/.well-known/`, and none on `/llms.txt` and `/robots.txt` at their apex paths, with any `X-Robots-Tag` origin sent removed (under the namespace or `/.well-known/`, a path you moved either of them to carries `noindex` like any other route there).
- **A body that fails before the cap** (a connection reset, say) is a failed origin. The route answers with what it serves when origin has no file (the block alone, or the synthesized catalog or document) and `Cache-Control: public, max-age=60, s-maxage=60`, so origin's own file is back within a minute once origin is. Without this, a read that failed halfway ended in the platform's error page, which carries no `X-Robots-Tag`. `/robots.txt` answers differently: its block alone would be a robots.txt without origin's own `Disallow` rules, more permissive than the site's, so it answers `503` with `Retry-After: 60` and `Cache-Control: no-store` (and no `X-Robots-Tag` at the apex path). Crawlers treat a 5xx robots.txt as a temporary error and not as permission: Google reads it as if the whole site were disallowed until it can fetch the file again, and retries a 503 soon.
- **Everything else is as before.** A 404 gets the block alone with the route's normal cache; a 5xx, an HTML page or a non-text type is relayed as it came; the cap does not change which origin answers are merged.
- **The deploy token is taken out of every answer.** With the `CF_WEBMCP_DEPLOY_TOKEN` secret set (16 characters or more), all six drop every header of origin's whose value holds the token, as origin's answer arrives, and replace the token in the body with `[redacted]`, in a merged file and in an origin answer they relay, because an origin that echoes request headers would otherwise hand it to the client (see [`docs/security.md`](security.md#defence-in-depth-in-cf-webmcp-itself)). A header the Worker sets itself (`Content-Type`, `Cache-Control`, `X-Robots-Tag`, the ARD manifest's `ETag`, CORS) is never dropped. A relayed body and every merged file but the ARD manifest's are streamed through that check, so the answer carries no `Content-Length`; the ARD manifest checks its merged document whole, before it hashes it for the `ETag`. Wherever these docs say a merge route relays an answer as it came, that holds apart from this.

`npm run preflight` reports a file over the cap as "too large to merge, relayed unchanged" (see [Preflight](#preflight)).

## Subresource Integrity (SRI) on the injected bootstrap

Since v0.3.6 the injected bootstrap tag (since v0.6.0 `<script src="<request origin><namespace>/bootstrap.<hash>.js" defer>`, `/_webmcp` being the default namespace) carries `integrity="sha384-..."` and `crossorigin="anonymous"`. Browsers refuse to execute the bootstrap if its body has been substituted between server and client (compromised CDN node, intermediary cache poisoning). The fallback widget's `<script>` on the landing page carries the same attributes. Toggle via `[features].subresource_integrity` (default `true`).

The URL and the hash always describe the same bytes: `<hash>` in `bootstrap.<hash>.js` is the first 16 hex of the sha256 of the bootstrap body, so a browser that cached an older bootstrap under its immutable URL can never be handed a newer body (and an SRI failure) at that URL.

If the origin publishes a Content Security Policy with `script-src` restrictions, three cases:

- **`script-src 'self'`** (or anything that lists same-origin) - works without changes; the bootstrap is same-origin so the source-list match covers it. SRI on the tag is independent of CSP and continues to verify the body.
- **`script-src 'strict-dynamic' ...`** (nonce/hash-propagating policy) - the injected `<script src=...>` tag is parser-inserted, not loaded by an already-trusted script, so `'strict-dynamic'` will NOT auto-trust it. Either pin the bootstrap in `script-src` with its SRI hash (see next bullet), or add `nonce-<value>` to the policy and stamp a matching `nonce` on the tag (cf-webmcp does not emit nonces today, so the hash route is simpler).
- **`script-src 'sha384-X'`** (explicit hash allowlist) - add the bootstrap hash from `src/generated/config.ts::BOOTSTRAP_SRI` to your CSP's `script-src` list. The CSP hash-source for an external script and the SRI `integrity` value both hash the response body, so the same `sha384-X` string serves both. **The bootstrap URL and its SRI hash rotate whenever the bootstrap bytes change**: a change to `[[tools]]` (a name, title, description, input schema or annotations, or the executor type or an `http_json` tool's `method` when that changes the tool's default annotations: a `POST` tool defaults to `readOnlyHint` false and `consequentialHint` true) or to `[paths].namespace`, and also a cf-webmcp upgrade whose generated bootstrap differs, even with an unchanged TOML. Other TOML edits leave both alone. Update `script-src` with each deploy that changes `BOOTSTRAP_SRI`. The widget has its own hash, `WIDGET_SRI` in the same file; it changes only when the widget pin or the license preamble changes, not when you edit the TOML.

Note: `'unsafe-inline'` has no effect on the bootstrap because the tag uses `src=...` rather than an inline body.

SRI does not defend against prompt-injection content embedded in TOML descriptions; see [`docs/security.md`](security.md) for that boundary.

## Bot Management / WAF

Some Cloudflare products (Bot Management, custom WAF rules, rate-limiting) will see executor calls and origin fetches as bot traffic and may block them. The Worker sends:

- `User-Agent: cf-webmcp/<version>` on origin fetches
- `cf-webmcp-bypass: 1` and `cf-webmcp-deploy-token: <token>` headers, only on requests to origins (scheme, host and port) listed in `allowed_origins`, redirect targets included

Configure your WAF / Bot Management to allow requests with these headers. Otherwise tool calls will return `origin_4xx` or `rate_limited` envelope errors. The Worker does not read these headers itself and has no bypass mode: they exist only so a rule at your origin can recognise the Worker's traffic (and preflight's).

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

## Cloudflare WebMCP Labs on the same zone

Cloudflare WebMCP Labs, a developer preview, injects a script into the zone's pages. As observed on 4 October 2026 (dashboard: Agent Readiness > Labs > WebMCP), the tag reads:

```html
<script type="module" src="/.webmcp/bridge.js" data-packs="c2pa,mcp-server-client" data-mcp-url="/mcp">
```

The script path, `/.webmcp/bridge.js`, and `data-mcp-url="/mcp"` are what the points below rely on. In the same observation the bridge registered WebMCP tools of its own on the page, `scan_images_c2pa` and `inspect_image_c2pa`, and tools it proxied from the site's MCP server at `data-mcp-url`. Labs is a preview, so any of this may change. Labs and cf-webmcp can run on the same pages:

- **`/mcp`.** The bridge talks to the MCP server at `/mcp`, which is also the default landing path. The landing page answers only GET and HEAD requests whose `Accept` does not contain `text/event-stream`. Every other method, and a GET or HEAD that asks for an event stream, goes to origin, so the bridge's MCP requests reach whatever origin serves at `/mcp`, while a browser that opens `/mcp` gets the landing page. The landing page sends `Vary: Accept`, and so does the redirect that a landing path ending in `/` has. To leave `/mcp` to the MCP server entirely, move the landing page (`[webmcp_landing].path = "/pair"`) or switch it off (`[features].webmcp_landing = false`). See [`docs/scope.md`](scope.md) for the full rule.
- **Tool names.** A name registered twice on one page kills the Chrome renderer. The build refuses `scan_images_c2pa` and `inspect_image_c2pa` as `[[tools]]` and `[[forms]]` names. The tools Labs proxies from your MCP server are named by that server, and the build cannot see them: keep your `[[tools]]` and `[[forms]]` names distinct from them. The bootstrap skips a name that `getTools()` already lists when it registers, but a name the bridge registers after that is not seen. When it runs, and only in a browser with WebMCP, the bootstrap looks once for the bridge's `<script>` in the page and, if it is there, logs a note with `console.info`.
- **`/.webmcp/bridge.js`.** Whether Cloudflare answers `/.webmcp/*` before the Worker runs or sends those requests through the Worker is not verified. A request that reaches the Worker is proxied to `[origin].base_url` like any other path, and origin most likely has no such file. With `[paths].namespace = "/.webmcp"` the Worker itself answers those requests with `404`, so do not use that namespace with Labs. Check with `curl -sI https://example.com/.webmcp/bridge.js`. If the answer is not the bridge script, exclude the path from the Worker with a route that is not associated with a Worker, such as `example.com/.webmcp/*`, one for each host the Worker serves (`www.example.com/.webmcp/*` too). Cloudflare documents that when more than one route pattern matches, the most specific one wins, and that a route without a Worker negates less specific patterns ([Workers routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)), so such a route takes those requests away from the Worker's broader route (`*example.com/*`, say). Check again afterwards. A route-only deployment, whose routes do not cover `/.webmcp/*`, needs no exclusion. This advice is for a Worker on routes; we have not checked how to exclude a path for a Worker attached as a Custom Domain.
- **One origin-trial token covers both.** The WebMCP trial token turns WebMCP on for the page, and both scripts register their tools with that one runtime. Set it once in `[origin_trial].tokens` (see [`docs/browser-support.md`](browser-support.md#the-chrome-origin-trial)). The Worker sends it on the HTML pages it proxies and on the landing page. In route-only mode the Worker sees only its own paths, so only the landing page carries the tokens. To turn WebMCP on for your other pages, have origin send the `Origin-Trial` header.

## Caching and the deploy/cache-bust cycle

The Worker's caching falls into four groups:

- Documents generated at build time (the manifest, the landing page, the synthesized ARD manifest) - the `Cache-Control` of their `[cache]` keys (the manifest by default `public, max-age=300, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=86400`; the landing page and the ARD manifest have their own `landing_*` and `ai_catalog_*` keys), plus a strong `ETag` that is the first 16 hex chars of the sha256 of the exact body. The tag moves exactly when the bytes do, whether the TOML, the widget pin or a cf-webmcp upgrade moved them. The manifest's body holds its `generated_at` time, so its tag moves with every build. An ARD manifest merged with origin's in `merge` mode is hashed per request, over the bytes served (after the deploy token is taken out); one relayed from origin keeps origin's headers. The Worker does not answer `If-None-Match` with `304` on these routes: it always sends the full body. llms.txt, robots.txt, agents.md, the API catalog and the agent skill are assembled per request and carry no `ETag` of their own; when one of them relays origin's answer as it came (an error, a body it does not merge, or a file over the 1 MiB merge cap), origin's headers go with it, its `ETag` included.
- Content-addressed immutable assets (bootstrap.<hash>.js, widget.<hash>.js) - `public, max-age=31536000, immutable`. `<hash>` is derived from the served bytes (bootstrap: sha256 of the script; widget: sha256 of the R2 object, from `vendor/webmcp/current.json`), so the URL changes exactly when the bytes change and each URL is safe to cache forever. A request for any other `bootstrap.<x>.js` or `widget.<x>.js` under the namespace (a URL from a previous deploy) gets `404` with `Cache-Control: no-store` and `X-Robots-Tag: noindex`, and is never proxied to origin.
- Proxied pages - origin's caching headers, with one change to the validators of the pages the Worker rewrites (an HTML `200` it injects into): origin's `ETag` gets `-<INJECTION_HASH>` inside the quotes (`"abc"` becomes `"abc-<hash>"`, `W/"abc"` becomes `W/"abc-<hash>"`) and `Last-Modified` is dropped; a page without an `ETag` from origin gets none. `INJECTION_HASH` (16 hex chars, in `src/generated/config.ts`) covers what shapes the injected output: whether a page is injected at all (`[features].inject_html`, `[injection]`), the script's URL and `integrity` hash, the link tags, `[[forms]]`, `[origin_trial]`, the rewriter's source code (`src/injection/html-rewriter.ts`, with the values it imports from other modules, such as the ARD link's `rel`) and the cf-webmcp version. A TOML edit that touches none of these, nor `[[tools]]` (which reach the page through the script's URL), leaves it alone, so pages in browser caches stay valid. On the way to origin the Worker removes the current suffix from `If-None-Match` and `If-Match`, so origin can still answer `304` and a conditional `PUT` or `DELETE` meets origin's own tag, and it puts the suffix back on that `304`'s `ETag`; such a `304` also loses `Last-Modified`. A GET or HEAD whose `Accept` names `text/html`, on a path the Worker rewrites, keeps `If-None-Match` only when every entry carries the current suffix and never sends `If-Modified-Since`: a copy rewritten by an earlier build, or cached before v0.6.0, is answered in full. That also applies when the answer turns out not to be rewritten (a non-UTF-8 page, say), which costs a full response there, never a stale one. Every other request (images, CSS, scripts, JSON, a script's `fetch()` with `Accept: */*`) keeps its validators, and every response the Worker does not rewrite keeps origin's. So a copy cached before v0.6.0, which carries origin's own validators and cannot be told apart from a page the Worker never rewrote, is not refreshed by such a request: origin can go on answering `304`, and that copy keeps pointing at the old bootstrap URL until origin's page changes or the copy leaves the cache.
- Tool executor responses - per-tool TTL (`[tools.cache]`, else `[cache].executor_defaults`) in the Workers Cache API, under a key derived from `version + config_hash + tool_name + sha256(input)` (the cf-webmcp version and `CONFIG_HASH`), so an upgrade or a config change starts a fresh cache. The input is the canonical JSON (keys sorted, no whitespace) of the properties the tool declares in `input_schema`, which are also the only properties an executor is given: a request body's key order, whitespace and undeclared keys do not make a second entry, and a different declared value does. Only successful envelopes are cached, and they are stored without CORS headers: `Access-Control-Allow-Origin` is worked out for each request, a cache hit included. An `http_json` tool with `method = "POST"` sends the properties of its validated input that its `input_schema` declares to origin as the JSON body (`content-type: application/json`; `{}` for a tool that declares none), and may change something there. What a caller sent beyond the declared properties (validation tolerates unknown properties, and the exec route drops them before the executor, the URL template or the cache key sees the input) is never in the body, and the build refuses `__proto__`, `constructor` and `prototype` as property names. The tool is **not cached** unless `[tools.cache]` sets `s_maxage` to a number greater than 0 (the lifetime of the Worker's own cache); the other fields fall back to `[cache].executor_defaults` as for any tool. `max_age` alone (a browser lifetime, and a browser does not cache a POST), `swr` and `sie` alone, an empty table and `s_maxage = 0` leave the tool uncached. The build warns about a `[tools.cache]` that has no `s_maxage` and so has no effect; an explicit `s_maxage = 0` is read as "never cache" and gets no warning. An uncached tool answers `Cache-Control: no-store`. Every exec answer that comes from a tool run carries `X-Webmcp-Cache`: `HIT` (served from the Workers cache), `MISS` (run, and stored when it succeeded and the tool is cached) or `BYPASS` (run, and the tool does not use the cache). For a caller from a listed `[cors].allowed_origins` origin the answer also carries `Access-Control-Expose-Headers: x-webmcp-cache`, so a script on that origin can read it. A POST tool's `readOnlyHint` and `consequentialHint` default to `false` and `true` (what origin does with the body is unknown); `[tools.annotations]` overrides each.

No manual cache purge is needed for the Worker's own assets between deploys; CF edge caches roll forward automatically as the hashes change. A browser that revalidates a rewritten page after a deploy that changed the injection gets the new page. The exception is HTML used without asking: a copy that is still fresh under origin's `Cache-Control`, or one that a cache in front of the Worker keeps. Such a page still points at the previous bootstrap URL, which now answers 404, so tools are not registered on that view until the copy expires or the page is reloaded. Keep HTML freshness short, or purge such caches after a deploy that rotates the bootstrap. The same applies briefly to the `/mcp` landing page after a widget pin change: its `stale-while-revalidate` window can serve one view that still references the previous widget URL; the next load is correct.

## Costs

See [docs/costs.md](costs.md) for a sketch of free-tier vs paid-tier math.
