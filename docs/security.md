# Security model

cf-webmcp is a publisher-side discovery and execution layer. It does not enforce agent-side or model-side security. This page documents that boundary explicitly so publishers know what they are responsible for.

For SSRF, cookie handling, rate limiting, CORS, content caps, path validation, and other server-side boundaries, see [`docs/privacy.md`](privacy.md), [`docs/scope.md`](scope.md), and [`docs/deployment.md`](deployment.md). This page focuses on the boundaries cf-webmcp does **not** enforce, because they fall outside the publisher-server layer entirely.

## Tool descriptions are not a security boundary

`[[tools]].description`, `[[forms]].description`, `[[forms.params]].description`, and `[[agent_skills.hints]].body` are rendered into agent-visible text:

- The manifest at `/.well-known/webmcp`
- The `tooldescription` / `toolparamdescription` HTML attributes stamped onto matching `<form>` elements
- The SKILL.md body and AGENTS.md block

cf-webmcp serves whatever the publisher writes in TOML. There is no semantic sanitisation, and there cannot be - descriptions ARE the content that agents consume, by design.

Any of those description fields can therefore act as a [prompt injection](https://www.earlence.com/blog.html#/post/webmcp-sameorigin) against an agent that reads them. Browser same-origin policy isolates tabs at the DOM level, but an agent's model context lives outside the browser and is typically retained across tabs. A description loaded on your site can in principle instruct a later agent session operating on a different site.

This is not a hypothetical. The strength of origin isolation against this class of attack today is only as strong as model-side prompt-injection defences, which are not a security boundary you can rely on. Further reading:

- [Earlence Fernandes, "Breaking Origin Isolation without Breaking the Browser"](https://www.earlence.com/blog.html#/post/webmcp-sameorigin) (UCSD, April 2026)
- [Roesner & Kohlbrenner, "Agentic Browsers and the Same-Origin Policy"](https://agent-security.cs.washington.edu/agentic_browsers_sop.html)

## Publisher implications

Practical consequences for anyone authoring cf-webmcp TOML:

- **Treat every description field as model-visible text.** Including agents that retain context from other sites you do not control.
- **Never paste user-generated content into description fields.** A search keyword, forum title, or support-ticket body submitted by an attacker becomes an authored prompt-injection payload on your site.
- **Keep descriptions terse and behavioural.** "Search the site by keyword. Returns matching URLs." Avoid imperatives directed at the agent ("Use this tool whenever...") and quoting of untrusted input.
- **If your TOML is CMS-generated**, gate description fields behind the same review you apply to publishing arbitrary text on your homepage.

## Agent-runtime trust

cf-webmcp publishes tools. It does not authenticate or rate-limit the agent runtime that calls them. Any agent can read the manifest, AGENTS.md, SKILL.md, and POST to `/_webmcp/exec/<tool>` (subject to per-IP and per-tool rate limits). There is no agent identity check.

**Implication:** treat your tool endpoints as public read-only HTTP endpoints. Do not expose authenticated reads, write actions, or anything personalised via cf-webmcp. The project assumes public reads by design (see [`docs/scope.md`](scope.md) for what's in and out of scope).

## Defence-in-depth in cf-webmcp itself

- **Subresource Integrity (SRI) on the injected bootstrap `<script>`** (since v0.3.6). The injected tag carries `integrity="sha384-..."` and `crossorigin="anonymous"`. A browser refuses to execute the bootstrap if its body has been substituted between server and client (compromised CDN node, MITM on a non-HTTPS leg, intermediary cache poisoning). Toggle via `[features].subresource_integrity` (default `true`). Note: this does not address the cross-origin prompt-injection class above; it is a separate, network-layer defence.
- **Executors read declared input only, and a path placeholder stays under its prefix.** The exec route hands an executor, a POST body and the cache key only the properties the tool declares in `input_schema` (an undeclared key, a `__proto__` entry or an object inside an untyped array never leaves the Worker), and a value written into a `url_template` path cannot hold a `.` or `..` segment or move the request outside the template's own path prefix. See [`docs/limitations.md`](limitations.md#a-path-placeholder-cannot-climb-out-of-its-path). So the deploy-token headers go only to origins in `allowed_origins`, and only to paths under the static prefix of the template. That prefix is only as narrow as the template: for a template rooted at the origin, such as `https://example.com{{path}}`, it is `/`, and a caller can have any path on the origin requested with the token. The build warns about such a template, naming the tool, unless the first placeholder only takes values the publisher fixed (a `map:` operator, or an `enum` on its input property). If the tool only needs part of the site, give the template a fixed path prefix (`https://example.com/docs/{{path}}`).
- **The deploy token is taken out of what the Worker answers.** An origin endpoint that echoes request headers (a debug page, a header-echo API, an error page that lists the request) would hand the token back. In tool output, every occurrence of the token is replaced with `[redacted]`, checked on the envelope as it is sent, after any JSON parse, so in an error message too. On the merge routes (`/llms.txt`, `/robots.txt`, `/.well-known/agents.md`, the API catalog, the ARD manifest and the agent skill), a header of origin's whose value holds the token is dropped as origin's answer arrives, and the token is replaced in the body, in a merged file and in an origin answer the route relays as it came. A header the Worker sets itself (`Content-Type`, `Cache-Control`, `X-Robots-Tag`, an `ETag` it computed, CORS) is never dropped. The ARD manifest's `ETag` is a hash of the body it serves, after the replacement, so it cannot be used to check a guess at the token.
- **Which forms of the token are matched.** Two: its value as written, and the form `JSON.stringify` writes inside a string, which escapes `"`, `\` and control characters (as `\n`, `\t` and the like, the others as `\uXXXX`). Nothing else is: not the `\/` that some JSON writers (PHP's `json_encode`, for one) put for a slash, not a `\uXXXX` escape of an ordinary character, not percent-encoding, base64, HTML entities or a change of letter case, and not a redirect `Location` the Worker writes again after resolving it. So make the token 32 or more characters of `A-Z`, `a-z`, `0-9`, `_` and `-` (`openssl rand -hex 32`): none of those escapes changes such a token, so the value as written is the form an echo of it takes, unless origin transforms the whole value (base64, upper case, every character as `\uXXXX`). A token under 16 characters is not searched for at all, because replacing so short a string would mangle ordinary text and drop every header of origin's that happens to contain it; the Worker logs a warning once per isolate instead. Preflight warns about a token under 32 characters or with other characters. Even with a good token, keep endpoints that echo request headers off the paths a tool can reach.

## Reporting a vulnerability

For cf-webmcp bugs that are not publisher misconfiguration and not agent-runtime weaknesses, email the maintainer (see [README.md](../README.md)). Do not file a public Issue or Discussion if the report is exploitable.

For agent-runtime issues (cross-origin context, prompt injection at the model layer), report upstream to the agent or browser team. cf-webmcp cannot fix those.
