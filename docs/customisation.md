# Customising the landing page

The Worker auto-generates a small HTML page at `/mcp` (or whatever path you set in `[webmcp_landing].path`). It is the page humans and desktop MCP clients land on to pair, and the page browser-native agents see when they follow a `<link rel="webmcp">` reference.

You can replace it with your own HTML template per deploy, with no code changes to the Worker.

## Default

If you do nothing, `cf-webmcp` uses [`templates/landing.default.html`](../templates/landing.default.html). It is a single-file standalone page with inline CSS, runtime state branching, and three sections (native / pair / disabled). It is intentionally minimal: works in any browser, no external assets.

## Override

Set a template path in your TOML:

```toml
[webmcp_landing]
path     = "/mcp"
template = "path/to/my-landing.html"
```

The path is resolved relative to your `webmcp.toml` file, not the project root. `cf-webmcp` reads the file at build time, substitutes a handful of placeholders, and emits the result as the landing page.

## Available placeholders

The build script does a literal `{{name}}` substitution. No conditionals, no loops, no expressions. Everything you might need is pre-computed and handed in as a string.

| Placeholder | Value | Notes |
|-------------|-------|-------|
| `{{lang}}` | `site.locale` | HTML-escaped. Goes in `<html lang="...">`. |
| `{{site_name}}` | `site.name` | HTML-escaped. |
| `{{site_description}}` | `site.description` | HTML-escaped. |
| `{{config_hash}}` | Build-time hash of the TOML | 8 hex chars. Same value as in `<ETag>` and `/_webmcp/health`. |
| `{{tool_list}}` | Pre-rendered `<li>` items | One per tool. Each is `<li><code>name</code> - description</li>`. **Not** HTML-escaped (it is already safe HTML). |
| `{{widget_block}}` | The widget mount + script tag | Empty string if `[features].fallback_widget = false`. **Not** HTML-escaped. |
| `{{widget_enabled_js}}` | Literal `"true"` or `"false"` | For inlining into a JS expression. |
| `{{bootstrap_block}}` | The bootstrap `<script>` tag | `<script src="/_webmcp/bootstrap.<hash>.js" defer integrity="sha384-..." crossorigin="anonymous"></script>`. The `src` is root-relative and follows `[paths].namespace`; `integrity` and `crossorigin` are present only while `[features].subresource_integrity` is on. **Not** HTML-escaped (it is already safe HTML). |

Unknown placeholders cause a build error so typos surface early.

### The bootstrap on the landing page

The Worker injects the bootstrap into pages it proxies from your origin. It does not inject it into the landing page, which the Worker serves itself. `{{bootstrap_block}}` is how the landing page loads it: the page then registers this site's tools on `document.modelContext`, so the "Connected" state is true of the page the visitor is looking at, and its diagnostic can list the names `getTools()` returns.

The default template includes it. A custom template without the placeholder builds as before and loads no bootstrap: the page can still tell a visitor whether their browser exposes WebMCP, but registers no tools itself. Put `{{bootstrap_block}}` once anywhere in the `<body>`; the script is `defer`red, so it runs after the page has been parsed whatever its position. The build refuses a template that contains it more than once: each placeholder becomes a `<script>` tag that loads and runs the bootstrap again.

The diagnostic in the default template probes `document.modelContext` (`registerTool`, `getTools`, `executeTool` and `'ontoolchange' in document.modelContext`), the deprecated `navigator.modelContext` alias and `navigator.modelContextTesting`, and lists the tool names `getTools()` reports once the page has loaded. A custom template that wants the same list should insert the names with `textContent`, never as HTML.

## What your template must keep

The runtime state branching is a tiny inline `<script>` at the bottom of the template that toggles which of three `<div id="state-*">` blocks becomes visible. As long as your template keeps:

- A `<div id="state-native">` with content for native-API users.
- A `<div id="state-pair">` with content for desktop-client pairing.
- A `<div id="state-disabled">` for sites that have `fallback_widget = false`.
- A closing `<script>` block that flips `.active` on the right state.

...the branching keeps working. The default template at the bottom of this doc is the canonical example.

Each state div is shown only when its condition matches. Put the content unique to that state (success notice, pairing steps, disabled notice) inside its div. Put content that should always appear (the tool list, an "About WebMCP" section, etc.) outside the state divs so it shows regardless of which state is active.

If you want **none** of the runtime branching (e.g. you are building a static "tools available" page for non-agent visitors), drop the script and the `state-*` classes from your template. Plain HTML works fine.

## Minimum viable template

```html
<!doctype html>
<html lang="{{lang}}">
<head>
<meta charset="utf-8">
<title>Connect - {{site_name}}</title>
<meta name="robots" content="noindex">
<style>.state{display:none}</style>
</head>
<body>
<h1>{{site_name}}</h1>
<p>{{site_description}}</p>

<div id="state-native" class="state"><p>Connected.</p></div>
<div id="state-pair" class="state"><p>Pair your MCP client.</p>{{widget_block}}</div>
<div id="state-disabled" class="state"><p>Widget disabled.</p></div>

<h2>Tools available</h2>
<ul>{{tool_list}}</ul>

{{bootstrap_block}}
<script>
(function () {
  // The host the bootstrap registers on: document.modelContext when it can
  // register tools, else the deprecated navigator.modelContext alias (Chrome 146-149).
  var dmc = ('modelContext' in document) ? document.modelContext : null;
  var mc = (dmc && typeof dmc.registerTool === 'function') ? dmc : (('modelContext' in navigator) ? navigator.modelContext : null);
  var hasNative = !!mc && typeof mc.registerTool === 'function';
  var widgetEnabled = {{widget_enabled_js}};
  var id = hasNative ? 'state-native' : (widgetEnabled ? 'state-pair' : 'state-disabled');
  document.querySelectorAll('.state').forEach(function(el){ el.style.display = 'none'; });
  var active = document.getElementById(id);
  if (active) active.style.display = 'block';
})();
</script>
</body>
</html>
```

Keep `class="state"` on all three state divs: the CSS hides every `.state` div and the script shows the one that matches. The script picks its host the way the bootstrap does (`document.modelContext` when it can register tools, else the deprecated `navigator.modelContext` alias). A template that picks differently can say "Connected" while the bootstrap registers nothing, or the reverse.

## What to consider when customising

- **Asset URLs.** If your template references external CSS, JS, or images, use relative paths (`css/styles.css`) so the same file works at both `localhost:8788/mcp` and `example.com/mcp`. Absolute root-relative paths (`/css/styles.css`) work for full-proxy mode but break if you mount the Worker under a sub-path.
- **No tracking on this page.** Resist the temptation to add analytics or ads here. It is a system-style page for agents, not a marketing page.
- **`noindex`.** Keep `<meta name="robots" content="noindex">` (or rely on the response header). This is a per-visitor pairing surface, not a search result.
- **Tool descriptions come from the tool definition.** If a description reads wrong on the landing, edit the `description = "..."` field on the tool in your TOML, not the landing template.
- **`{{tool_list}}` is HTML.** If you want a different layout (e.g. table rows instead of list items), you cannot reshape `{{tool_list}}` from the template alone. Either accept the `<li>` format or open an issue for additional tool-list variants.

## Smaller customisations without overriding the whole page

If all you want to change is the page **title** or the **site description**, edit `[site].name` and `[site].description` in your TOML. The default template already surfaces both. You do not need a custom template for surface-level copy changes.
