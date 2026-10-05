/**
 * Whether the desktop-bridge widget is on for this build: the feature is switched on
 * ([features].fallback_widget, default false) AND the build ships a widget, which it
 * does only with a usable pin in vendor/webmcp/current.json (WIDGET_ASSET is then the R2
 * key, else null). The widget route, the landing page's pairing block and every sentence
 * that tells a visitor or an agent to pair on the landing page agree on this one answer.
 */

import type { Config } from "./config-types";

export function widgetEnabled(config: Config, widgetAsset: string | null): boolean {
  return config.features.fallback_widget && widgetAsset !== null;
}
