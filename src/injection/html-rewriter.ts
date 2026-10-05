/**
 * HTMLRewriter wrapper. Two layers of injection:
 *
 *   1. Bootstrapper (always when shouldInject is true):
 *      - <link rel="webmcp" href="..."> in <head>
 *      - <script src="..." defer></script> before </body>, or at the end of the
 *        document when the page omits </body> (full documents only; a bare
 *        fragment is left alone)
 *      The caller adds the Link: HTTP header separately (handler.ts).
 *
 *   2. Form attribute stamping (when [[forms]] entries match the current path):
 *      For each matched form, set toolname, tooldescription, toolautosubmit on
 *      the form element. For each declared param, set toolparamdescription on
 *      the matched input/select/textarea inside the form. Existing attributes
 *      are NOT overwritten - publishers who hand-stamp win.
 *
 * Acts only when:
 *   - response status is 200
 *   - content-type is text/html with no charset or charset=utf-8
 *   - request path is not in [injection].exclude_paths
 */

import type { Config, FormInjectionConfig } from "../config-types";
import { ARD_REL } from "../ard";

export interface InjectOptions {
  /** When set, a <link rel="webmcp"> to the manifest is injected. Unset while [features].manifest is off. */
  manifestUrl?: string;
  bootstrapUrl: string;
  emitLinkTag: boolean;
  /** When set, an additional <link rel="api-catalog"> is injected alongside the webmcp link. */
  apiCatalogUrl?: string;
  /** When set, an additional <link rel="ard"> (ARD v0.91 manifest) is injected alongside the webmcp link. */
  aiCatalogUrl?: string;
  /** When set, an additional <link rel="agent-skills"> is injected alongside the webmcp link. */
  agentSkillsUrl?: string;
  /**
   * When set, two additional `<link>` tags are injected pointing at the
   * llms.txt:
   *   - `rel="describedby" type="text/markdown"` (IANA-registered per
   *     RFC 8288) so generic scanners that anchor on standard rels find a
   *     publisher description of the site.
   *   - `rel="alternate" type="text/markdown"` matching the convention
   *     used by agent-readiness tooling (Addy Osmani's agentic-seo,
   *     specification.website) for advertising a markdown representation.
   */
  llmsTxtUrl?: string;
  /**
   * Subresource Integrity hash for the bootstrap body, formatted as
   * "sha384-<base64>". When set, the injected script tag carries both
   * `integrity="<value>"` and `crossorigin="anonymous"` so browsers
   * refuse to execute a substituted bootstrap body.
   */
  bootstrapIntegrity?: string;
  /** Forms whose path scope matches the current request. Empty array = no form stamping on this response. */
  forms: FormInjectionConfig[];
}

export function shouldInject(request: Request, response: Response, config: Config): boolean {
  if (response.status !== 200) return false;
  const ct = response.headers.get("content-type") ?? "";
  if (!/^text\/html\b/i.test(ct)) return false;
  if (/charset=/i.test(ct) && !/charset=("?)utf-8/i.test(ct)) return false;
  return !isExcludedPath(config, new URL(request.url).pathname);
}

/** Whether [injection].exclude_paths keeps the injection off this path. */
export function isExcludedPath(config: Config, pathname: string): boolean {
  return config.injection.exclude_paths.some((pattern) => matchGlob(pattern, pathname));
}

/** The InjectOptions that follow from the config alone: the discovery <link> tags. */
export type ConfigLinkOptions = Pick<
  InjectOptions,
  "manifestUrl" | "emitLinkTag" | "apiCatalogUrl" | "aiCatalogUrl" | "agentSkillsUrl" | "llmsTxtUrl"
>;

/**
 * Whether the <link> tags go in and where they point: absolute URLs on the site URL
 * ([site].public_url, else https://<[site].domain>), one per discovery document that is
 * served (feature on, not passthrough; the manifest has no passthrough mode). The handler
 * uses these for every injected page,
 * and the build hashes them into INJECTION_HASH (scripts/build-config.ts), so the ETag
 * suffix of rewritten pages moves whenever the tags change.
 */
export function configLinkOptions(config: Config): ConfigLinkOptions {
  const base = config.site.public_url ?? `https://${config.site.domain}`;
  const served = (on: boolean, block: { mode: string; path: string }): string | undefined =>
    on && block.mode !== "passthrough" ? `${base}${block.path}` : undefined;
  return {
    manifestUrl: config.features.manifest ? `${base}${config.manifest.path}` : undefined,
    emitLinkTag: config.features.link_tag,
    // The rule of apiCatalogServed (src/served.ts), written out: the imports of this file are
    // hashed into INJECTION_HASH by value, which a function cannot be. served.test.ts checks
    // that the two agree for every combination.
    apiCatalogUrl:
      config.features.api_catalog && config.api_catalog.mode !== "passthrough" && config.features.manifest
        ? `${base}${config.api_catalog.path}`
        : undefined,
    aiCatalogUrl: served(config.features.ai_catalog, config.ai_catalog),
    agentSkillsUrl: served(config.features.agent_skills, config.agent_skills),
    llmsTxtUrl: served(config.features.llms_txt, config.llms_txt),
  };
}

/**
 * Glob match for [injection].exclude_paths and [[forms]].paths, against the pathname only
 * (a pathname never holds a query string): `*` matches any run of characters (including
 * none and `/`), `?` matches exactly one character (`/` included), and every other
 * character matches itself, the regex metacharacters escaped. The pattern must match the
 * whole path. The build warns about a pattern with `?` (globPatternWarnings), because
 * v0.5.1 read it as a regex quantifier.
 *
 * Characters are code points, so `?` matches a character outside the BMP as one. The match
 * runs on two pointers and, on a mismatch, goes back only to the last `*` seen, which is
 * enough for globs with no other operators: at most pattern length times path length steps,
 * whatever the path holds. The path is the visitor's to choose, and every proxied request
 * runs every pattern against it; a backtracking regex took seconds on a path of slashes.
 */
export function matchGlob(pattern: string, input: string): boolean {
  const p = compiledGlob(pattern);
  const s = Array.from(input);
  let pi = 0;
  let si = 0;
  // Where the last `*` is in the pattern, and the path position it has consumed up to.
  let star = -1;
  let starSi = 0;
  while (si < s.length) {
    const c = p[pi];
    if (c === "*") {
      star = pi++;
      starSi = si;
    } else if (c !== undefined && (c === "?" || c === s[si])) {
      pi++;
      si++;
    } else if (star !== -1) {
      // Let the last `*` take one more character and try the rest of the pattern again.
      pi = star + 1;
      si = ++starSi;
    } else {
      return false;
    }
  }
  while (p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * A pattern split into code points, once per pattern: the patterns are the config's
 * (exclude_paths and [[forms]].paths), a fixed set per deploy. Capped all the same, so a
 * caller with an open-ended set of patterns cannot grow it without bound.
 */
const GLOB_CACHE = new Map<string, readonly string[]>();
const GLOB_CACHE_MAX = 256;

function compiledGlob(pattern: string): readonly string[] {
  let compiled = GLOB_CACHE.get(pattern);
  if (compiled === undefined) {
    if (GLOB_CACHE.size >= GLOB_CACHE_MAX) GLOB_CACHE.clear();
    compiled = Array.from(pattern);
    GLOB_CACHE.set(pattern, compiled);
  }
  return compiled;
}

/**
 * Return the subset of form injections whose path scope matches the request.
 * - If `paths` is empty, the form applies to all pages.
 * - Otherwise the form applies if any glob in `paths` matches the pathname.
 */
export function formsForPath(forms: FormInjectionConfig[], pathname: string): FormInjectionConfig[] {
  return forms.filter((f) => {
    if (f.paths.length === 0) return true;
    return f.paths.some((p) => matchGlob(p, pathname));
  });
}

class State {
  linkInjected = false;
  scriptInjected = false;
  /**
   * True once the document looks like a full page (doctype, <html>, <head> or
   * <body> seen), as opposed to a bare fragment such as an AJAX partial. Gates
   * the document-end script fallback.
   */
  isDocument = false;
}

/**
 * injectIntoHtml, failing open: if building the rewriter throws synchronously,
 * the untouched origin response is returned with `failedOpen: true` and the error
 * is logged.
 *
 * This is the outer net. A form or param selector that HTMLRewriter rejects is
 * already contained inside injectIntoHtml (only that form or param is skipped,
 * the bootstrap and link tags still go in); what reaches here is any other
 * synchronous failure while the rewriter is being built. That happens before
 * `transform()` touches the body, so `upstream` is still intact and the visitor
 * gets the origin page without WebMCP instead of an error page.
 *
 * Only synchronous throws are caught. An error raised while the body streams
 * surfaces later, in the response body the visitor is already reading, and
 * cannot be intercepted at this point. Selectors are therefore validated at
 * build time (src/selector-grammar.ts), and this wrapper plus the per-selector
 * guard are the nets for what still gets through.
 *
 * Deliberately no `ctx.passThroughOnException()` as an additional net: it falls
 * back to the zone's origin server, not to `[origin].base_url`, so it would hit
 * a different host whenever the Worker proxies to another one, and it does
 * nothing on Custom Domains and workers.dev routes.
 */
export function safeInject(upstream: Response, opts: InjectOptions): { response: Response; failedOpen: boolean } {
  // failedOpen is said outright, not read from `response === upstream`: transform() hands
  // back the very object it was given when there is no body (a HEAD), and that response
  // still counts as rewritten.
  try {
    return { response: injectIntoHtml(upstream, opts), failedOpen: false };
  } catch (e) {
    console.error(
      `cf-webmcp: HTML injection failed, serving the origin response unchanged: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { response: upstream, failedOpen: true };
  }
}

export function injectIntoHtml(response: Response, opts: InjectOptions): Response {
  const state = new State();
  const webmcpTag = opts.manifestUrl ? `<link rel="webmcp" href="${escapeAttr(opts.manifestUrl)}">` : "";
  const apiCatalogTag = opts.apiCatalogUrl
    ? `<link rel="api-catalog" href="${escapeAttr(opts.apiCatalogUrl)}">`
    : "";
  const aiCatalogTag = opts.aiCatalogUrl
    ? `<link rel="${ARD_REL}" href="${escapeAttr(opts.aiCatalogUrl)}">`
    : "";
  const agentSkillsTag = opts.agentSkillsUrl
    ? `<link rel="agent-skills" href="${escapeAttr(opts.agentSkillsUrl)}">`
    : "";
  const describedByTag = opts.llmsTxtUrl
    ? `<link rel="describedby" type="text/markdown" href="${escapeAttr(opts.llmsTxtUrl)}">`
    : "";
  const alternateMarkdownTag = opts.llmsTxtUrl
    ? `<link rel="alternate" type="text/markdown" href="${escapeAttr(opts.llmsTxtUrl)}">`
    : "";
  const linkTags = webmcpTag + apiCatalogTag + aiCatalogTag + agentSkillsTag + describedByTag + alternateMarkdownTag;
  // Subresource Integrity: when a "sha384-<base64>" digest is supplied, emit
  // it on the script tag. `crossorigin="anonymous"` is required by the SRI
  // spec for the browser to perform the integrity check (even on same-origin
  // scripts, where it is technically optional, an explicit anonymous request
  // makes the intent unambiguous).
  const sriAttrs = opts.bootstrapIntegrity
    ? ` integrity="${escapeAttr(opts.bootstrapIntegrity)}" crossorigin="anonymous"`
    : "";
  const scriptTag = `<script src="${escapeAttr(opts.bootstrapUrl)}" defer${sriAttrs}></script>`;

  let rewriter = new HTMLRewriter()
    .onDocument({
      doctype() {
        state.isDocument = true;
      },
      end(end) {
        // Minified HTML may legally omit </body> (and </html>); the body end-tag
        // handler below then never fires. Append at the very end instead. Bare
        // fragments (no doctype/html/head/body) are left alone: injecting a
        // script into an AJAX partial would run it on every swap.
        if (state.scriptInjected || !state.isDocument) return;
        end.append(scriptTag, { html: true });
        state.scriptInjected = true;
      },
    })
    .on("html", {
      element() {
        state.isDocument = true;
      },
    })
    .on("head", {
      element(el) {
        state.isDocument = true;
        if (state.linkInjected || !opts.emitLinkTag || linkTags === "") return;
        el.append(linkTags, { html: true });
        state.linkInjected = true;
      },
    })
    .on("body", {
      element(el) {
        state.isDocument = true;
        if (state.scriptInjected) return;
        el.onEndTag((endTag) => {
          if (state.scriptInjected) return;
          endTag.before(scriptTag, { html: true });
          state.scriptInjected = true;
        });
      },
    });

  for (const form of opts.forms) {
    // Stamp attributes on the matched form element. Skip if the publisher has
    // already stamped them by hand.
    //
    // HTMLRewriter parses a selector eagerly in .on() and throws for one it
    // cannot handle. The build-time grammar (selector-grammar.ts) keeps those
    // out, but forms[].paths defaults to every page, so one that slips through
    // must not cost injection everywhere: skip only the form or param it
    // belongs to. A failed .on() leaves the rewriter unchanged and usable.
    if (
      !tryOn(`form ${JSON.stringify(form.name)}`, form.selector, () => {
        rewriter = rewriter.on(form.selector, {
          element(el) {
            if (!el.getAttribute("toolname")) {
              el.setAttribute("toolname", form.name);
            }
            if (!el.getAttribute("tooldescription")) {
              el.setAttribute("tooldescription", form.description);
            }
            if (form.autosubmit && el.getAttribute("toolautosubmit") === null) {
              el.setAttribute("toolautosubmit", "");
            }
          },
        });
      })
    ) {
      // Every param selector is appended to this one, so they would all fail the
      // same way; skip them without a second log line.
      continue;
    }

    // Stamp toolparamdescription on each named input inside the form.
    // The form's selector + a single space + the param's selector gives a
    // descendant CSS selector that HTMLRewriter understands.
    for (const param of form.params) {
      const compound = `${form.selector} ${param.selector}`;
      // JSON.stringify keeps the log line on one line: \n and \f are legal whitespace in a selector.
      tryOn(`param ${JSON.stringify(param.selector)} of form ${JSON.stringify(form.name)}`, compound, () => {
        rewriter = rewriter.on(compound, {
          element(el) {
            if (!el.getAttribute("toolparamdescription")) {
              el.setAttribute("toolparamdescription", param.description);
            }
          },
        });
      });
    }
  }

  return rewriter.transform(response);
}

/**
 * Runs `register` (a rewriter.on call). On a synchronous throw logs one line
 * naming `what` and the selector and returns false; otherwise true.
 */
function tryOn(what: string, selector: string, register: () => void): boolean {
  try {
    register();
    return true;
  } catch (e) {
    console.error(
      `cf-webmcp: skipping ${what}: HTMLRewriter rejected the selector ${JSON.stringify(selector)}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
