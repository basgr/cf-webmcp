/**
 * What agents.md and SKILL.md say about where the tools live, worked out from the config so
 * that neither claims more than the Worker and the build do:
 *
 *   - The injected bootstrap registers the [[tools]] (not the [[forms]]) on every HTML page
 *     the Worker rewrites, which it does only while [features].inject_html is on.
 *   - The Worker stamps a [[forms]] entry only on the pages its paths match, and only while it
 *     rewrites HTML; with inject_html off no form tool exists.
 *   - The landing page loads the bootstrap through {{bootstrap_block}}. The default template
 *     has it; whether a custom template does is not known here, so a custom landing is named
 *     and nothing more is claimed about it.
 *   - The manifest, the exec route, the landing's tool list and the widget know the [[tools]]
 *     only.
 */

import type { Config } from "./config-types";

/** The producer API, as both documents name it. The bootstrap probes document first. */
const RUNTIME = "`document.modelContext` (Chrome 146 to 149: the deprecated `navigator.modelContext`)";

/** Whether the Worker stamps form tools at all: [[forms]] configured and HTML rewriting on. */
export function formToolsStamped(config: Config): boolean {
  return config.features.inject_html && config.forms.length > 0;
}

/** Whether the landing page uses the default template, which lists the tools and loads the bootstrap. */
export function defaultLandingTemplate(config: Config): boolean {
  return config.webmcp_landing.template === undefined;
}

/**
 * "the tools", or "the tools that are not forms" while form tools exist: what the bootstrap,
 * the manifest, the exec route, the landing's list and the widget cover.
 */
export function scriptTools(config: Config): string {
  return formToolsStamped(config) ? "the tools that are not forms" : "the tools";
}

/**
 * Where a browser-native agent finds the tools registered, as one or two sentences, or null
 * when nothing this site serves is known to register them: HTML injection off and either no
 * landing page or a custom landing template. `landingLink` is the landing URL as the document
 * writes links.
 */
export function browserRegistration(config: Config, landingLink: string): string | null {
  if (config.features.inject_html) {
    const forms = formToolsStamped(config);
    return (
      `On pages that load this site's cf-webmcp script, ${scriptTools(config)} register on ${RUNTIME} when the page loads.` +
      (forms ? " A form tool exists only on pages that carry its form." : "")
    );
  }
  if (config.features.webmcp_landing && defaultLandingTemplate(config)) {
    return `The tools register on ${RUNTIME} when the WebMCP page, ${landingLink}, loads.`;
  }
  return null;
}
