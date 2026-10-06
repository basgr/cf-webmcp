# Privacy posture

What the Worker sees, what it logs, what it forwards.

## What the Worker sees

In full-proxy mode, every request to the publisher's domain passes through the Worker. The Worker can read URL, headers, cookies, and body of incoming requests. For responses from origin, it can read body and headers before forwarding.

In route-only mode, the Worker only sees requests on Worker-claimed paths.

## What the Worker logs

By default, **nothing identifying**. The Worker logs nothing about visitors (no client IPs, cookies or request bodies, that is, executor input) and nothing for a request that goes as planned. It writes one error line when something goes wrong, which shows in `wrangler tail` (and in Workers Logs, if you turn them on):

- an origin redirect the Worker refused or could not follow: on an executor every such redirect (a target outside `allowed_origins`, more than 5 hops, an unusable `Location`), on a merge route all but a redirect to an origin outside `allowed_origins`, which is relayed to the client there and not logged. The line holds the origin and path of the start URL and of a refused target, or the unusable `Location` cut at its first `?` or `#`;
- a failed origin fetch on a merge route or an executor: the origin and path, and the error message;
- a tool URL the Worker refused after resolving its `url_template`: for one that does not parse, the URL cut at its first `?` or `#`; for one whose origin is not in `allowed_origins`, that origin. The same for a `sitemap_url` or `feed_url` the Worker cannot use (the origin only);
- an executor that threw: the tool name and the error message;
- an `http_json` origin answer that is not valid JSON: the parser's message, which can quote the start of origin's body;
- an HTML injection error, or a selector that HTMLRewriter rejected: the error message and the selector;
- a `CF_WEBMCP_DEPLOY_TOKEN` under 16 characters, which the Worker does not search its answers for: one warning per isolate, naming neither the token nor its length.

A path can carry personal data (a value a caller put into a path placeholder, say), so treat the log as operator-only.

Logpush is off unless you set `logpush = true` in your `wrangler.toml`. That opts in to Cloudflare's standard request log shape, which includes URL and IP. Do not enable it unless you understand the data flow.

## What is forwarded to origin

Executor fetches to the publisher's origin **never forward visitor cookies**, and neither do the Worker's other fetches to origin (the merge routes). `[origin].forward_cookies` is accepted for old configs and does nothing: setting it to `true` changes no request, and the build says so. Cached executor responses are therefore non-personalized by definition. The proxy is a different path: a proxied page request reaches origin exactly as the visitor sent it, cookies included.

Executor fetches send:

- `User-Agent: cf-webmcp/<version>` - stable, not derived from the agent's UA.
- `cf-webmcp-bypass: 1` and `cf-webmcp-deploy-token: <token>`, when the `CF_WEBMCP_DEPLOY_TOKEN` secret is set, and only to origins listed in `allowed_origins` - so origin's WAF or Bot Management can allow our traffic.
- An `Accept` header naming what the executor reads (`http_get` sends none), and for an `http_json` POST tool `Content-Type: application/json` with a body made of the tool's declared input properties.

That is it. No `Cookie`, no `Authorization`, no `Referer`, no `X-Forwarded-For`.

## Proxied HTML responses

In full-proxy mode the Worker proxies non-Worker paths to origin. For HTML responses it injects `<link>` tags to the discovery documents (`rel="webmcp"` and the others that are on) and a `<script src="https://<the host the visitor used>/_webmcp/bootstrap.<hash>.js" defer>`. Both stay on your own site: the script `src` is taken from the request, so it loads from `www`, `workers.dev` and preview hosts alike and a `<base href>` cannot move it, and the link points at the manifest on your configured site URL. The bootstrapper registers tools with the WebMCP runtime (`document.modelContext`, falling back to the deprecated `navigator.modelContext`) if available. It does **not**:

- Set cookies.
- Make network requests on page load.
- Track the visitor in any way.

Tool calls only happen when an agent (browser-native or paired desktop MCP client) explicitly invokes one.

## GDPR posture

The Worker is a processor in the GDPR sense: it acts on the publisher's behalf, forwards traffic, runs no analytics, sets no cookies. The publisher remains the data controller. No new consent banner is required because the Worker introduces no new tracking.

The publisher should still:

- Update their privacy notice to mention that Cloudflare Workers is in the request path (often already there if they use any CF product).
- If they enable `logpush`, treat that data as standard log data per their existing policy.

## Bot detection bypass header - is it a privacy issue?

The `cf-webmcp-bypass` header tells the publisher's Bot Management that this traffic is the Worker's own origin fetches. It does not bypass any third-party WAF or expose private data. The header is sent only on Worker-to-origin requests, not on responses to visitors.

## The fallback widget

If `[features].fallback_widget = true` (it is off by default), the widget JS from `jasonjmcghee/WebMCP` is served from R2 on the landing page. The widget opens a websocket connection from the visitor's browser to the bridge program on the visitor's own computer (`ws://localhost:<port>`), which relays tool calls to their desktop MCP client. The bridge listens on all of that computer's network interfaces, not only on localhost, and accepts websocket connections only with a token: pairing needs a single-use token the visitor gets from their client or from the bridge. A plain HTTP request to the bridge's port answers with a short banner that any web page may read, so a page can tell whether the bridge is running. No third-party servers are involved. See [Known limits of the desktop bridge](deployment.md#known-limits-of-the-desktop-bridge).

## Health endpoint

`/_webmcp/health` exposes the schema version, the config hash, the build time, the last preflight result, whether the widget object is in R2 (`widget_asset_present`), each origin-trial token's feature, expiry and whether it has `expired` (never the token; `{"error": "undecodable"}` for one that cannot be read), and the tool names with `ok_24h`, `err_24h` and `p95_ms_24h`, which are always `null`. It does not expose request bodies, client data, or secrets. If you would rather not expose it publicly, set a bearer token with the `CF_WEBMCP_HEALTH_TOKEN` secret (or `[health].token`): with a token set, a request without it gets `401`. `[health].public = false` with no token at all turns the endpoint off (`404`).
