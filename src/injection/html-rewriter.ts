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
  const linkTag = `<link rel="webmcp" href="${escapeAttr(opts.manifestUrl)}">`;
  const scriptTag = `<script src="${escapeAttr(opts.bootstrapUrl)}" defer></script>`;

  let rewriter = new HTMLRewriter()
    .on("head", {
      element(el) {
        if (state.linkInjected || !opts.emitLinkTag) return;
        el.append(linkTag, { html: true });
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
