# Agent Skills (SKILL.md)

cf-webmcp publishes a site-specific Anthropic-format **Agent Skill** at `/.well-known/agent-skills/site/SKILL.md`. The file is a YAML-frontmatter markdown document describing your site's WebMCP surface in a shape that agent runtimes and skill registries recognise.

This sits alongside two related discovery surfaces:

| Surface | Audience | Format |
|---|---|---|
| `webmcp.json` (manifest) | machines that already speak WebMCP | structured JSON |
| `agents.md` | acting agents reading free-form policy | prose markdown |
| **`SKILL.md`** | agent runtimes scanning skill registries (Anthropic Skills, Cloudflare Browser Run, isitagentready) | YAML frontmatter + structured markdown |

The three are complementary, not redundant. The manifest tells an agent *what tools exist*. `agents.md` is *how to behave* (prose, free-form). `SKILL.md` is the *operational handbook for picking the right tool* - hand-written hints alongside an auto-generated tool list.

## What gets emitted

In `synthesize` mode (default), cf-webmcp generates:

```markdown
---
name: "example-site"
description: "An example site exposing WebMCP tools."
---

# Example Site

## Tools available on this site

Browser-native agents register these automatically via `navigator.modelContext` when the WebMCP runtime is present. Desktop MCP clients can pair at <https://example.com/mcp> and call the tools through the localhost bridge.

- `search_pages(query: string)` - Search the site by keyword.
- `list_posts()` - List recent posts.
- `get_page(path: string)` - Fetch readable content of a page.

## When to use which tool

- "find anything about X" -> search_pages
- "what's new" -> list_posts

## Common pitfalls

Search is path-based, not full-text.

## Full machine-readable tool schema

<https://example.com/.well-known/webmcp.json>
```

The frontmatter `name` and `description` derive from `[site].name` and `[site].description`. The tool list is auto-generated from `[[tools]]` and `[[forms]]`. The "When to use which" and "Common pitfalls" sections come from `[[agent_skills.hints]]` blocks you write in TOML.

## Config

```toml
[features]
agent_skills = true       # default true; flip to false to disable

[agent_skills]
path        = "/.well-known/agent-skills/site/SKILL.md"   # canonical path
mode        = "synthesize"                                  # merge | replace | passthrough | synthesize
name        = ""    # optional override; defaults to slugified [site].name
description = ""    # optional override; defaults to [site].description
aliases     = [
  "/.well-known/agent-skills/site/SKILLS.md",
  "/.well-known/agent-skills/site/skill.md",
  "/.well-known/agent-skills/site/skills.md",
]

  # Hand-written prose sections rendered after the auto-generated tool list.
  # Order is preserved. Markdown allowed in body.
  [[agent_skills.hints]]
  heading = "When to use which tool"
  body    = """
  - "find anything about X" -> search_pages
  - "what's new" -> list_posts
  """

  [[agent_skills.hints]]
  heading = "Common pitfalls"
  body    = """
  Search is path-based, not full-text. Use search_pages to find URLs,
  then get_page to fetch the actual content.
  """

[cache]
agent_skills_max_age          = 300
agent_skills_s_maxage         = 21600
agent_skills_swr              = 86400
agent_skills_sie              = 86400
agent_skills_redirect_max_age = 86400
agent_skills_redirect_s_maxage = 604800
```

## Modes

| Mode | What happens |
|------|--------------|
| `synthesize` (default) | Ignore origin. Emit a fresh SKILL.md from TOML alone. |
| `merge` | Fetch origin's SKILL.md. Splice our auto-generated block into `<!-- cf-webmcp:begin -->` ... `<!-- cf-webmcp:end -->`. Idempotent on re-run. The publisher's frontmatter and surrounding prose are preserved. |
| `replace` | Same as synthesize. (cf-webmcp emits exactly one skill, so the difference between replace and synthesize would only matter for multi-skill generators; kept for parity with other discovery routes.) |
| `passthrough` | Route not registered. Origin owns the file entirely. |

## Aliases (case-variant 301 redirects)

The canonical filename is `SKILL.md`. Three common case variants 301-redirect to it by default:

- `SKILLS.md` (plural typo)
- `skill.md` (lowercase)
- `skills.md` (lowercase plural)

Configurable via `[agent_skills].aliases`. Set to `[]` to disable.

## Advertised on every response

When the skill is enabled (`features.agent_skills = true` and mode not `passthrough`), cf-webmcp advertises it through:

- **HTTP `Link` header**: an additional `<...>; rel="agent-skills"` entry alongside the existing `rel="webmcp"` and `rel="api-catalog"` entries, comma-separated per RFC 8288.
- **`<link>` tag** injected into HTML responses (when `[features].link_tag = true`):

  ```html
  <link rel="agent-skills" href="https://example.com/.well-known/agent-skills/site/SKILL.md">
  ```

`rel="agent-skills"` is not yet IANA-registered; it follows the convention used in Anthropic's Agent Skills format. Same pattern as the existing private `rel="webmcp"`.

## Verify

```bash
curl https://example.com/.well-known/agent-skills/site/SKILL.md
curl -I https://example.com/.well-known/agent-skills/site/SKILLS.md   # should 301
```

## What this is not

- **Not a marketing page.** Skills exist for agent runtimes. Keep prose terse and task-shaped, not "Welcome to our site!".
- **Not a substitute for the manifest.** Agents that already speak WebMCP find `webmcp.json` first. SKILL.md is the secondary surface for runtimes that scan skill registries.
- **Not a skill-registry submission.** Publishing at the well-known path doesn't register your site with Anthropic Skills or any other directory. It just makes the file discoverable to crawlers that look there.
- **Not a place to put credentials, prompts, or jailbreak attempts.** This file is public.

## Why a new surface?

[`docs/scope.md`](scope.md) initially excluded Agent Skills on the grounds that the manifest covered the same ground. After seeing real-world usage - Cloudflare Browser Run docs ship a WebMCP skill, [isitagentready.com](https://isitagentready.com) checks for skills at the well-known path - the exclusion was reversed in v0.3.0. The operational-hints gap that prose `agents.md` doesn't fill is now covered by `SKILL.md`'s task-shaped guidance. The boundary on Anthropic-specific conventions remains tight: cf-webmcp emits a markdown file at a well-known path, nothing more.
