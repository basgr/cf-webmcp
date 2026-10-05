import { describe, it, expect } from "vitest";
import {
  ARD_PATH,
  ARD_PREDECESSOR_PATH,
  ARD_REL,
  SKILL_MEDIA_TYPE,
  didWeb,
  isArdContentType,
  isArdDocument,
  siteHost,
  slugify,
  urnAir,
} from "./ard";

describe("ARD v0.91 constants", () => {
  it("names the canonical path, the link relation and the predecessor path", () => {
    expect(ARD_PATH).toBe("/.well-known/ard.json");
    expect(ARD_REL).toBe("ard");
    expect(ARD_PREDECESSOR_PATH).toBe("/.well-known/ai-catalog.json");
  });

  it("types a skill entry the way the v0.91 skill example does", () => {
    expect(SKILL_MEDIA_TYPE).toBe("application/ai-skill+md");
  });
});

describe("didWeb", () => {
  it("is did:web:<host> for a host without a port", () => {
    expect(didWeb("example.com")).toBe("did:web:example.com");
  });

  it("percent-encodes the port colon", () => {
    expect(didWeb("example.com:8787")).toBe("did:web:example.com%3A8787");
  });

  it("lowercases and uses the punycode form of an IDN host", () => {
    expect(didWeb("Example.COM")).toBe("did:web:example.com");
    expect(didWeb("bücher.example")).toBe("did:web:xn--bcher-kva.example");
  });
});

describe("urnAir", () => {
  it("is urn:air:<publisher>:<namespace>:<name>", () => {
    expect(urnAir("example.com", "skill", "example-co")).toBe("urn:air:example.com:skill:example-co");
  });

  it("drops the port from the publisher segment", () => {
    expect(urnAir("example.com:8787", "skill", "x")).toBe("urn:air:example.com:skill:x");
  });

  it("lowercases the publisher and uses the punycode form of an IDN host", () => {
    expect(urnAir("Example.COM", "skill", "x")).toBe("urn:air:example.com:skill:x");
    expect(urnAir("bücher.example:8443", "skill", "x")).toBe("urn:air:xn--bcher-kva.example:skill:x");
  });

  it("matches the identifier pattern of the v0.91 entry schema", () => {
    const pattern = /^urn:air:[a-zA-Z0-9.-]+(:[a-zA-Z0-9._-]+)+$/;
    expect(urnAir("example.com:8787", "skill", slugify("Café Grüße"))).toMatch(pattern);
  });
});

describe("siteHost", () => {
  it("is [site].domain when public_url is not set, port included", () => {
    expect(siteHost({ domain: "example.com" })).toBe("example.com");
    expect(siteHost({ domain: "example.com:8787" })).toBe("example.com:8787");
  });

  it("is the host of public_url when it is set, port included", () => {
    expect(siteHost({ domain: "example.com", public_url: "http://localhost:8787" })).toBe("localhost:8787");
    expect(siteHost({ domain: "example.com", public_url: "https://www.example.com" })).toBe("www.example.com");
  });
});

describe("slugify", () => {
  it("lowercases, replaces runs of anything but a-z and 0-9 with one hyphen, trims hyphens", () => {
    expect(slugify("Example Site")).toBe("example-site");
    expect(slugify("  cf-webmcp ")).toBe("cf-webmcp");
    expect(slugify("Tübingen & Co.")).toBe("tubingen-co");
  });

  it("removes accents through NFKD", () => {
    expect(slugify("Café")).toBe("cafe");
    expect(slugify("ﬁle")).toBe("file");
  });

  it("treats a letter without an ASCII decomposition as a separator, like any other non-ASCII character", () => {
    // NFKD leaves ß as ß; it is not special-cased to "ss".
    expect(slugify("Grüße Welt")).toBe("gru-e-welt");
  });

  it("returns an empty string when nothing is left (the build refuses that where a slug is required)", () => {
    expect(slugify("")).toBe("");
    expect(slugify("///")).toBe("");
    expect(slugify("日本語")).toBe("");
  });

  it("always yields a valid skill name or an empty string", () => {
    const name = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const input of ["Example Co.", "--a--b--", "Grüße Welt", "x", "A1 B2"]) {
      expect(slugify(input)).toMatch(name);
    }
  });
});

describe("isArdDocument (v0.91: an object with an entries array of objects, each with a string identifier)", () => {
  it("accepts a valid document, an empty entries array and extra members", () => {
    expect(isArdDocument({ entries: [] })).toBe(true);
    expect(isArdDocument({ entries: [{ identifier: "urn:air:example.com:skill:x" }] })).toBe(true);
    expect(isArdDocument({ specVersion: "1.0", host: { displayName: "x" }, entries: [{ identifier: "a" }] })).toBe(true);
  });

  it.each([
    ["null", null],
    ["an array", [{ identifier: "a" }]],
    ["a string", "entries"],
    ["no entries", { host: {} }],
    ["entries not an array", { entries: {} }],
    ["an entry that is not an object", { entries: ["urn:air:a:b:c"] }],
    ["an entry that is null", { entries: [null] }],
    ["an entry that is an array", { entries: [[]] }],
    ["an entry without identifier", { entries: [{ displayName: "x" }] }],
    ["an entry with a non-string identifier", { entries: [{ identifier: 1 }] }],
  ])("rejects %s", (_label, value) => {
    expect(isArdDocument(value)).toBe(false);
  });
});

describe("isArdContentType", () => {
  it("accepts application/json, application/ai-catalog+json and a missing type", () => {
    expect(isArdContentType(null)).toBe(true);
    expect(isArdContentType("")).toBe(true);
    expect(isArdContentType("application/json")).toBe(true);
    expect(isArdContentType("application/json; charset=utf-8")).toBe(true);
    expect(isArdContentType("application/ai-catalog+json")).toBe(true);
  });

  it("rejects text types and HTML", () => {
    expect(isArdContentType("text/json")).toBe(false);
    expect(isArdContentType("text/plain")).toBe(false);
    expect(isArdContentType("text/html")).toBe(false);
  });
});
