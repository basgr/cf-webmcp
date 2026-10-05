import { describe, expect, it } from "vitest";
import { widgetEnabled } from "./widget-state";
import { makeConfig } from "./test-support/config";

describe("widgetEnabled", () => {
  const on = makeConfig({ features: { fallback_widget: true } });
  const off = makeConfig({ features: { fallback_widget: false } });

  it("needs the feature and a widget in the build", () => {
    expect(widgetEnabled(on, "widget.abc.js")).toBe(true);
    expect(widgetEnabled(on, null)).toBe(false);
    expect(widgetEnabled(off, "widget.abc.js")).toBe(false);
    expect(widgetEnabled(off, null)).toBe(false);
  });

  it("is off in a default config: the widget is opt-in", () => {
    expect(widgetEnabled(makeConfig(), "widget.abc.js")).toBe(false);
  });
});
