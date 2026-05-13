# Upgrades and versioning

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
