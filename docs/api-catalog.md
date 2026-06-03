# API Catalog (RFC 9727)

`cf-webmcp` publishes an [RFC 9727](https://www.rfc-editor.org/rfc/rfc9727.html) API Catalog at `/.well-known/api-catalog` advertising the WebMCP manifest. Agents that look at the standard well-known catalog path (instead of, or in addition to, the WebMCP-specific manifest) find a pointer to it.

## What's in there

One Linkset (per [RFC 9264](https://www.rfc-editor.org/rfc/rfc9264.html)) entry, anchored at the site root, with a `webmcp` rel pointing at the WebMCP manifest:

```json
{
  "linkset": [
    {
      "anchor": "https://example.com/",
      "webmcp": [
        {
          "href": "https://example.com/.well-known/webmcp",
          "type": "application/json"
        }
      ]
    }
  ]
}
```

The `rel` value matches the one we already emit in the HTTP `Link` header and in `<link rel="webmcp">`. One identifier across all three discovery surfaces - one thing to grep for in client code.

Response headers:

```
Content-Type: application/linkset+json
Cache-Control: public, max-age=300, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=86400
X-Content-Type-Options: nosniff
```

## Config

```toml
[features]
api_catalog = true       # default true; flip to false to disable

[api_catalog]
path = "/.well-known/api-catalog"   # default
mode = "merge"                       # merge | replace | passthrough | synthesize

[cache]
api_catalog_max_age  = 300
api_catalog_s_maxage = 21600
api_catalog_swr      = 86400
api_catalog_sie      = 86400
```

## Modes

| Mode | What happens | When to use |
|------|--------------|-------------|
| `merge` (default) | Fetch origin's `/.well-known/api-catalog`. If it returns valid Linkset JSON, splice our entry in (idempotent: re-running produces byte-identical output). On 404, unparseable JSON, or non-linkset JSON, fall back to synthesize. | You may already publish other APIs (OpenAPI, AsyncAPI, etc.) in the same catalog. cf-webmcp adds itself without overwriting them. |
| `synthesize` | Ignore origin. Emit a fresh catalog with only our entry. | You don't publish other APIs in a catalog. Simplest setup. |
| `replace` | Same as `synthesize`. (cf-webmcp emits exactly one entry, so the difference between replace and synthesize would only matter for multi-entry generators; kept for parity with other discovery routes.) | Use `synthesize` for clarity. |
| `passthrough` | The route is not registered. Origin owns the file 100%. | You want to manage the catalog entirely outside cf-webmcp. |

### Merge mode details

When `mode = "merge"`:

1. The Worker fetches origin's `/.well-known/api-catalog` (or whatever `[api_catalog].path` is configured).
2. If origin returns **200 + JSON or `application/linkset+json`** and the body parses as a valid Linkset (object with a `linkset` array, each entry having an `anchor` string), the Worker merges:
   - Finds the entry whose `anchor` matches our site root.
   - If found, appends our `webmcp` rel to it (skipping if our exact `{href, type}` is already present - idempotent).
   - If not found, appends our entry as a new linkset element.
3. If origin returns **404**, the Worker emits a fresh single-entry catalog (same as synthesize).
4. If origin returns **200 with a non-JSON content-type** (e.g. `text/html`, suggesting a SPA 404 page), the Worker passes the response through unchanged rather than risk overwriting publisher content.
5. If origin returns **valid JSON that is not a linkset** (no `linkset` array, or malformed entries), the Worker falls back to synthesize.

Output is canonicalised: 2-space indent, object keys sorted alphabetically, trailing newline. Byte-stable across re-runs.

## Advertised on every response

When the catalog is enabled, cf-webmcp advertises it through two additional surfaces alongside the existing `rel="webmcp"`:

- **HTTP `Link` header** on every Worker response (RFC 8288, comma-separated):

  ```
  Link: <https://example.com/.well-known/webmcp>; rel="webmcp",
        <https://example.com/.well-known/api-catalog>; rel="api-catalog"
  ```

- **`<link>` tag** injected into HTML responses (when `[features].link_tag = true`):

  ```html
  <link rel="webmcp" href="https://example.com/.well-known/webmcp">
  <link rel="api-catalog" href="https://example.com/.well-known/api-catalog">
  ```

`rel="api-catalog"` is registered in IANA's Link Relations by RFC 9727. Generic crawlers and discovery tools scanning for registered rels find the catalog without prior knowledge of cf-webmcp.

Both surfaces honour the same gate: emitted only when `[features].api_catalog = true` and `[api_catalog].mode != "passthrough"`.

## Verify

```bash
curl -s https://example.com/.well-known/api-catalog | jq
```

Should return the JSON shape above. Run twice; output should be identical.

## What this is not

- **Not OpenAPI generation.** cf-webmcp does not synthesize an OpenAPI document for your WebMCP tools. The catalog points at our WebMCP manifest as the service description.
- **Not API discovery.** cf-webmcp does not crawl or infer your other APIs. If you want to list them in the same catalog, edit your origin's `/.well-known/api-catalog`; merge mode preserves what's there.
- **Not authentication-related.** RFC 9727 is a discovery primitive only. It does not affect access control. OAuth-related well-known files (RFC 8414, RFC 9728) are a separate concern that cf-webmcp does not handle - public-read WebMCP tools by design.

## Why publish this at all

Discovery is layered:

- WebMCP-aware agents already find the manifest via the `Link` header or the in-page `<link rel="webmcp">`.
- Generic "agent ready" audits and broader tooling check well-known paths. `/.well-known/api-catalog` is the standardised one for "this site exposes one or more APIs".
- Crawlers indexing API surfaces (developer search engines, AI agent registries) look at the well-known catalog.

Publishing it costs cf-webmcp one extra route handler and one small fetch on cache miss. The data is already computed.
