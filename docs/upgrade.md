# Upgrades and versioning

## v0.6.0 (in progress)

- **`fallback_widget` now defaults to `false`.** The desktop-bridge widget is opt-in. A TOML that does not set the key loses the pairing flow on upgrade: the landing shows the "Not connected" state and the widget route answers 404. The build prints a notice for such a TOML. To keep the widget, set `fallback_widget = true` under `[features]`, run `npm run upload-widget` before deploying, and read [Known limits of the desktop bridge](deployment.md#known-limits-of-the-desktop-bridge). The default, WordPress and WooCommerce templates set it to `true` explicitly.
- **`{{widget_block}}` now carries the pairing steps.** It renders the "Pairing required" heading, the bridge commands and the widget scripts. A custom landing template copied from the old default must drop its own pairing heading and CLI line, or it renders them twice (see the `{{widget_block}}` row in [`docs/customisation.md`](customisation.md)).
- **ARD moved to v0.91, and skill names follow the Agent Skills name rule.** See [`docs/ard.md`](ard.md). The ARD lines apply with `[features].ai_catalog = true`; the last three apply to every config.
  - The manifest is served at `/.well-known/ard.json` and advertised with `rel="ard"` in the Link header and the link tag; `rel="ai-catalog"` is no longer emitted. The robots.txt `Agentmap:` line and the llms.txt line point at the new path.
  - It is served as `application/json; charset=utf-8` instead of `application/ai-catalog+json`, and the document no longer has a `specVersion` member.
  - `/.well-known/ai-catalog.json` now answers with a 301 to `/.well-known/ard.json` (`[ai_catalog].aliases`, default `["/.well-known/ai-catalog.json"]`; set `aliases = []` to leave it to origin).
  - A config that sets `[ai_catalog].path = "/.well-known/ai-catalog.json"` keeps serving there, and the build warns: consumers of ARD v0.91 MUST fetch `/.well-known/ard.json`. Remove the line or move `path` to the default. A different custom path also warns while `/.well-known/ard.json` is not one of the aliases.
  - The entry identifier changes for some sites. The skill name in it is now built the same way as for the SKILL.md, so accents are removed (`Café` was `caf`, now `cafe`) and some letters are transliterated (`ß` becomes `ss`). The publisher segment is `[site].domain`, lowercased and without its port.
  - `host.identifier` is now `did:web:` plus the host of `[site].public_url` when that is set, with a port written as `%3A`; before, it always used `[site].domain`.
  - The entry's `displayName` is now always `[site].name`, also when `[agent_skills].name` is set.
  - The skill entry's `type` stays `application/ai-skill+md` by default and can be changed with the new `[ai_catalog].skill_type`.
  - Merge mode: an origin document that fails the structural check is now relayed unchanged instead of being replaced by the generated one. When origin answers 404 at `ard.json`, its `/.well-known/ai-catalog.json` is merged instead. When origin already lists an entry with our identifier or our url, origin's entry is kept and ours is not added. Origin documents over 1 MiB are relayed, not merged, and the generated document that stands in for a failed origin is cached for 60 seconds only.
  - Preflight now probes both `/.well-known/ard.json` and `/.well-known/ai-catalog.json`.
  - The build warns when `[site].domain` is not a fully qualified domain name (localhost, an IP address, a single label), and fails with a named error when `[site].public_url` is not an absolute http(s) URL or a port is out of range.
  - `[agent_skills].name` must be lowercase letters and digits in groups joined by single hyphens, at most 64 characters, even with `agent_skills` off. `name = "My Shop"` now fails validation; write `name = "my-shop"`.
  - A `[site].name` with nothing left after slugify (a name only in a non-Latin script, say) now fails the build when a SKILL.md, the skills index or the ARD entry uses the name, instead of falling back to `site`. Set `[agent_skills].name`.
  - A derived name is cut to 64 characters, and letters such as `ß`, `æ` and `ø` are now written as `ss`, `ae` and `o` instead of becoming hyphens (`Grüße Welt` was `gru-e-welt`, now `grusse-welt`). The SKILL.md frontmatter, the skills index and its digest change for such names.
- **Rewritten HTML gets suffixed ETags and no `Last-Modified`.** A page the Worker injects into carries origin's `ETag` with `-<INJECTION_HASH>` inside the quotes, so a deploy that changes the injected output reaches pages a browser revalidates. After deploying v0.6.0, a page load (a request whose `Accept` names `text/html`) that revalidates a copy cached before the upgrade refetches it once, in full. A request without `text/html` in its `Accept` (a script's `fetch()` with `*/*`, say) that revalidates such a copy can still get a `304` from origin and keep the old copy, which points at a bootstrap URL that now answers 404, until origin's page changes or the copy leaves the cache. The manifest and the landing page now send the hash of their own body as `ETag` instead of `CONFIG_HASH`; the ARD manifest gets an `ETag` for the first time. See [Caching](deployment.md#caching-and-the-deploycache-bust-cycle).
- **The bootstrap is addressed by its content alone.** Its first line no longer names the config hash, so `bootstrap.<hash>.js` and its SRI hash move only when `[[tools]]`, `[paths].namespace` or the generator changes, not on every TOML edit. Both change once with this upgrade: a CSP that allowlists the bootstrap by hash needs the new `BOOTSTRAP_SRI`.
- **`[site].public_url` and `[origin].base_url` are validated, which may reject a config that built before.** `public_url` must be an http or https origin: scheme, host (letters, digits, dots, hyphens) and an optional port, with no path (not even a trailing `/`), query, fragment or credentials. The build fails when the origin of `base_url` is not in `allowed_origins`. The error names the field.
- **The rate limiter keys IPv6 clients by /64 and ignores `X-Forwarded-For`.** Addresses in one /64 share a bucket. The key comes from `CF-Connecting-IP`. When that holds a Class E address (240.0.0.0/4), which is what Pseudo IPv4 set to overwrite headers puts there, the real address in `CF-Connecting-IPv6` is used instead; next to any other address `CF-Connecting-IPv6` is ignored, because a client can send one of its own. Requests without `CF-Connecting-IP` share one bucket. A full bucket table evicts its 1024 least recently used entries instead of refusing new clients.
- **Exec CORS is worked out per request.** The exec cache is keyed on the cf-webmcp version and `CONFIG_HASH` and stores no CORS headers, so a cache hit no longer replays the first caller's `Access-Control-Allow-Origin`, and an upgrade or a config change starts a fresh cache. Error answers (405, 404, 400, 413, 429, 5xx) now carry CORS for a listed origin too. While `[cors].allowed_origins` is set, every exec answer sends `Vary: Origin`, except the `OPTIONS` preflight, which sends it only when it answers a listed origin.

## v0.5.1: landing runtime fix, docs overhaul, hardening

Patch release, no config changes required.

- **Landing page probes `document.modelContext` first.** The `/mcp` runtime branching (and its diagnostic) previously probed only the deprecated `navigator.modelContext` alias; it now mirrors the bootstrap's document-first detection, so the Connected state survives the alias's eventual removal and the diagnostic reports both hosts. Custom landing templates should adopt the same probe (see `docs/customisation.md`).
- **Docs overhaul.** All references to the producer API now read `document.modelContext` (with the deprecated `navigator` alias noted); new guidance in `docs/deployment.md` on Cloudflare's September 2026 AI crawler defaults (Agent-category blocking runs before the Worker on new zones; managed robots.txt per-bot `Disallow: /` rules work against agent discoverability) and a matching `docs/limitations.md` entry.
- **`site.domain` validation tightened** to a bare-hostname pattern so a malicious build-time TOML cannot inject CR/LF or quotes into the Link header, robots.txt, or llms.txt.
- **Dev-dependency advisories cleared** (undici, vite, esbuild). `npm audit` reported 0 vulnerabilities at release time.
- **Templates** gained a commented `[ai_catalog]` (ARD) example.

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

- Appears in `/_webmcp/health` and in the manifest's `config_hash`, so the operator can confirm which config is live.
- Keys the exec cache together with the cf-webmcp version, so neither a config change nor an upgrade answers from results of the previous deploy.

It is not an `ETag`. The manifest, the landing page and the ARD manifest carry the sha256 of their own body as `ETag`, which also moves when a cf-webmcp upgrade or a widget pin change alters the body while the TOML stays the same. llms.txt and robots.txt carry no `ETag` of their own; when they relay origin's answer as it came (an error, or a body they do not merge), origin's headers go with it, its `ETag` included.

The config hash does **not** name the served scripts. Both are content-addressed, so a URL changes exactly when the bytes behind it change:

- `bootstrap.<hash>.js`: `<hash>` is the first 16 hex chars of the sha256 of the generated bootstrap itself. A change to `[[tools]]` (a name, title, description, input schema or annotations, or the executor type when that changes the tool's default annotations) or to `[paths].namespace` moves it, and so does a cf-webmcp upgrade that generates a different bootstrap from the same TOML; other TOML edits do not. The `integrity` hash on the injected `<script>` always matches the file at that URL.
- `widget.<hash>.js`: `<hash>` is the first 16 hex chars of the sha256 of the object in R2 (license preamble plus the pinned widget), recorded in `vendor/webmcp/current.json`. Editing your TOML does not move it; changing the widget pin does.

## Updating the fallback widget

```bash
npm run update-widget -- --version=vX.Y.Z --sha256=<hex>
npm run upload-widget      # BEFORE deploy
npm run deploy
```

The sha256 is verified during download. If the upstream release has been replaced or modified, the pin fails. Always pull the upstream LICENSE file alongside the JS.

`update-widget` also records `served_sha256`, `served_sri` and `preamble_sha256` in `vendor/webmcp/current.json`. Commit that file with the pin change. `upload-widget` re-checks the vendored file against those values before it uploads anything, and the build reads only `current.json`.

Upload before deploy: the new Worker advertises the new widget URL on the landing page and answers 503 for it until the object exists. `/_webmcp/health` reports `widget_asset_present` so you can confirm. The object for the previous pin (and any old `widget.<8-hex>.js` object named after a config hash by v0.5.x and earlier) is no longer referenced and can be deleted from the bucket.

## Updating the Worker itself

`cf-webmcp` follows semver:

- Patch (`0.1.0` → `0.1.1`): bug fixes, internal changes. Safe to pull and redeploy without TOML changes. If the release changes the generated bootstrap, the redeploy moves the bootstrap URL and its SRI hash automatically; there is nothing to configure, but a CSP that allowlists the bootstrap by hash needs the new `BOOTSTRAP_SRI` (see [`docs/deployment.md`](deployment.md#subresource-integrity-sri-on-the-injected-bootstrap)). If it changes the widget pin or the license preamble, run `npm run update-widget` and `npm run upload-widget` before deploying.
- Minor (`0.1.0` → `0.2.0`): new features, new optional TOML fields. May add new executor types. Existing TOMLs continue to work.
- Major (`0.x` → `1.0`): breaking changes. `schema_version` bumps. Manual TOML migration documented in the release notes.

Subscribe to releases on GitHub to be notified.

## Migration from v0 to a hypothetical v2

When v2 lands, the build script reads `schema_version` and either:

- Migrates in place automatically if the change is backwards-compatible and we ship a migration. The TOML is rewritten on disk with the new version stamp.
- Or fails with a clear message telling the publisher exactly what to change. Migration instructions live in `docs/migrations/v1-to-v2.md`.

No version of `cf-webmcp` will silently accept a TOML with the wrong `schema_version`.
