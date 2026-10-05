# Local testing

You can run the full `cf-webmcp` stack on your own machine without touching Cloudflare. The local stack is two processes:

1. A tiny Node static server on `http://localhost:8081` that serves the example-site fixture (the "origin").
2. The Worker on `http://localhost:8787` via `wrangler dev` (uses Miniflare under the hood).

Visit `http://localhost:8787` and you are hitting the Worker, which proxies to the local origin, injects the bootstrapper, exposes the manifest, and handles tool calls.

## Prerequisites

- Node.js 22 or higher.
- A fresh clone of the repo.

## One-time setup

```bash
npm install
npm run build:schema      # generates schemas/webmcp.schema.json
```

## Run it

You need two terminals (one process per terminal).

**Terminal 1 - origin:**

```bash
npm run dev:origin
```

Serves `templates/example-site/origin/` at `http://localhost:8081`.

**Terminal 2 - Worker:**

```bash
npm run dev:worker
```

Builds the Worker config against `templates/example-site/webmcp.toml`, then starts `wrangler dev` on `http://localhost:8787` using `wrangler.dev.toml`.

## Try it

With both processes running:

- `http://localhost:8787/` - proxied index.html with the bootstrapper injected. View source to see `<link rel="webmcp">` in `<head>` and `<script src="/_webmcp/bootstrap.<hash>.js" defer>` before `</body>`. Response also has a `Link: ...; rel="webmcp"` header.
- `http://localhost:8787/.well-known/webmcp` - the tool catalogue manifest.
- `http://localhost:8787/mcp` - the auto-generated pairing/landing page.
- `http://localhost:8787/_webmcp/bootstrap.<hash>.js` - the registration script that runs in agent-driven browsers. `<hash>` is derived from the script's own bytes (first 16 hex of its sha256); the full URL is in the manifest's `links.bootstrap`. Any other `bootstrap.<x>.js` path answers 404.
- `http://localhost:8787/llms.txt` - merged version of the origin's llms.txt with the WebMCP block appended between markers.
- `http://localhost:8787/robots.txt` - merged version with `Disallow: /_webmcp/exec/` added.
- `http://localhost:8787/_webmcp/health` - operational health JSON.

## Call a tool

Tools use `POST /_webmcp/exec/:tool_name` with a JSON body.

```bash
curl -X POST http://localhost:8787/_webmcp/exec/search_pages \
     -H 'content-type: application/json' \
     -d '{"query":"blog"}'
```

Expected response:

```json
{
  "ok": true,
  "data": {
    "entries": [
      { "url": "http://localhost:8787/blog/hello-world", "lastmod": "2026-05-10" }
    ]
  }
}
```

Try the other tools:

```bash
curl -X POST http://localhost:8787/_webmcp/exec/list_posts -d '{}' -H 'content-type: application/json'
curl -X POST http://localhost:8787/_webmcp/exec/get_page -d '{"path":"/about"}' -H 'content-type: application/json'
```

## Error envelope

Every tool response is wrapped in a stable envelope. Errors look like:

```bash
curl -X POST http://localhost:8787/_webmcp/exec/search_pages \
     -H 'content-type: application/json' \
     -d '{}'
```

```json
{
  "ok": false,
  "error": {
    "code": "invalid_input",
    "message": "missing required field \"query\"",
    "retriable": false
  }
}
```

## Run preflight against the local origin

```bash
npm run preflight -- --config=templates/example-site/webmcp.toml
```

Reports which Worker-claimed paths are free, which will be merged, and which collide. The example-site has `/llms.txt` and `/robots.txt` to merge; everything else is free.

## Pairing end-to-end (fallback widget)

`npm run e2e:pairing` checks the desktop pairing flow with real parts: an MCP client, the bridge CLI the landing page names, the widget in Chrome, the Worker in `wrangler dev` and the example-site origin. It is not part of `npm test`; run it by hand after a change to the widget block, the pin or the bridge version.

Prerequisites:

- The vendored widget file. It is gitignored; fetch it with the version and sha256 from `vendor/webmcp/current.json`: `npm run update-widget -- --version=<version> --sha256=<sha256>`.
- Google Chrome, installed. The script launches it through `playwright-core` (`channel: "chrome"`); set `CHROME_PATH` to use another Chrome or Chromium binary. It never downloads a browser.
- Network access on the first run: `npx` installs the bridge into a temporary npm cache.

```bash
npm run e2e:pairing
```

What it does, in order:

1. Copies `templates/example-site/webmcp.toml` to a temporary file with `fallback_widget = true` and free ports, and builds `src/generated` from it. The landing must name `npx -y @jason.today/webmcp@<pinned version> --config claude`.
2. Runs `npm run upload-widget -- --local`, which puts the composed widget object into the local R2 state of `wrangler.dev.toml`.
3. Starts the origin (`scripts/dev-origin.ts`) and `wrangler dev --config wrangler.dev.toml --port <free port>`, and checks that the Worker serves the widget object with the pinned hash.
4. Starts the bridge's websocket daemon with `npx -y @jason.today/webmcp@<pinned> --port <free port>`, as step 1 on the landing does, then the bridge's MCP side with `--mcp --port <same port>` as a stdio server through `@modelcontextprotocol/sdk`.
5. Gets a pairing token from the bridge's own `_webmcp_get-token` tool, opens the landing in headless Chrome, clicks the widget, pastes the token and waits for "Connected".
6. Asserts that `tools/list` shows the example tools and that `tools/call` of `search_pages` returns the executor envelope as text with `isError: false`, and with `isError: true` for an input without `query`. The bridge prefixes a page's tools with its host, `.` and `:` replaced by `_`: on port 8787 the tool is `localhost_8787-search_pages`.

It prints PASS or FAIL per step, prints the last lines of each process's output on a failure, and exits 1 on any failure.

What it leaves alone: it never passes `--config` to the bridge, so no desktop MCP client config is written. The bridge runs with `HOME` and `USERPROFILE` set to a temporary directory, so its state (`~/.webmcp`: server token, pairing tokens, PID file) lands there and not in your home directory. Ports are picked at run time and passed as arguments; no tracked file changes.

What it changes: `src/generated` (gitignored) is rebuilt from the example-site TOML at the end, as `npm test` builds it. The widget object stays in `.wrangler/state` (gitignored). Every child process (origin, `wrangler dev`, the bridge, the daemon it detaches, Chrome) is stopped on every path, Ctrl+C included, and the script checks that their ports are closed and removes its temporary directory.

Two things in the bridge (`@jason.today/webmcp` 0.1.13) shape the script:

- **Windows.** The daemon calls `process.stdin.setRawMode(true)` on Windows (`src/websocket-server.js:1504-1514`), which only a terminal has. Started without one, as an MCP client starts it, it exits with `TypeError: process.stdin.setRawMode is not a function` and nothing listens on the websocket port. On Windows the script preloads a shim into the bridge's processes (`NODE_OPTIONS=--require`) that gives stdin a no-op `setRawMode`. A visitor's bridge has no such shim.
- **Start order.** The MCP side connects to the daemon 100 ms after it starts, and reconnects without the server token (`src/server.js:216-222`), which the daemon answers with 401. It only connects when the daemon is already running, so the script starts the daemon first, as step 1 on the landing does.

The bridge's websocket port defaults to 4797; the script passes a free one with `--port`.

## What is not available locally

- **R2-backed widget with `npm run dev:worker`.** The example-site config ships with `fallback_widget = false`. The pairing end-to-end above switches it on in a temporary copy and puts the widget into local R2; to try it by hand, do the same: `npm run upload-widget -- --local`, then build from a copy of the config with `fallback_widget = true`.
- **CF Analytics Engine metrics.** `/_webmcp/health` returns `null` for executor metrics in local dev.
- **Bot Management bypass.** Headers are sent on origin fetches but the local origin has no WAF to bypass.

## Restart loop

If you change the TOML or any source file, `wrangler dev` hot-reloads the Worker automatically. The build pipeline reruns on save because `npm run dev:worker` chains `npm run build` first, then `wrangler dev` watches for file changes. If you change the config hash, the manifest `ETag` rotates.
