# Vendored WebMCP widget

This directory holds pinned snapshots of [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP), the fallback widget used by `cf-webmcp` for desktop MCP client pairing.

Each version sits in its own subdirectory:

```
vendor/webmcp/
├── current.json                 # { "version": "vX.Y.Z", "sha256": "..." }
├── v0.1.5/
│   ├── webmcp.js                # downloaded asset (gitignored)
│   ├── webmcp.js.sha256         # canonical hash, committed
│   └── LICENSE                  # upstream MIT
└── README.md
```

`webmcp.js` itself is gitignored to avoid bloating the repo. The CI build re-downloads from a pinned release URL, verifies the sha256 in `webmcp.js.sha256`, and uploads it to R2 at deploy time.

To bump:

```
npm run update-widget -- --version=v0.1.6 --sha256=<expected>
```

The script fails the pin if the downloaded file does not match the expected hash. Always pull the upstream LICENSE file alongside.
