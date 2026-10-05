# ARD manifest (`/.well-known/ard.json`)

cf-webmcp can publish an [Agentic Resource Discovery (ARD)](https://github.com/ards-project/ard-spec) manifest at `/.well-known/ard.json`, the well-known path of ARD v0.91. The manifest is a JSON document that lists the site's agentic resources so AI agents and ARD registries can find and load them without prior knowledge of the site.

**This feature is OFF by default.** ARD v0.91 (26 August 2026) has the status "Proposal", and the entry type cf-webmcp uses (`application/ai-skill+md`) is not IANA-registered. Enable it when you are ready to track spec changes.

The config block keeps its earlier name, `[ai_catalog]`, and the `[cache]` keys keep their `ai_catalog_` prefix.

## What ARD is, and what cf-webmcp implements

ARD defines a discovery envelope for "agentic resources": anything an AI agent can load or invoke (MCP servers, A2A agents, skills). The full specification covers:

- A **manifest** at `/.well-known/ard.json`: the document a site publishes to list its resources.
- A **registry REST API** (`/search`, `/explore`, `/agents`): a separate service that indexes manifests.
- A **trust manifest** per entry: identity binding, attestations and signatures.
- **DNS discovery**: service binding records that point at a manifest or a registry.

cf-webmcp implements the **publisher half only**: one manifest with one entry derived from the site's Agent Skill. No registry API, no trust manifest, no DNS records.

References: [ards-project/ard-spec](https://github.com/ards-project/ard-spec) (`spec/ard.md`, v0.91), [agenticresourcediscovery.org](https://agenticresourcediscovery.org/).

## Paths: `ard.json` and the predecessor `ai-catalog.json`

ARD v0.91 (section 5.1) names one path, `/.well-known/ard.json`, and one link relation, `ard`. The earlier draft used `/.well-known/ai-catalog.json` and `rel="ai-catalog"`. v0.91 calls those the predecessor: a consumer may still consult them, and a publisher on the predecessor path should move.

- **Canonical path:** `[ai_catalog].path`, default `/.well-known/ard.json`. Every advertisement points here.
- **Alias:** `[ai_catalog].aliases`, default `["/.well-known/ai-catalog.json"]`. A request for an alias gets a `301` to the canonical path, with `X-Robots-Tag: noindex` and the `ai_catalog_*` cache settings. Set `aliases = []` to leave the predecessor path to origin. An alias equal to the canonical path is ignored.
- **When the paths are claimed:** only with `[features].ai_catalog = true` and a mode other than `passthrough`, the alias as well as the canonical path. With the feature off (the default) or in `passthrough`, both paths go to origin unchanged.
- **Merge mode claims the alias too.** If your origin still serves its own `/.well-known/ai-catalog.json`, requests for it get the `301` to `ard.json` all the same. They do not lose origin's document: when origin has nothing at `ard.json`, the merge reads origin's `ai-catalog.json` and adds our entry to it (see [Merge mode](#merge-mode)). If you want origin's `ai-catalog.json` served as it is, remove it from `aliases`.

A path collision with another surface (for example an alias set to `/.well-known/api-catalog`) fails the build.

## What the manifest contains

One entry, derived from the site's Agent Skill. With `[site].name = "Example Co."` on `example.com`, two representative queries and one tag, the build produces:

```json
{
  "entries": [
    {
      "capabilities": [
        "search_pages",
        "list_posts",
        "get_page"
      ],
      "description": "What this site is and what it offers.",
      "displayName": "Example Co.",
      "identifier": "urn:air:example.com:skill:example-co",
      "representativeQueries": [
        "find a page about pricing",
        "list recent posts"
      ],
      "tags": [
        "docs"
      ],
      "type": "application/ai-skill+md",
      "url": "https://example.com/.well-known/agent-skills/site/SKILL.md"
    }
  ],
  "host": {
    "displayName": "Example Co.",
    "identifier": "did:web:example.com"
  }
}
```

Keys are sorted and the output is byte-stable for one config.

- **No `specVersion`.** v0.91 requires only `entries` and defines no version member. Other top-level members are ignored by ARD.
- **`host`** is such a member: ARD ignores it. cf-webmcp keeps it in the shape the predecessor format used. `displayName` comes from `[site].name`. `identifier` is `did:web:<host>`, where `<host>` is the host of `[site].public_url` when set, else `[site].domain`, port included. A port is percent-encoded, as the `did:web` method requires: `did:web:example.com%3A8787`. `[ai_catalog].host_identifier` overrides it.
- **`entries[0].identifier`** is `urn:air:<publisher>:skill:<skill name>` (v0.91 Appendix C). `<publisher>` is `[site].domain` without its port, lowercase, an internationalised name in its punycode form. It does not follow `[site].public_url`: the ARD URN naming guide keeps the real domain in local development too, so the identifier is the same in development and production. `<skill name>` is the skill name described below.
- **`type`** is `application/ai-skill+md`, the type of the skill entry example in v0.91 section 4.4.
- **`url`** is the absolute URL of the SKILL.md.
- **`displayName`** is `[agent_skills].name` when set, else `[site].name`.
- **`description`** is `[agent_skills].description`, else `[site].description`; omitted when both are empty.
- **`capabilities`** lists the `[[tools]]` and `[[forms]]` names.
- **`representativeQueries`** and **`tags`** come from `[ai_catalog]` and are omitted when empty. ARD recommends two to five queries; registries build their search index from them.

With `[features].agent_skills = false` the manifest has `"entries": []`, and the build prints a warning.

### The skill name

The SKILL.md frontmatter `name`, the entry in `/.well-known/agent-skills/index.json` and the last segment of the ARD identifier are one value:

- `[agent_skills].name` when it is set. It must be lowercase letters and digits, in groups joined by single hyphens (`example-site`, `my-2nd-shop`); anything else fails validation.
- Otherwise the slug of `[site].name`: Unicode NFKD, accents removed, lowercased, every run of other characters replaced by one hyphen, hyphens trimmed at both ends. `Café` becomes `cafe`. A letter that NFKD does not reduce to a-z (`ß`, `ø`) counts as one of those other characters: `Grüße Welt` becomes `gru-e-welt`. Set `[agent_skills].name` if you want something else.

If `[site].name` leaves nothing (a name written only in a non-Latin script, say) and `[agent_skills].name` is not set, the build fails and asks you to set `[agent_skills].name`. That check applies whenever the SKILL.md, the skills index or the ARD entry is served.

### Response headers

```
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=300, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=86400
Access-Control-Allow-Origin: *
X-Robots-Tag: noindex
X-Content-Type-Options: nosniff
```

v0.91 names no media type of its own for the manifest; it is a JSON document, served as `application/json`.

## Config

```toml
[features]
ai_catalog = true   # default false

[ai_catalog]
path    = "/.well-known/ard.json"              # default
aliases = ["/.well-known/ai-catalog.json"]     # default: 301 to path; [] to leave it to origin
mode    = "synthesize"                         # synthesize | merge | passthrough

# Optional: override the host DID (defaults to did:web:<host of public_url, else domain>)
host_identifier = ""

# Optional: 0-5 representative queries (ARD recommends 2-5). Omitted from output when empty.
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
| `path` | string | `/.well-known/ard.json` | Canonical path of the manifest. |
| `aliases` | string[] | `["/.well-known/ai-catalog.json"]` | Paths that `301` to `path`. `[]` disables the redirect. |
| `mode` | enum | `synthesize` | How to produce the document (see Modes). |
| `host_identifier` | string | `""` | Override `host.identifier`. Empty means `did:web:<host>`. |
| `representative_queries` | string[] | `[]` | 0-5 natural-language example queries. Included in the entry when non-empty. |
| `tags` | string[] | `[]` | Freeform entry tags. Included when non-empty. |

## Modes

| Mode | What happens |
|------|-------------|
| `synthesize` (default) | Serve the manifest built from TOML. Origin is not asked. |
| `merge` | Add our entry to origin's manifest (see below). |
| `passthrough` | Neither the path nor the aliases are claimed. Origin owns them. |

### Merge mode

1. The Worker fetches `[ai_catalog].path` from origin.
2. If that is a **404**, it fetches the predecessor path `/.well-known/ai-catalog.json` from origin instead, so a site whose document still lives there keeps it merged. (Skipped when `[ai_catalog].path` is the predecessor path itself.)
3. The answer from step 1, or from step 2 after a 404, decides:
   - **A 200 declared as JSON** (`application/json`, `application/ai-catalog+json` or no `Content-Type`) **that is a valid ARD document** (an object with an `entries` array whose members are objects with a string `identifier`): our entry is appended and the result is served with the headers above. If origin already has an entry with our `identifier`, origin's entry is kept and ours is not added, so nothing is duplicated. Origin's other top-level members (its own `host`, a `specVersion`) stay as they are.
   - **A 200 declared as JSON that is not a valid ARD document** (unparseable, no `entries` array, an entry without a string `identifier`): relayed unchanged, with `X-Robots-Tag: noindex` added. Our entry is not added; the document is origin's, not ours to replace.
   - **Any other 200** (HTML, plain text, `text/json`): relayed unchanged, with `X-Robots-Tag: noindex` added.
   - **A 404 at both paths, or any other answer** (a redirect relayed by the Worker because it leaves `allowed_origins`, a 4xx, a 5xx, the Worker's own 502 or 504): the generated document, as in `synthesize` mode. It carries the same `Cache-Control` as a merged answer, so a shared cache may keep it, without origin's entries, for up to `ai_catalog_s_maxage` after an origin failure.

Merged output is canonicalised: 2-space indent, object keys sorted, trailing newline. Merging our own output again gives the same bytes.

## Advertisements

When the feature is on and `mode` is not `passthrough`, cf-webmcp advertises the canonical URL on four surfaces. None of them names the predecessor path or `rel="ai-catalog"`.

1. **`robots.txt` Agentmap directive** (v0.91 section 5.1):

   ```
   Agentmap: https://example.com/.well-known/ard.json
   ```

2. **`<link rel="ard">` tag**, injected into HTML when `[features].link_tag = true`:

   ```html
   <link rel="ard" href="https://example.com/.well-known/ard.json">
   ```

3. **HTTP `Link` header** on every proxied response:

   ```
   Link: <https://example.com/.well-known/ard.json>; rel="ard"; title="AI agent catalog (ARD)"
   ```

4. **`llms.txt` line** in the cf-webmcp block merged into `/llms.txt`.

v0.91 requires a consumer to fetch `/.well-known/ard.json` and to honour `rel="ard"`.

## Preflight

`npm run preflight` probes the canonical path and every alias. In `synthesize` mode a 200 at any of them is a collision, because the Worker answers there instead. In `merge` mode it also probes `/.well-known/ai-catalog.json`: a 200 JSON document at the canonical or the predecessor path is reported as a merge, JSON that is not an ARD document as a warning (the Worker relays it unchanged), and text or HTML as a collision. Any other alias is a claim.

## Verify

```bash
curl -s https://example.com/.well-known/ard.json | jq
curl -sI https://example.com/.well-known/ard.json
# Content-Type: application/json; charset=utf-8
# X-Robots-Tag: noindex
curl -sI https://example.com/.well-known/ai-catalog.json
# HTTP/2 301, Location: /.well-known/ard.json
```

## What the spec fixes, and what it leaves open

cf-webmcp follows `spec/ard.md` v0.91:

- The path `/.well-known/ard.json` and the relation `rel="ard"` (section 5.1).
- Identifiers in the `urn:air:<publisher>:<namespace>:<name>` form (Appendix C).
- The `Agentmap:` robots.txt directive (section 5.1). It is not in any RFC.
- `application/ai-skill+md` for a skill (section 4.4 example). ARD's `type` is an open media type field; the ARD conformance tool and the AI Catalog specification list other skill types (`text/markdown; profile="urn:air:agent-skills"`, `application/agent-skills+md`). None is IANA-registered.

These may change in a later ARD version, which is why the feature is off by default.

## What this is not

- **Not the ARD registry REST API.** `/search`, `/explore` and `/agents` belong to a registry service. cf-webmcp publishes a manifest; it does not run a registry.
- **Not a trust manifest.** The entry carries no `trustManifest`, no attestations and no signature.
- **Not DNS discovery.** cf-webmcp does not create or manage DNS records.
- **Not multiple entries.** cf-webmcp derives exactly one entry from the Agent Skill. To list other resources, use `merge` mode and publish them in your origin's manifest.
