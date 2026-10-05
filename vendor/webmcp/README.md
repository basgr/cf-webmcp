# Vendored WebMCP widget

This directory holds pinned snapshots of [jasonjmcghee/WebMCP](https://github.com/jasonjmcghee/WebMCP), the fallback widget used by `cf-webmcp` for desktop MCP client pairing.

Each version sits in its own subdirectory:

```
vendor/webmcp/
├── current.json                 # the pin, see below (committed)
├── v0.1.13/
│   ├── webmcp.js                # downloaded asset (gitignored)
│   ├── webmcp.js.sha256         # canonical hash, committed
│   └── LICENSE                  # upstream MIT license, committed
└── README.md
```

`webmcp.js` itself is gitignored to avoid bloating the repo. **Nothing downloads it in CI**: the build reads only `current.json`, so CI and fresh checkouts build without the file. The only step that needs the bytes is `npm run upload-widget`, which runs on a machine where you have first run `update-widget` (it downloads the pinned version and verifies its sha256) and which is followed by a deploy.

## current.json

```json
{
  "version": "v0.1.13",
  "sha256": "<hex sha256 of the upstream webmcp.js>",
  "served_sha256": "<hex sha256 of preamble + webmcp.js>",
  "served_sri": "sha384-<base64 sha384 of preamble + webmcp.js>",
  "preamble_sha256": "<hex sha256 of the preamble text>"
}
```

- `version`, `sha256`: which upstream release is pinned and the hash of its raw file. `"version": "unpinned"` (or a file without the three `served_*` / `preamble_*` fields) builds with the widget disabled and a warning.
- `served_sha256`: the hash of the object visitors receive, which is the MIT license preamble (`src/widget-preamble.ts`) followed by the file bytes. Its first 16 hex characters name the R2 object and the URL, `widget.<hash>.js`, so a widget change always moves the URL and editing your TOML never does.
- `served_sri`: the complete SRI value (`sha384-` plus base64, not hex) for that same object. The build puts it on the landing page's widget `<script integrity>` and exports it as `WIDGET_SRI`.
- `preamble_sha256`: the hash of the preamble the two values above were computed with. If the preamble text changes, the build warns and `upload-widget` refuses to upload until you re-run `update-widget`.

`update-widget` writes all five fields; do not edit them by hand.

## To bump

```
npm run update-widget -- --version=v0.1.6 --sha256=<expected>
npm run upload-widget      # before deploying
```

The script fails the pin if the downloaded file does not match the expected hash. The default download URL is the upstream release asset `webmcp.js`; a release without that asset (v0.1.13 is one) needs `--release-url`, for v0.1.13 `--release-url=https://raw.githubusercontent.com/jasonjmcghee/WebMCP/v0.1.13/src/webmcp.js`. For a version directory that has no `LICENSE` yet the script writes a placeholder; replace it with the upstream file.

`upload-widget` uploads one composed object (preamble plus file bytes) and verifies it against `current.json` first. Never `wrangler r2 object put` the plain `webmcp.js`: it lacks the preamble, so browsers reject it with an SRI mismatch. See [`docs/deployment.md`](../../docs/deployment.md).
