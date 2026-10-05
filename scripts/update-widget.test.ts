import { describe, it, expect } from "vitest";
import { defaultReleaseUrl } from "./update-widget";

describe("defaultReleaseUrl", () => {
  it("is src/webmcp.js at the version's tag on raw.githubusercontent.com", () => {
    // Verified for v0.1.13: this URL answers 200 with the file whose sha256 is the pinned one,
    // while the release asset URL (releases/download/v0.1.13/webmcp.js) answers 404.
    expect(defaultReleaseUrl("v0.1.13")).toBe("https://raw.githubusercontent.com/jasonjmcghee/WebMCP/v0.1.13/src/webmcp.js");
  });

  it("follows the version it is given", () => {
    expect(defaultReleaseUrl("v0.2.0")).toBe("https://raw.githubusercontent.com/jasonjmcghee/WebMCP/v0.2.0/src/webmcp.js");
  });

  it("keeps the version one path segment", () => {
    expect(defaultReleaseUrl("v1/../x")).toBe("https://raw.githubusercontent.com/jasonjmcghee/WebMCP/v1%2F..%2Fx/src/webmcp.js");
  });
});
