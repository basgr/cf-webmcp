# Local testing

You can run the full `cf-webmcp` stack on your own machine without touching Cloudflare. The local stack is two processes:

1. A tiny Node static server on `http://localhost:8081` that serves the example-site fixture (the "origin").
2. The Worker on `http://localhost:8787` via `wrangler dev` (uses Miniflare under the hood).

Visit `http://localhost:8787` and you are hitting the Worker, which proxies to the local origin, injects the bootstrapper, exposes the manifest, and handles tool calls.

## Prerequisites

- Node.js 20 or higher.
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
- `http://localhost:8787/_webmcp/bootstrap.<hash>.js` - the registration script that runs in agent-driven browsers. Hash matches `config_hash` in the manifest.
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

## What is not available locally

- **R2-backed widget.** Local dev uses `fallback_widget = false`. Desktop MCP client pairing flow is exercised in real deploys against R2, not locally.
- **CF Analytics Engine metrics.** `/_webmcp/health` returns `null` for executor metrics in local dev.
- **Bot Management bypass.** Headers are sent on origin fetches but the local origin has no WAF to bypass.

## Restart loop

If you change the TOML or any source file, `wrangler dev` hot-reloads the Worker automatically. The build pipeline reruns on save because `npm run dev:worker` chains `npm run build` first, then `wrangler dev` watches for file changes. If you change the config hash, the manifest `ETag` rotates.
