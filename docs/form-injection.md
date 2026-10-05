# Form attribute injection

`cf-webmcp` can stamp [W3C WebMCP declarative form attributes](https://github.com/webmachinelearning/webmcp) onto an existing `<form>` in your origin HTML at the edge. The publisher does not edit a CMS template; they add one TOML block. The Worker rewrites the response on the fly via HTMLRewriter.

This is the difference between "to add WebMCP to your forms, edit your codebase" and "to add WebMCP to your forms, add a `[[forms]]` block in your config and redeploy the Worker". The latter is the whole point of `cf-webmcp`.

## What gets injected

For each `[[forms]]` block that matches the current request path, the Worker stamps four attributes:

- **`toolname`** on the matched `<form>` element
- **`tooldescription`** on the matched `<form>` element (rendered as agent-visible text; see [`docs/security.md`](security.md) before pasting user-generated content into description fields)
- **`toolautosubmit`** on the matched `<form>` element (only when `autosubmit = true`)
- **`toolparamdescription`** on each matched input/select/textarea inside the form

Browsers that implement the declarative part of the W3C draft (Chrome with WebMCP on and Cloudflare Kitesurf; see [`docs/browser-support.md`](browser-support.md)) parse these attributes during HTML parse and expose the form as an agent-callable tool via the WebMCP runtime (`document.modelContext`) automatically. No JS work on the publisher side.

## Config

```toml
[[forms]]
name        = "contact"
description = "Submit a contact form to reach the support team."
selector    = "form#contact-form"
paths       = ["/contact", "/contact/*"]
autosubmit  = false

  [[forms.params]]
  selector    = "input[name=email]"
  description = "The sender's email address."

  [[forms.params]]
  selector    = "input[name=name]"
  description = "The sender's name."

  [[forms.params]]
  selector    = "textarea[name=message]"
  description = "The message body."
```

### Field reference

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Tool name. Must match `^[a-z][a-z0-9_]*$` (same rules as imperative tool names). |
| `description` | yes | Human-readable description of what the form does. Agents see this when listing tools. |
| `selector` | yes | CSS selector matching the `<form>` element. Must start with `form`. Examples: `form#contact`, `form.contact-form`, `form[action="/contact"]`. |
| `paths` | no | List of glob patterns. The form is only injected when the request pathname matches at least one entry. Empty list (default) means inject on every page. `*` and `?` are wildcards (see [Path scoping](#path-scoping-with-paths)). |
| `autosubmit` | no | Boolean. When `true`, the Worker stamps `toolautosubmit` on the form. Default `false`. |
| `params` | no | List of per-input descriptions. Each has its own `selector` (resolved as a descendant of the form's selector) and `description`. |

### Selector limits

The selectors must work in Cloudflare HTMLRewriter, which supports a subset of CSS Selectors Level 4:

- Element names: `form`, `input`, `select`, `textarea`, and `*`
- IDs: `#myform`. Identifiers (ids, classes, element and attribute names) must not be empty or start with a digit, and may not use backslash escapes.
- Classes: `.contact-form`
- Attribute selectors: `[name=email]`, `[action="/contact"]`, `[type^="email"]`, with the operators `=`, `~=`, `^=`, `$=`, `*=`, `|=` and an optional `i` or `s` flag. An unquoted value must be an identifier: write `[name="2fa"]` and `[action="/contact"]`, not `[name=2fa]` or `[action=/contact]`. Attribute names must be lowercase (`[name=email]`, not `[NAME=email]`): HTML attribute names match case-insensitively, so the lowercase form also matches `NAME="email"` in the markup, while an uppercase name in the selector never matches.
- Descendant (space) and child (`>`) combinators. The form selector and each param selector are joined with a descendant combinator: `form#contact input[name=email]`. A param selector may start with `>` to mean a direct child: `> input[name=email]`.
- `:nth-child()` and `:nth-of-type()` with `an+b`, `odd`, `even` or a number (no `of S` clause), `:first-child` and `:first-of-type` (no argument), and `:not(...)` with a non-empty argument

Not supported: the sibling combinators `+` and `~`, pseudo-elements (`::before`), `:has()`, every other pseudo-class (`:hover`, `:last-child`, `:is()`), comma lists, comments, namespaces (`svg|rect`) and backslash escapes. Quoted attribute values may contain any of these characters (`[action="/a,b"]` is fine), except backslashes and line breaks. Where you would escape a character in an identifier, match the attribute instead: `[class~="sm:flex"]` for a Tailwind class, `[id="123"]` for an id that starts with a digit. A selector may be at most 1024 characters and 64 compounds long. Every compound counts toward the 64, also those inside `:not()` and in each entry of a list (`form:not(.a, .b)` counts three: `form:not(...)`, `.a` and `.b`; a `dom_extract` list such as `main, article` counts two), and `:not()` may nest at most 16 deep. The form selector and each param selector are checked on their own.

The build checks every selector against exactly this list and fails with a message naming the problem, so a typo is caught when you build rather than on live pages. The check is deliberately strict: it accepts only what Cloudflare's HTMLRewriter is known to take. It is a safeguard, not a guarantee; if a selector still gets past it and HTMLRewriter rejects it at request time, the Worker skips only that form (or that one param), logs a line naming it, and injects everything else on the page as usual. If your form does not have a stable id/class/attribute, the easiest fix is to add one on the origin side.

The `selector` and `strip` entries of a `dom_extract` tool go through the same check, except that they may be comma lists (`main, article`), because each one is handed to HTMLRewriter on its own.

## Path scoping with `paths`

If `paths` is empty (the default), the form is injected on every HTML page the Worker proxies. This is often wrong - your `#contact` selector might accidentally match a similar-id element on another page, or you do not want the search form's tool advertised on the checkout page.

Limit injection to specific URLs with `paths`. Two characters are wildcards: `*` matches any run of characters, none included, and `?` matches exactly one character; both match `/` too. Every other character, `.` and the brackets included, matches itself. A pattern is matched against the whole path and never sees the query string: `/search?q=*` does not match a request for `/search?q=1`, whose path is `/search`. Examples:

```toml
paths = ["/contact"]                    # only /contact
paths = ["/contact", "/contact/*"]      # /contact and any nested page
paths = ["/checkout/*"]                 # only inside checkout flow
paths = ["/*"]                          # every path (* matches / too)
paths = ["/v?/docs/*"]                  # /v1/docs/..., /v2/docs/...: one character after /v
```

Path matching is exact when no `*` or `?` is present. Glob matching is case-sensitive. `[injection].exclude_paths` uses the same patterns. The build warns about every pattern in either list that contains `?`: before v0.6.0 a `?` made the previous character optional (`/search?*` also matched `/search`), and now it stands for one character.

## Hand-stamped attributes always win

If the origin HTML already has `toolname` (or any of the four attributes) on the form, the Worker does **not** overwrite it. The publisher's explicit choice wins. This means:

- A team that wants to manage the WebMCP surface from inside the CMS can do so by hand-stamping. The TOML block becomes a no-op for that form.
- A team that wants the edge-managed flow can stamp the basics in TOML and let the Worker handle it.
- Mixed: hand-stamp the tool name in HTML for one form, manage everything via TOML for another.

This applies attribute-by-attribute: if the form has `toolname="foo"` but no `tooldescription`, the Worker will fill in the description from TOML and leave the name alone.

## Tool names must be unique across surfaces

A WebMCP tool name may be registered only once per page. Registering the same name twice - for example a `[[tools]]` entry and a `[[forms]]` block that share a name, both landing on the same page - kills the Chrome renderer (`bad_message` 345, `RFHI_WEBMCP_REGISTER_DUPLICATE_TOOL_NAME`), a Mojo IPC validation kill that no `try/catch` can trap. cf-webmcp guards this on both ends:

- **Build refuses collisions.** The build fails if a name is duplicated within `[[tools]]`, duplicated within `[[forms]]`, or shared between the two. Pick distinct names.
- **Bootstrap de-dupes hand-stamps.** The injected script skips registering any tool whose name is already on the page as a `<form toolname>` (including names you hand-stamped in origin HTML, which the build cannot see). The declarative form wins; the bootstrap stands down for that name. It also skips a name that `getTools()` lists, when the browser has it (if `getTools()` has not answered after 1500 ms it registers without that answer, still skipping the `toolname` elements and its own earlier registrations), and a name that an earlier run of the script on the same page registered. A name another script registers after these checks is not seen.

## Side effects: `SubmitEvent.agentInvoked` and `SubmitEvent.respondWith`

The W3C draft also defines two `SubmitEvent` extensions that fire when the form is submitted by an agent:

- **`event.agentInvoked`** is `true` when the submission came from the WebMCP runtime's `executeTool(...)`, `false` for human submissions.
- **`event.respondWith(promise)`** lets the page return a structured response to the agent instead of (or alongside) the normal form submission flow.

`cf-webmcp` does not generate or inject the submit-handler JS that uses these extensions. The publisher writes it on the origin side: an inline `<script>` (or external file) that calls `form.addEventListener("submit", ...)`, checks `event.agentInvoked`, and calls `event.respondWith(Promise.resolve({...}))` with a structured JSON envelope describing the result.

## Example: WordPress contact form (Contact Form 7)

```toml
[[forms]]
name        = "contact"
description = "Submit the site's main contact form."
selector    = "form.wpcf7-form"
paths       = ["/contact"]
autosubmit  = false

  [[forms.params]]
  selector    = "input[name=your-name]"
  description = "Your name (Contact Form 7 default field)."

  [[forms.params]]
  selector    = "input[name=your-email]"
  description = "Your email address."

  [[forms.params]]
  selector    = "textarea[name=your-message]"
  description = "The message body."
```

Drop that into your `wordpress.toml`, redeploy, and the existing CF7 contact form is now agent-callable. No plugin install, no theme edit.

## Example: WooCommerce add-to-cart

```toml
[[forms]]
name        = "add_to_cart"
description = "Add the currently-displayed product to the shopping cart."
selector    = "form.cart"
paths       = ["/product/*"]
autosubmit  = false

  [[forms.params]]
  selector    = "input[name=quantity]"
  description = "Number of units to add. Defaults to 1."
```

Now an agent can `executeTool("add_to_cart", { quantity: 2 })` on any product page. WooCommerce's existing handlers take it from there.

## Verifying it works

After deploy, visit a page that has a form-injection block applied to it and view source:

```bash
curl -s https://yourdomain.com/contact | grep -i 'toolname'
```

You should see the injected `toolname`, `tooldescription`, and optional `toolautosubmit` on the form element, and `toolparamdescription` on each matched input. Then open that page in a browser with WebMCP on. Where the browser exposes the consumer side, `navigator.modelContextTesting.listTools()` lists the page's tools (the testing flag and Browser Run lab sessions expose it, see [`docs/browser-support.md`](browser-support.md)). The diagnostic on `/mcp` cannot show form tools: it lists the tools registered on the landing page itself, and forms are stamped only on the origin pages they match.

## What this is not

- **Not a form builder.** The form has to exist in origin HTML. `cf-webmcp` only adds attributes; it does not synthesize a form from config.
- **Not a way to override form behaviour.** Submitting the form still does whatever origin's existing handler does. If you want to intercept agent-invoked submissions, write a `submit` handler on the origin side that checks `event.agentInvoked`.
- **Not a CMS replacement.** If you want the form attributes managed by content editors rather than by config, hand-stamp on the origin side. The TOML approach suits dev/ops teams managing config independently.

