import { describe, it, expect } from "vitest";
import { defaultReleaseUrl, parseArgs } from "./update-widget";

const SHA = "0".repeat(64);

describe("parseArgs", () => {
  it("accepts a release tag vX.Y.Z with a sha256, and an optional release URL", () => {
    expect(parseArgs([`--version=v0.1.13`, `--sha256=${SHA}`])).toEqual({ version: "v0.1.13", sha256: SHA });
    expect(parseArgs([`--version=v0.1.13`, `--sha256=${SHA}`, "--release-url=https://example.com/w.js"])).toEqual({
      version: "v0.1.13",
      sha256: SHA,
      releaseUrl: "https://example.com/w.js",
    });
  });

  // The landing names the bridge release from the version, so only a tag that maps to an npm
  // version is accepted; the check runs before anything is downloaded.
  it.each(["0.1.13", "main", "v0.1", "v0.1.13-beta.1", "latest"])("refuses --version=%s up front, naming the format", (version) => {
    expect(() => parseArgs([`--version=${version}`, `--sha256=${SHA}`])).toThrow(/vX\.Y\.Z/);
    expect(() => parseArgs([`--version=${version}`, `--sha256=${SHA}`])).toThrow(JSON.stringify(version));
  });

  it("still asks for both flags", () => {
    expect(() => parseArgs([`--version=v0.1.13`])).toThrow(/usage/);
  });
});

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
