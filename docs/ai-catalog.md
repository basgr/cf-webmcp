# ARD Publisher Catalog (`/.well-known/ai-catalog.json`)

cf-webmcp can publish an [Agentic Resource Discovery (ARD)](https://github.com/ards-project/ard-spec) catalog at `/.well-known/ai-catalog.json`. The catalog is a structured JSON document that lists the site's agentic resources so AI agents can discover and load them without prior knowledge of the site.

**This feature is OFF by default.** ARD is a v0.9 draft (spec/ard.md: `urn:air`, `application/ai-catalog+json`). The media types are not yet IANA-registered. Enable only when you are ready to track spec changes.

## What ARD is - and what cf-webmcp implements

ARD defines a discovery envelope for "agentic resources": anything an AI agent can meaningfully load or invoke. The full specification covers:

- A **publisher catalog** (`/.well-known/ai-catalog.json`) - the document a site publishes to declare its resources.
- A **registry REST API** (`/search`, `/explore`, `/agents`) - a centralised index that aggregates publisher catalogs.
- **JWS signing / attestations** - cryptographic claims attached to catalog entries.
- **DNS-based discovery** - TXT records pointing agents to the catalog URL.

cf-webmcp implements the **publisher half only**: one catalog document with one entry derived from the site's Agent Skill. No registry REST API, no signing, no DNS discovery.

References: [ards-project/ard-spec](https://github.com/ards-project/ard-spec), [agenticresourcediscovery.org](https://agenticresourcediscovery.org/).

## What the catalog contains

One ARD catalog entry, auto-derived from the site's configured Agent Skill:

```json
{
  "specVersion": "1.0",
  "host": {
    "displayName": "My Site",
    "identifier": "did:web:example.com"
  },
  "entries": [
    {
      "identifier": "urn:air:example.com:skill:site",
      "displayName": "My Site",
      "type": "application/ai-skill+md",
      "url": "https://example.com/.well-known/agent-skills/site/SKILL.md",
      "capabilities": ["browse", "search"],
      "representativeQueries": [
        "What can I do on this site?",
        "How do I search for products?"
      ],
      "tags": ["ecommerce", "search"]
    }
  ]
}
```

Fields:

- `specVersion` - always `"1.0"` (ARD v0.9 draft).
- `host.displayName` - from `[site].name`.
- `host.identifier` - `did:web:<domain>` derived from `[site].domain`, or overridden via `[ai_catalog].host_identifier`.
- `entries[0].identifier` - `urn:air:<domain>:skill:<slug>` where `<slug>` is the last segment of the Agent Skill path.
- `entries[0].type` - `application/ai-skill+md` (ARD type for Anthropic-format Agent Skills).
- `entries[0].url` - absolute URL to `/.well-known/agent-skills/<slug>/SKILL.md`.
- `entries[0].representativeQueries` - populated from `[ai_catalog].representative_queries` (0-5 items, omitted when empty).
- `entries[0].tags` - populated from `[ai_catalog].tags` (omitted when empty).

Response headers:

```
Content-Type: application/ai-catalog+json
Cache-Control: public, max-age=300, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=86400
Access-Control-Allow-Origin: *
X-Robots-Tag: noindex
X-Content-Type-Options: nosniff
```

## Config

```toml
[features]
ai_catalog = true   # default false

[ai_catalog]
path = "/.well-known/ai-catalog.json"   # default
mode = "synthesize"                      # synthesize | merge | passthrough

# Optional: override the host DID (defaults to did:web:<site.domain>)
host_identifier = ""

# Optional: 0-5 representative queries (ARD SHOULD). Omitted from output when empty.
representative_queries = [
  "What can I do on this site?",
  "How do I search for products?",
]

# Optional: entry tags. Omitted from output when empty.
tags = ["ecommerce", "search"]

[cache]
ai_catalog_max_age  = 300
ai_catalog_s_maxage = 21600
ai_catalog_swr      = 86400
ai_catalog_sie      = 86400
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `path` | string | `/.well-known/ai-catalog.json` | Canonical path for the catalog. |
| `mode` | enum | `synthesize` | How to produce the document (see Modes). |
| `host_identifier` | string | `""` | Override the `host.identifier` DID. Empty = use `did:web:<site.domain>`. |
| `representative_queries` | string[] | `[]` | 0-5 natural-language example queries. Included in the entry when non-empty. |
| `tags` | string[] | `[]` | Freeform entry tags. Included when non-empty. |

## Modes

| Mode | What happens |
|------|-------------|
| `synthesize` (default) | Generate the catalog entirely from TOML config. Origin is not consulted. |
| `merge` | Fetch origin's `/.well-known/ai-catalog.json`. If it returns valid ARD JSON (object with an `entries` array where every member has a string `identifier`), splice our entry in (idempotent: re-running produces byte-identical output). Fall back to synthesize on 404, unparseable JSON, or invalid entry members. Relay non-JSON responses unchanged with `X-Robots-Tag: noindex` added. |
| `passthrough` | Route not registered. Origin owns the path entirely. |

### Merge mode details

When `mode = "merge"`:

1. The Worker fetches `[ai_catalog].path` from origin.
2. If origin returns **404**, fall back to synthesize.
3. If origin returns **200 + JSON content-type** and the body is a valid ARD catalog (non-null object, `entries` array, every entry a non-null object with a string `identifier`):
   - Find our entry by `identifier` in the existing list.
   - If found, replace it in place (keeps our data current).
   - If not found, append it.
4. If origin returns **200 + non-JSON content-type**, relay the response unchanged with `X-Robots-Tag: noindex` added.
5. If the JSON is unparseable or does not look like a valid ARD catalog, fall back to synthesize.

Output is canonicalised: 2-space indent, object keys sorted alphabetically, trailing newline. Byte-stable across re-runs.

## Advertisements

When the feature is enabled and `mode != "passthrough"`, cf-webmcp advertises the catalog on four surfaces:

1. **`robots.txt` - Agentmap directive**

   ```
   Agentmap: https://example.com/.well-known/ai-catalog.json
   ```

   Part of the ARD draft's robots.txt discovery convention. Agents that parse `robots.txt` looking for `Agentmap:` lines find the catalog without fetching the well-known path.

2. **`<link rel="ai-catalog">` tag** (injected into HTML when `[features].link_tag = true`):

   ```html
   <link rel="ai-catalog" href="https://example.com/.well-known/ai-catalog.json">
   ```

3. **HTTP `Link` header** on every Worker response:

   ```
   Link: <https://example.com/.well-known/ai-catalog.json>; rel="ai-catalog"; title="AI agent catalog (ARD)"
   ```

4. **`llms.txt` line** - the ai-catalog URL is included in the cf-webmcp block merged into `/llms.txt`.

All four surfaces honour the same gate: emitted only when `[features].ai_catalog = true` and `[ai_catalog].mode != "passthrough"`.

## Verify

```bash
curl -s https://example.com/.well-known/ai-catalog.json | jq
```

Should return the JSON shape above. Run twice; output should be identical (idempotency).

```bash
curl -I https://example.com/.well-known/ai-catalog.json
# Look for: Content-Type: application/ai-catalog+json
#           X-Robots-Tag: noindex
```

## Spec instability caveats

ARD is a v0.9 draft. cf-webmcp pins to the identifiers in `spec/ard.md` at implementation time:

- Resource identifiers use the `urn:air:` scheme.
- The media type `application/ai-catalog+json` is not yet IANA-registered.
- The entry type `application/ai-skill+md` is not yet IANA-registered.
- The `Agentmap:` robots.txt directive is ARD-draft-specific and not in any RFC.

These identifiers may change before ARD reaches a stable version. That is why the feature defaults to `false`: publisher sites should evaluate the spec stability before opting in.

## What this is not

- **Not the ARD registry REST API.** The `/search`, `/explore`, and `/agents` endpoints are a separate centralised service. cf-webmcp publishes a catalog for agents to read; it does not run a registry.
- **Not JWS signing.** The entries in the catalog carry no cryptographic attestations. Signing is an ARD feature cf-webmcp does not implement.
- **Not DNS discovery.** ARD allows publishing catalog URLs via DNS TXT records. cf-webmcp does not generate or manage DNS records.
- **Not multiple entries.** cf-webmcp derives exactly one entry from the Agent Skill. If you want to list other agentic resources, use `merge` mode and publish additional entries from your origin.
