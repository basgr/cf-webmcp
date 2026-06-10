# Form attribute injection

`cf-webmcp` can stamp [W3C WebMCP declarative form attributes](https://github.com/webmachinelearning/webmcp) onto an existing `<form>` in your origin HTML at the edge. The publisher does not edit a CMS template; they add one TOML block. The Worker rewrites the response on the fly via HTMLRewriter.

This is the difference between "to add WebMCP to your forms, edit your codebase" and "to add WebMCP to your forms, add a `[[forms]]` block in your config and redeploy the Worker". The latter is the whole point of `cf-webmcp`.

## What gets injected

For each `[[forms]]` block that matches the current request path, the Worker stamps four attributes:

- **`toolname`** on the matched `<form>` element
- **`tooldescription`** on the matched `<form>` element (rendered as agent-visible text; see [`docs/security.md`](security.md) before pasting user-generated content into description fields)
- **`toolautosubmit`** on the matched `<form>` element (only when `autosubmit = true`)
- **`toolparamdescription`** on each matched input/select/textarea inside the form

Browsers that implement the W3C draft (Chrome 146+ with the flag) parse these attributes during HTML parse and expose the form as an agent-callable tool via `navigator.modelContext` automatically. No JS work on the publisher side.

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
| `paths` | no | List of glob patterns. The form is only injected when the request pathname matches at least one entry. Empty list (default) means inject on every page. Use glob `*` for wildcards. |
| `autosubmit` | no | Boolean. When `true`, the Worker stamps `toolautosubmit` on the form. Default `false`. |
| `params` | no | List of per-input descriptions. Each has its own `selector` (resolved as a descendant of the form's selector) and `description`. |

### Selector limits

The selectors must work in Cloudflare HTMLRewriter, which supports a subset of CSS Selectors Level 4:

- Element names: `form`, `input`, `select`, `textarea`
- IDs: `#myform`
- Classes: `.contact-form`
- Attribute selectors: `[name=email]`, `[action="/contact"]`, `[type^="email"]`
- Descendant combinator (used implicitly between the form selector and each param selector): `form#contact input[name=email]`

Complex pseudo-classes (`:has()`, `:nth-of-type(...)`) are not supported. If your form does not have a stable id/class/attribute, the easiest fix is to add one on the origin side.

## Path scoping with `paths`

If `paths` is empty (the default), the form is injected on every HTML page the Worker proxies. This is often wrong - your `#contact` selector might accidentally match a similar-id element on another page, or you do not want the search form's tool advertised on the checkout page.

Limit injection to specific URLs with `paths`. Glob `*` is supported:

```toml
paths = ["/contact"]                    # only /contact
paths = ["/contact", "/contact/*"]      # /contact and any nested page
paths = ["/checkout/*"]                 # only inside checkout flow
paths = ["/*"]                          # any top-level page (effectively all)
```

Path matching is exact when no `*` is present. Glob matching is case-sensitive.

## Hand-stamped attributes always win

If the origin HTML already has `toolname` (or any of the four attributes) on the form, the Worker does **not** overwrite it. The publisher's explicit choice wins. This means:

- A team that wants to manage the WebMCP surface from inside the CMS can do so by hand-stamping. The TOML block becomes a no-op for that form.
- A team that wants the edge-managed flow can stamp the basics in TOML and let the Worker handle it.
- Mixed: hand-stamp the tool name in HTML for one form, manage everything via TOML for another.

This applies attribute-by-attribute: if the form has `toolname="foo"` but no `tooldescription`, the Worker will fill in the description from TOML and leave the name alone.

## Tool names must be unique across surfaces

A WebMCP tool name may be registered only once per page. Registering the same name twice - for example a `[[tools]]` entry and a `[[forms]]` block that share a name, both landing on the same page - kills the Chrome renderer (`bad_message` 345, `RFHI_WEBMCP_REGISTER_DUPLICATE_TOOL_NAME`), a Mojo IPC validation kill that no `try/catch` can trap. cf-webmcp guards this on both ends:

- **Build refuses collisions.** The build fails if a name is duplicated within `[[tools]]`, duplicated within `[[forms]]`, or shared between the two. Pick distinct names.
- **Bootstrap de-dupes hand-stamps.** The injected script skips registering any tool whose name is already on the page as a `<form toolname>` (including names you hand-stamped in origin HTML, which the build cannot see). The declarative form wins; the bootstrap stands down for that name.

## Side effects: `SubmitEvent.agentInvoked` and `SubmitEvent.respondWith`

The W3C draft also defines two `SubmitEvent` extensions that fire when the form is submitted by an agent:

- **`event.agentInvoked`** is `true` when the submission came from `navigator.modelContext.executeTool(...)`, `false` for human submissions.
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

You should see the injected `toolname`, `tooldescription`, and optional `toolautosubmit` on the form element, and `toolparamdescription` on each matched input. Then test the runtime path with the diagnostic disclosure on `/mcp` - if `Connected` state is shown, your tools (including the form-injected ones) are visible to `navigator.modelContextTesting.listTools()`.

## What this is not

- **Not a form builder.** The form has to exist in origin HTML. `cf-webmcp` only adds attributes; it does not synthesize a form from config.
- **Not a way to override form behaviour.** Submitting the form still does whatever origin's existing handler does. If you want to intercept agent-invoked submissions, write a `submit` handler on the origin side that checks `event.agentInvoked`.
- **Not a CMS replacement.** If you want the form attributes managed by content editors rather than by config, hand-stamp on the origin side. The TOML approach suits dev/ops teams managing config independently.

