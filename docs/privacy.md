# Privacy posture

What the Worker sees, what it logs, what it forwards.

## What the Worker sees

In full-proxy mode, every request to the publisher's domain passes through the Worker. The Worker can read URL, headers, cookies, and body of incoming requests. For responses from origin, it can read body and headers before forwarding.

In route-only mode, the Worker only sees requests on Worker-claimed paths.

## What the Worker logs

By default, **nothing identifying**. The Worker logs only:

- `tool_name + status_code + duration_ms` per executor call (visible in Analytics Engine if bound).
- Wrangler `logpush = false` by default; no full-request logs go to disk.

Specifically the Worker does **not** log:

- Request bodies (executor input).
- Full URLs (which may contain personal data in query params).
- Client IPs.
- Cookies.
- Response bodies.

If you enable `logpush = true` in your `wrangler.toml`, you opt in to Cloudflare's standard request log shape. That includes URL and IP. Do not enable unless you understand the data flow.

## What is forwarded to origin

Executor fetches to the publisher's origin **never forward visitor cookies**. Default `[origin].forward_cookies = false`, with no v1 path to flip it on. Cached executor responses are therefore non-personalized by definition.

Executor fetches send:

- `User-Agent: cf-webmcp/<version>` - stable, not derived from the agent's UA.
- `cf-webmcp-bypass: 1`
- `cf-webmcp-deploy-token: <token>` - so origin's Bot Management can allow our traffic.

That is it. No `Cookie`, no `Authorization`, no `Referer`, no `X-Forwarded-For`.

## Proxied HTML responses

In full-proxy mode the Worker proxies non-Worker paths to origin. For HTML responses it injects two tags: a `<link rel="webmcp">` and a `<script src="/_webmcp/bootstrap.<hash>.js" defer>`. Both reference the same origin. The bootstrapper registers tools with `navigator.modelContext` if available. It does **not**:

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

If `[features].fallback_widget = true`, the widget JS from `jasonjmcghee/WebMCP` is served from R2 on the landing page. The widget creates a localhost-only websocket connection between the visitor's browser and their desktop MCP client. Pairing requires a one-time token the visitor copies from their client. No third-party servers are involved.

## Health endpoint

`/_webmcp/health` exposes config hash, executor success/error counts, and preflight status. It does not expose request bodies, client data, or secrets. If you would rather not expose it publicly, set `[health].public = false` and `[health].token` to a secret.
