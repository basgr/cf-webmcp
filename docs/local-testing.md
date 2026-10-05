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

- `http://localhost:8787/` - proxied index.html with the bootstrapper injected. View source to see `<link rel="webmcp">` in `<head>` and `<script src="http://localhost:8787/_webmcp/bootstrap.<hash>.js" defer ...>` before `</body>`: the script's `src` is the origin of the request plus `/_webmcp/bootstrap.<hash>.js`. Response also has a `Link: ...; rel="webmcp"` header.
- `http://localhost:8787/.well-known/webmcp` - the tool catalogue manifest.
- `http://localhost:8787/mcp` - the auto-generated pairing/landing page.
- `http://localhost:8787/_webmcp/bootstrap.<hash>.js` - the registration script that runs in agent-driven browsers. `<hash>` is derived from the script's own bytes (first 16 hex of its sha256); the full URL is in the manifest's `links.bootstrap`. Any other `bootstrap.<x>.js` path answers 404.
- `http://localhost:8787/llms.txt` - merged version of the origin's llms.txt with the WebMCP block appended between markers.
- `http://localhost:8787/robots.txt` - merged version with `Disallow: /_webmcp/` added.
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

`npm run e2e:pairing` follows the pairing steps the landing page shows, with real parts: the bridge the page names, an MCP client, the widget in Chrome, the Worker in `wrangler dev` and the example-site origin. It takes the bridge commands from the built page itself. It is not part of `npm test`; run it by hand after a change to the widget block, the pin or the bridge version.

Prerequisites:

- The vendored widget file. It is gitignored; fetch it with the version and sha256 from `vendor/webmcp/current.json`: `npm run update-widget -- --version=<version> --sha256=<sha256>`.
- Google Chrome, installed. The script launches it through `playwright-core` (`channel: "chrome"`); set `CHROME_PATH` to use another Chrome or Chromium binary. It never downloads a browser.
- Network access: `npx` installs the bridge into a temporary npm cache on every run.

```bash
npm run e2e:pairing
```

What it does, in order:

1. Copies `templates/example-site/webmcp.toml` to a temporary file with `fallback_widget = true` and free ports, builds `src/generated` from it, and reads the pairing steps from the built landing: the `--foreground` command, the Claude Desktop entry and the `--new` command.
2. Runs `npm run upload-widget -- --local`, which puts the composed widget object into the local R2 state of `wrangler.dev.toml`.
3. Starts the origin (`scripts/dev-origin.ts`) and `wrangler dev --config wrangler.dev.toml --port <free port>`, and checks that the Worker serves the widget object with the pinned hash.
4. On Windows only: runs the bridge without `--foreground` (`npx -y @jason.today/webmcp@<pinned> --port <free port>`) and checks that the daemon it forks has exited 5 seconds later. That is why step 1 on the landing says `--foreground`.
5. Page step 1: runs the page's `--foreground` command with `--port <free port>` as a long-running child. The bridge's home directory is new, so, as the page says for a first run, it stops it once (after checking that `~/.webmcp/.env` now exists) and starts it again.
6. Page step 2: starts the page's Claude Desktop entry (`npx -y @jason.today/webmcp@<pinned> --mcp`, plus `--port`) as a stdio server through `@modelcontextprotocol/sdk`, and waits until that side has reached the daemon.
7. Page step 3: checks that the page's `--new` command prints a token for the daemon, then gets the token it pairs with from the bridge's own `_webmcp_get-token` tool.
8. Page step 4: opens the landing in headless Chrome, waits for the widget to mount and the step that points at it to appear, clicks the widget, pastes the token and waits for "Connected".
9. Asserts that `tools/list` shows the example tools and that `tools/call` of `search_pages` returns the executor envelope as text with `isError: false`, and with `isError: true` for an input without `query`. The bridge prefixes a page's tools with its host, `.` and `:` replaced by `_`: on port 8787 the tool is `localhost_8787-search_pages`.
10. Opens the landing once more with the widget script answering 503, and checks that the page shows its "could not be loaded" line, keeps the widget step hidden and warns in the console.

It prints PASS or FAIL per step, prints the last lines of each process's output on a failure, and exits 1 on any failure.

What it leaves alone: it never passes `--config` to the bridge, so no desktop MCP client config is written. The bridge's processes run with `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME` and `XDG_DATA_HOME` set to a temporary directory, so the bridge's state (`~/.webmcp`: server token, pairing tokens, PID file) lands there and not in your home directory. Ports are picked at run time and passed as arguments; no tracked file changes.

What it changes: `src/generated` (gitignored) is rebuilt from the example-site TOML at the end, as `npm test` builds it. The widget object stays in `.wrangler/state` (gitignored). Every child process tree (origin, `wrangler dev`, the bridge's daemon and MCP side, every `npx` under them, Chrome) is stopped on every path, Ctrl+C and a command that runs past its time included (`taskkill /T` on Windows), and the script checks that the ports are closed and removes its temporary directory.

The Windows shim: the bridge's daemon calls `process.stdin.setRawMode(true)` on Windows (`src/websocket-server.js:1504-1514` in the bridge's source), which only a terminal has. A visitor runs step 1 in a terminal, where it works. The script starts the daemon as a child process without a terminal, so on Windows, and only for the daemon, it preloads a shim (`NODE_OPTIONS=--require`) that gives stdin a no-op `setRawMode`. The MCP side and the one-shot commands run without it. The limits this script works within are listed in [Known limits of the desktop bridge](deployment.md#known-limits-of-the-desktop-bridge).

The bridge's websocket port defaults to 4797; the script passes free ones with `--port`.

## What is not available locally

- **R2-backed widget with `npm run dev:worker`.** The example-site config ships with `fallback_widget = false`. The pairing end-to-end above switches it on in a temporary copy and puts the widget into local R2; to try it by hand, do the same: `npm run upload-widget -- --local`, then build from a copy of the config with `fallback_widget = true`.
- **CF Analytics Engine metrics.** `/_webmcp/health` returns `null` for executor metrics in local dev.
- **WAF allow-listing.** The deploy-token headers go out on the executors' and the merge routes' fetches to origin (not on proxied page requests) when `CF_WEBMCP_DEPLOY_TOKEN` is set, but the local origin has no WAF that reads them.

## Restart loop

If you change the TOML or any source file, `wrangler dev` hot-reloads the Worker automatically. The build pipeline reruns on save because `npm run dev:worker` chains `npm run build` first, then `wrangler dev` watches for file changes. The manifest's `ETag` is the hash of the manifest body, so it follows the body, not the config hash; the body holds its build time (`generated_at`), so every rebuild moves it.
