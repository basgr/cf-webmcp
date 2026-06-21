# Upgrades and versioning

## v0.5.0: ARD ai-catalog (opt-in)

v0.5.0 adds an [Agentic Resource Discovery (ARD)](https://github.com/ards-project/ard-spec) publisher catalog at `/.well-known/ai-catalog.json`. When enabled, cf-webmcp synthesizes a catalog with one entry derived from the site's Agent Skill and advertises it via four surfaces: a `robots.txt` Agentmap directive, `rel="ai-catalog"` in the HTTP Link header and as an HTML link tag, and a line in llms.txt.

**This feature is OFF by default.** ARD is a v0.9 draft; the media types (`application/ai-catalog+json`, `application/ai-skill+md`) are not yet IANA-registered. Enable only after evaluating spec stability.

To enable:

```toml
[features]
ai_catalog = true

[ai_catalog]
mode = "synthesize"   # or "merge" if your origin already publishes an ai-catalog.json
```

Available modes: `synthesize` (default, generate from config only), `merge` (splice into origin's catalog), `passthrough` (route not registered). See [`docs/ai-catalog.md`](ai-catalog.md) for all config fields.

No breaking changes. Existing TOMLs work unchanged - the new fields all have defaults and the feature gate is `false`.

## v0.4.1: duplicate WebMCP tool-name crash hardening

Registering the same WebMCP tool name twice on one page kills the Chrome renderer (`bad_message` 345, `RFHI_WEBMCP_REGISTER_DUPLICATE_TOOL_NAME`) - a browser-side Mojo IPC validation kill that no `try/catch` can trap. cf-webmcp emits two registration surfaces on a page (the bootstrap's `registerTool` calls and any `<form toolname>` it stamps from a `[[forms]]` rule), so a name shared across `[[tools]]` and `[[forms]]` would crash. v0.4.1 closes this on both ends:

- **Build-time guard.** The build now fails if any name is duplicated within `[[tools]]`, duplicated within `[[forms]]`, or shared between `[[tools]]` and `[[forms]]`. Rename one side to fix. (No action needed unless your config already had such a collision, in which case the build will now tell you.)
- **Runtime de-dupe.** The injected bootstrap scans `[toolname]` elements on the page and skips registering any tool whose name is already declared declaratively - covering names you hand-stamped in origin HTML, which the build cannot see.
- **Host detection order.** The bootstrap now probes `document.modelContext` (current, Chrome 150+) before `navigator.modelContext` (the deprecated 146-149 binding, whose accessor logs a console deprecation warning). No behaviour change on browsers that expose only one.

## v0.4.0: manifest path is extensionless by default

As of v0.4.0 the default WebMCP manifest path is **`/.well-known/webmcp`** (extensionless), matching the convention of IANA-registered well-known suffixes (`api-catalog`, `openid-configuration`). The legacy `/.well-known/webmcp.json` is kept as a **301 redirect alias** by default, so older links and any cached `rel="webmcp"` references keep working.

- No action is required: rebuilding moves the canonical manifest to `/.well-known/webmcp`, advertises that path in the `Link` header / `<link rel="webmcp">` / llms.txt / agents.md, and 301s the `.json` path to it.
- To keep `.json` as the canonical path instead, set `[manifest].path = "/.well-known/webmcp.json"` and `[manifest].aliases = ["/.well-known/webmcp"]` (or `[]` to disable the redirect).
- The injected bootstrap also gained feature detection and a corrected return shape:
  - It registers tools on whichever host object exposes `registerTool` - `navigator.modelContext` (current Chrome Canary) or `document.modelContext` (the Apr 2026 WebMCP draft) - and no-ops when neither is present.
  - Each tool's `execute` now returns the WebMCP/MCP tool-result shape `{ content: [{ type: "text", text }], isError }` instead of cf-webmcp's raw `{ ok, data }` envelope. The full executor envelope is carried as the `text` payload (so the agent keeps structured success/error), and `isError` mirrors `ok: false`. The `POST /_webmcp/exec/<tool>` endpoint itself is unchanged and still returns the envelope; only the in-page registered tool adapts it to the runtime's expected shape.

## Schema version

Every `webmcp.toml` declares `schema_version = 1` at the top. The build script refuses unknown versions. Future breaking changes to the TOML format will bump this number and require a manual migration step.

There are no silent migrations.

## Tool name immutability

Tool names are permanent once they have been advertised in a deployed manifest. If an agent has cached the manifest and the publisher renames `search_products` to `find_products`, the agent's cached tool reference 404s.

Recommended workflow:

- To add capability: add a new tool with a new name.
- To remove capability: delete the tool from the TOML on deploy. Old agents see `not_found` on that tool name. Acceptable.
- To change behaviour of an existing tool: change the executor, leave the name and description stable.

## Config hash

Every deploy computes `CONFIG_HASH` (first 8 hex chars of sha256 over the normalised TOML). The hash:

- Stamps the `ETag` on the manifest, landing, llms.txt, and robots.txt responses.
- Goes into the bootstrap and widget URL paths (`bootstrap.<hash>.js`).
- Appears in `/_webmcp/health` so the operator can confirm which deploy is live.

Clients revalidate against `ETag`. The cache rolls forward automatically on deploy.

## Updating the fallback widget

```bash
npm run update-widget -- --version=vX.Y.Z --sha256=<hex>
npm run upload-widget
```

The sha256 is verified during download. If the upstream release has been replaced or modified, the pin fails. Always pull the upstream LICENSE file alongside the JS.

## Updating the Worker itself

`cf-webmcp` follows semver:

- Patch (`0.1.0` → `0.1.1`): bug fixes, internal changes. Safe to pull and redeploy without TOML changes.
- Minor (`0.1.0` → `0.2.0`): new features, new optional TOML fields. May add new executor types. Existing TOMLs continue to work.
- Major (`0.x` → `1.0`): breaking changes. `schema_version` bumps. Manual TOML migration documented in the release notes.

Subscribe to releases on GitHub to be notified.

## Migration from v0 to a hypothetical v2

When v2 lands, the build script reads `schema_version` and either:

- Migrates in place automatically if the change is backwards-compatible and we ship a migration. The TOML is rewritten on disk with the new version stamp.
- Or fails with a clear message telling the publisher exactly what to change. Migration instructions live in `docs/migrations/v1-to-v2.md`.

No version of `cf-webmcp` will silently accept a TOML with the wrong `schema_version`.
