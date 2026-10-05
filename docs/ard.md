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
- **Alias:** `[ai_catalog].aliases`, default `["/.well-known/ai-catalog.json"]`. A request for an alias gets a `301` to the canonical path, with `Access-Control-Allow-Origin: *` (a browser follows a cross-origin redirect only when the redirect passes CORS), `X-Robots-Tag: noindex` and the `ai_catalog_*` cache settings. Set `aliases = []` to leave the predecessor path to origin. An alias equal to the canonical path is ignored.
- **When the paths are claimed:** only with `[features].ai_catalog = true` and a mode other than `passthrough`, the alias as well as the canonical path. With the feature off (the default) or in `passthrough`, both paths go to origin unchanged.
- **Merge mode claims the alias too.** If your origin still serves its own `/.well-known/ai-catalog.json`, requests for it get the `301` to `ard.json` all the same. They do not lose origin's document: when origin has nothing at `ard.json`, the merge reads origin's `ai-catalog.json` and adds our entry to it (see [Merge mode](#merge-mode)). If you want origin's `ai-catalog.json` served as it is, remove it from `aliases`.

A path collision with another surface (for example an alias set to `/.well-known/api-catalog`) fails the build.

The build warns when a served manifest will not be found at `/.well-known/ard.json`: when `[ai_catalog].path` is set to the predecessor path `/.well-known/ai-catalog.json`, or to any other path while `/.well-known/ard.json` is not one of the aliases. v0.91 consumers MUST fetch `/.well-known/ard.json`, so move `path` back to the default (or add `/.well-known/ard.json` to `aliases`).

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
- **`type`** is `[ai_catalog].skill_type`, by default `application/ai-skill+md`, the type of the skill entry example in v0.91 section 4.4 (see [the spec notes](#what-the-spec-fixes-and-what-it-leaves-open)).
- **`url`** is the absolute URL of the SKILL.md.
- **`displayName`** is `[site].name`, the human-readable name, not the slug.

A single trailing dot on the host is dropped from both identifiers. With the feature on, a `[site].public_url` that is not an absolute `http` or `https` URL (`localhost:8787`, `example.com`), or a port outside 1 to 65535, fails the build with an error that names the field and the value. ARD v0.91 wants the publisher to be a fully qualified domain name: when `[site].domain` is `localhost`, an IP address, a single label or has an empty label, the build prints a warning and builds the manifest anyway. A name under `.localhost` (`agent.localhost`) is the URN naming guide's own placeholder for local work and gets no warning.
- **`description`** is `[agent_skills].description`, else `[site].description`; omitted when both are empty.
- **`capabilities`** lists the `[[tools]]` and `[[forms]]` names.
- **`representativeQueries`** and **`tags`** come from `[ai_catalog]` and are omitted when empty. ARD recommends two to five queries; registries build their search index from them.

With `[features].agent_skills = false` the manifest has `"entries": []`, and the build prints a warning.

### The skill name

The frontmatter `name` of the SKILL.md cf-webmcp writes, the entry in `/.well-known/agent-skills/index.json` and the last segment of the ARD identifier are one value. (With `[agent_skills].mode = "merge"` and a SKILL.md at origin, the served file keeps origin's own frontmatter, and its `name` is whatever origin wrote.) The value is:

- `[agent_skills].name` when it is set. It must be lowercase letters and digits, in groups joined by single hyphens (`example-site`, `my-2nd-shop`), and at most 64 characters; anything else fails validation, even with the skill surfaces off.
- Otherwise the slug of `[site].name`: Unicode NFKD, accents removed, lowercased, then the letters NFKD leaves alone written in ASCII (`ß` as `ss`, `æ` as `ae`, `œ` as `oe`, `ø` as `o`, `đ` and `ð` as `d`, `ł` as `l`, `þ` as `th`, `ı` as `i`, `ħ` as `h`, `ŧ` as `t`, `ŋ` as `n`, `ĸ` as `k`), every run of any other character replaced by one hyphen, hyphens trimmed at both ends. `Café` becomes `cafe`, `Grüße Welt` becomes `grusse-welt`, `ØRSTED` becomes `orsted`. A slug over 64 characters is cut to 64, and a hyphen left at the end is trimmed. Set `[agent_skills].name` if you want something else.

If `[site].name` leaves nothing (a name written only in a non-Latin script, say) and `[agent_skills].name` is not set, the build fails and asks you to set `[agent_skills].name`. That check applies whenever the SKILL.md, the skills index or the ARD entry is served.

### Response headers

```
Content-Type: application/json; charset=utf-8
Cache-Control: public, max-age=300, s-maxage=21600, stale-while-revalidate=86400, stale-if-error=86400
Access-Control-Allow-Origin: *
X-Robots-Tag: noindex
X-Content-Type-Options: nosniff
```

v0.91 names no media type of its own for the manifest; it is a JSON document, served as `application/json`. In `merge` mode, when the generated document stands in for an origin that failed (see below), `Cache-Control` is `public, max-age=60, s-maxage=60` instead.

## Config

```toml
[features]
ai_catalog = true   # default false

[ai_catalog]
path    = "/.well-known/ard.json"              # default
aliases = ["/.well-known/ai-catalog.json"]     # default: 301 to path; [] to leave it to origin
mode    = "synthesize"                         # synthesize | merge | passthrough

# Optional: the skill entry's type (see "What the spec fixes" below)
skill_type = "application/ai-skill+md"   # or 'text/markdown; profile="urn:air:agent-skills"' or "application/agent-skills+md"

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
| `skill_type` | enum | `application/ai-skill+md` | The skill entry's `type`: `application/ai-skill+md`, `text/markdown; profile="urn:air:agent-skills"` or `application/agent-skills+md`. |
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
   - **A 200 declared as JSON** (`application/json`, any `application/<x>+json` such as `application/ai-catalog+json` or `application/ld+json`, or no `Content-Type`), **of at most 1 MiB, that passes the structural check** (an object with an `entries` array of objects with a string `identifier`): our entry is appended and the result is served with the headers above. If origin already has an entry with our `identifier` or our `url`, origin's entry is kept and ours is not added, so nothing is duplicated. Origin's other top-level members (its own `host`, a `specVersion`) stay as they are.
   - **A 200 declared as JSON that fails the structural check** (unparseable, no `entries` array, an entry without a string `identifier`): relayed unchanged, with `X-Robots-Tag: noindex` added. Our entry is not added; the document is origin's, not ours to replace. The check is deliberately structural and not a full validation of each entry against the ARD entry schema: with a full validation, one origin entry that misses a term would fail the document and take our entry with it.
   - **A 200 over 1 MiB**, by its `Content-Length` or by what is read: not merged, relayed unchanged as a stream, with `X-Robots-Tag: noindex` added.
   - **Any other 200** (HTML, plain text, `text/json`, `application/json-seq`): relayed unchanged, with `X-Robots-Tag: noindex` added.
   - **A 404 at both paths**: origin has no manifest. The generated document, as in `synthesize` mode, with the normal `Cache-Control`.
   - **Any other answer** (a redirect relayed by the Worker because it leaves `allowed_origins`, a 4xx such as 410, a 5xx, the Worker's own 502 or 504), and **a body that fails while it is read**: origin failed. The generated document stands in, with `Cache-Control: public, max-age=60, s-maxage=60`, so origin's own document is back within a minute once origin is.

A relayed document is origin's response as it came: the same bytes (a byte order mark included) and the same headers, with `X-Robots-Tag: noindex` added and nothing else; no `Content-Type` is added where origin sent none. Merged output is canonicalised: 2-space indent, object keys sorted, trailing newline. Merging our own output again gives the same bytes.

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

`npm run preflight` probes the canonical path and every alias. In `synthesize` mode a 200 at any of them is a collision, because the Worker answers there instead. In `merge` mode it also probes `/.well-known/ai-catalog.json`, and judges both paths the way the merge does:

- A 200 JSON document of at most 1 MiB is reported as a merge. JSON that fails the structural check is a warning (the Worker relays it unchanged). Text or HTML is a collision.
- A 200 JSON document over 1 MiB is reported as "too large to merge, relayed unchanged", a warning: the Worker relays it as it came and adds no entry, whatever it holds, so this is judged before the content.
- A 404 or a redirect is fine.
- Any other answer (a 4xx, a 5xx) is a warning, not a collision: the Worker serves its generated document there.
- The merge reads the predecessor path only after a 404 at the canonical path. When origin answers anything but a 404 or a redirect at the canonical path (a valid `ard.json`, say), the predecessor's row says "redirected to /.well-known/ard.json, not merged", with a warning if origin has a document there that the redirect hides.

Any other alias is a claim.

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
- `application/ai-skill+md` for a skill (section 4.4 example), the default of `[ai_catalog].skill_type`. ARD's `type` is an open media type field, and the sources disagree on skills. The ARD conformance tool (`conformance/bin/conformance-test manifest`) does not list `application/ai-skill+md` as a standard type and reports it with a warning (newer versions of the tool report it as an informational extension type); the manifest still passes. The tool lists `text/markdown; profile="urn:air:agent-skills"` instead, and the AI Catalog specification lists `application/agent-skills+md`. Both can be chosen with `skill_type`. None of the three is IANA-registered.

These may change in a later ARD version, which is why the feature is off by default.

## What this is not

- **Not the ARD registry REST API.** `/search`, `/explore` and `/agents` belong to a registry service. cf-webmcp publishes a manifest; it does not run a registry.
- **Not a trust manifest.** The entry carries no `trustManifest`, no attestations and no signature.
- **Not DNS discovery.** cf-webmcp does not create or manage DNS records.
- **Not multiple entries.** cf-webmcp derives exactly one entry from the Agent Skill. To list other resources, use `merge` mode and publish them in your origin's manifest.
