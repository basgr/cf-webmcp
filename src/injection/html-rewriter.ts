/**
 * HTMLRewriter wrapper. Two layers of injection:
 *
 *   1. Bootstrapper (always when shouldInject is true):
 *      - <link rel="webmcp" href="..."> in <head>
 *      - <script src="..." defer></script> before </body>
 *      The caller adds the Link: HTTP header separately (worker.ts).
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

export interface InjectOptions {
  manifestUrl: string;
  bootstrapUrl: string;
  emitLinkTag: boolean;
  /** When set, an additional <link rel="api-catalog"> is injected alongside the webmcp link. */
  apiCatalogUrl?: string;
  /** When set, an additional <link rel="ai-catalog"> is injected alongside the webmcp link. */
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
  const pathname = new URL(request.url).pathname;
  for (const pattern of config.injection.exclude_paths) {
    if (matchGlob(pattern, pathname)) return false;
  }
  return true;
}

export function matchGlob(pattern: string, input: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*") +
      "$",
  );
  return re.test(input);
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
}

export function injectIntoHtml(response: Response, opts: InjectOptions): Response {
  const state = new State();
  const webmcpTag = `<link rel="webmcp" href="${escapeAttr(opts.manifestUrl)}">`;
  const apiCatalogTag = opts.apiCatalogUrl
    ? `<link rel="api-catalog" href="${escapeAttr(opts.apiCatalogUrl)}">`
    : "";
  const aiCatalogTag = opts.aiCatalogUrl
    ? `<link rel="ai-catalog" href="${escapeAttr(opts.aiCatalogUrl)}">`
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
    .on("head", {
      element(el) {
        if (state.linkInjected || !opts.emitLinkTag) return;
        el.append(linkTags, { html: true });
        state.linkInjected = true;
      },
    })
    .on("body", {
      element(el) {
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

    // Stamp toolparamdescription on each named input inside the form.
    // The form's selector + a single space + the param's selector gives a
    // descendant CSS selector that HTMLRewriter understands.
    for (const param of form.params) {
      const compound = `${form.selector} ${param.selector}`;
      rewriter = rewriter.on(compound, {
        element(el) {
          if (!el.getAttribute("toolparamdescription")) {
            el.setAttribute("toolparamdescription", param.description);
          }
        },
      });
    }
  }

  return rewriter.transform(response);
}

export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}
