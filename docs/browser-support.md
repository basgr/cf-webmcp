# Browser support

WebMCP is the W3C draft at [`webmachinelearning/webmcp`](https://github.com/webmachinelearning/webmcp). A page registers tools with the browser's WebMCP runtime at `document.modelContext`. cf-webmcp's injected bootstrap does that for the `[[tools]]` in your TOML, and a browser that implements the declarative part of the draft turns the form attributes stamped from `[[forms]]` into tools of its own.

Where it runs, as of October 2026:

| Runtime | How WebMCP is turned on |
|---------|-------------------------|
| Chrome 149 and later | The WebMCP origin trial: the site sends a trial token, the visitor does nothing. See [The Chrome origin trial](#the-chrome-origin-trial). |
| Chrome without a token | The flag `chrome://flags/#enable-webmcp-testing`, for local development and testing. See [Local development: the flag](#local-development-the-flag). |
| Cloudflare Kitesurf | Supports `document.modelContext` and runs declarative form tools. See [Cloudflare Kitesurf and Browser Run](#cloudflare-kitesurf-and-browser-run). |
| Cloudflare Browser Run lab sessions | Expose `navigator.modelContextTesting`, the consumer side. |

We have not checked other browsers. A visitor whose browser has no WebMCP runtime sees the landing page's "Not connected" state, or "Pairing required" when the site has the fallback widget on (see [Visitors without WebMCP](#visitors-without-webmcp)).

## The API the bootstrap uses

- `document.modelContext.registerTool(definition, { signal })` registers a tool. The bootstrap passes one `AbortController` signal per tool; from Chrome 153, aborting it unregisters the tool. Older builds ignore the second argument.
- `document.modelContext.getTools()` lists the registered tools, and a `toolchange` event on `document.modelContext` fires when the list changes. A name registered twice kills the Chrome renderer, so the bootstrap skips every name already on the page: the `toolname` of an element (a stamped `<form>`, say), a name `getTools()` lists, or a name an earlier run of the bootstrap registered. If `getTools()` has not answered after 1500 ms, it registers without that answer, still skipping the other two kinds.
- Each tool carries the annotations `readOnlyHint`, `untrustedContentHint` and `consequentialHint`, from `[tools.annotations]` or the executor type's defaults. Chrome also reads `debugging` (from Chrome 156); cf-webmcp does not set it.
- Chrome 146 to 149 expose the API as `navigator.modelContext`, now a deprecated alias. The bootstrap and the landing page use `document.modelContext` when it can register tools and fall back to the alias.

## The Chrome origin trial

From Chrome 149, Chrome turns WebMCP on for a page whose HTML response carries a valid token for the WebMCP trial in an `Origin-Trial` header. The visitor sets nothing.

1. Register for the WebMCP trial with your site's origin at the [Chrome Origin Trials console](https://developer.chrome.com/origintrials/). Sign-up opened on 9 June 2026. The console issues a token.
2. Put the token in your TOML:

   ```toml
   [origin_trial]
   tokens = ["<token from the Chrome Origin Trials console>"]
   ```

3. Build and deploy. `/_webmcp/health` lists each token's feature and expiry under `origin_trials`, never the token itself.

The Worker sends each token as its own `Origin-Trial` header on:

- every proxied `200` whose `Content-Type` is `text/html`, whether or not the page is injected into (an excluded path, `inject_html = false` and a non-UTF-8 page get it too);
- a `304` that answers a page load (a GET or HEAD whose `Sec-Fetch-Dest` is `document`, `iframe` or `frame`, or whose `Accept` names `text/html`), because Chrome merges a 304's headers into the copy it has cached;
- the landing page (not its redirect).

A token that origin already sends on the response is not added a second time, and no other response carries the header. The tokens are part of `INJECTION_HASH`, so changing them changes the `ETag` of rewritten pages and browsers fetch those pages again.

Chrome ignores a token it cannot use without saying so, so the build checks each token the way Chrome reads it, and fails when a token:

- is malformed;
- is a third-party token (Chrome does not accept one in a header on a first-party page);
- was issued for another origin than the site's (`[site].public_url`, else `https://<[site].domain>`), unless it is a subdomain token for a parent of the site's host;
- has expired;
- is listed twice.

A token that expires within 30 days builds with a warning. The signature is not checked; that is Chrome's job. Build messages name a token by its first few characters only.

### Apex and www

The build checks every token against one origin, the site's, while a Worker that serves both `example.com` and `www.example.com` sends the same tokens on both hosts. A token for `www.example.com` alone fails the build when the site origin is `https://example.com`, and a token for the apex alone fails it when the site origin is `https://www.example.com`. Register the trial once, for `https://example.com` with subdomains matched (the token's `isSubdomain`). That one token passes the build whichever host is the site origin, and Chrome accepts it on both hosts.

### A development TOML that inherits production

`inherits` copies every top-level block the child does not set, `[origin_trial]` included. When the development TOML points `[site]` at localhost (`public_url = "http://localhost:8787"`), the production tokens are for another origin and fail the build. Set an empty list in the development TOML and use the flag below in your local Chrome:

```toml
[origin_trial]
tokens = []
```

## Local development: the flag

Without a token, Chrome turns WebMCP on only behind a flag. Use it for local development and testing:

1. Open `chrome://flags/#enable-webmcp-testing`.
2. Set **WebMCP for testing** to **Enabled**.
3. Click **Relaunch**.

The flag also exposes `navigator.modelContextTesting`, the consumer side (`listTools()`, `executeTool(name, jsonArgs)`), which test harnesses and devtools-driven checks call. Optionally, `chrome://flags/#devtools-webmcp-support` adds a WebMCP panel to DevTools for inspecting and running the registered tools; cf-webmcp does not need it.

![Chrome flag panel with WebMCP for testing and WebMCP support in DevTools both set to Enabled](images/chrome-flags-webmcp.png)

### Checking a page

Run this in the DevTools console:

```js
({
  document_modelContext: 'modelContext' in document,
  registerTool: typeof document.modelContext?.registerTool,
  getTools: typeof document.modelContext?.getTools,
  navigator_alias: 'modelContext' in navigator,
  navigator_alias_registerTool: typeof navigator.modelContext?.registerTool,
  modelContextTesting: 'modelContextTesting' in navigator,
})
```

`registerTool: "function"` means the page has the WebMCP runtime at `document.modelContext`. On Chrome 146 to 149 look at `navigator_alias_registerTool` instead (reading the alias logs a deprecation warning in the console). Where `getTools` is `"function"`, `await document.modelContext.getTools()` on a page the Worker injected into lists the tools the bootstrap registered. The landing page runs the same checks and shows them under **"Diagnostic: what this page detected"**.

## Cloudflare Kitesurf and Browser Run

- **Kitesurf**, Cloudflare's agent browser (part of Browser Run, in free beta), supports `document.modelContext`, so the bootstrap registers the site's tools there as it does in Chrome. Kitesurf also runs declarative form tools, so the attributes cf-webmcp stamps from `[[forms]]` work there too.
- **Browser Run lab sessions** expose `navigator.modelContextTesting` for the consumer side: the agent that drives the session lists and calls the tools a page registered. See [Cloudflare's WebMCP docs for Browser Run](https://developers.cloudflare.com/browser-run/features/webmcp/).

## The `tools` Permissions Policy

WebMCP is controlled by the Permissions Policy feature `tools`, whose default allowlist is `self`: a page and its same-origin frames can use WebMCP, and a cross-origin frame only when the embedding page delegates it. A response header `Permissions-Policy: tools=()` turns WebMCP off for that page, and no tool registers there.

cf-webmcp neither sets nor changes `Permissions-Policy`. A proxied page keeps the header origin sent, and the Worker's own responses, the landing page included, send none. If tools never appear on a page, check whether origin, a plugin or a response header rule at Cloudflare sends `tools=()`.

## Visitors without WebMCP

That is what `fallback_widget = true` is for. The widget is opt-in (off by default) and has [known limits](deployment.md#known-limits-of-the-desktop-bridge). The landing page shows one of three states:

- A browser with WebMCP (Chrome with the trial token or the flag, Kitesurf): green **Connected**. The default landing page registers the tools itself (a custom template does when it includes `{{bootstrap_block}}`); no pairing.
- No WebMCP, the widget on (`fallback_widget = true` and a widget pinned in the build), and a desktop MCP client (Claude Desktop, Cursor, Claude Code, Windsurf): blue **Pairing required**. The visitor starts the bridge in a terminal with `--foreground`, adds it to their MCP client, pastes a pairing token into the widget, and keeps the terminal open while they use the tools. The widget disconnects after 30 minutes without mouse or keyboard activity on the page.
- No WebMCP and no widget: red **Not connected**. There is no path to the tools from this browser.

## What this means for you as a publisher

- Register the WebMCP origin trial and put the token in `[origin_trial].tokens`. That is what turns WebMCP on for Chrome visitors.
- Consider `fallback_widget = true` if desktop-client visitors without WebMCP matter to you. It needs `npm run update-widget` and `npm run upload-widget` before deploy and a bridge program on the visitor's computer, with [known limits](deployment.md#known-limits-of-the-desktop-bridge).
- Run preflight before deploy so you know `/mcp` is uncontested on your domain.
- Test the states yourself (token or flag on, widget on, widget off) before announcing publicly.
