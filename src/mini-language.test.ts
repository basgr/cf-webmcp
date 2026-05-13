import { describe, it, expect } from "vitest";
import { compileTemplate, parsePlaceholder } from "./mini-language";

describe("parsePlaceholder", () => {
  it("parses a required placeholder", () => {
    expect(parsePlaceholder("query")).toEqual({ name: "query", operator: "required" });
  });

  it("parses a default placeholder", () => {
    expect(parsePlaceholder("limit|default:10")).toEqual({
      name: "limit",
      operator: "default",
      defaultValue: "10",
    });
  });

  it("parses an optional placeholder", () => {
    expect(parsePlaceholder("category|optional")).toEqual({ name: "category", operator: "optional" });
  });

  it("parses a map placeholder", () => {
    const p = parsePlaceholder("in_stock|map:true=instock,false=outofstock");
    expect(p.name).toBe("in_stock");
    expect(p.operator).toBe("map");
    expect(p.mapping?.get("true")).toBe("instock");
    expect(p.mapping?.get("false")).toBe("outofstock");
  });

  it("rejects invalid names", () => {
    expect(() => parsePlaceholder("Bad-Name")).toThrow();
    expect(() => parsePlaceholder("1leading")).toThrow();
  });

  it("rejects unknown operators", () => {
    expect(() => parsePlaceholder("x|foobar")).toThrow();
  });
});

describe("compileTemplate", () => {
  it("substitutes a required placeholder in a path", () => {
    const c = compileTemplate("https://example.com/posts/{{slug}}");
    expect(c.resolver({ slug: "hello-world" })).toBe("https://example.com/posts/hello-world");
    expect(c.params).toEqual(["slug"]);
  });

  it("URL-encodes per position", () => {
    const c = compileTemplate("https://example.com/p/{{slug}}?q={{query}}");
    // Path position keeps `/` unescaped; query position escapes everything.
    expect(c.resolver({ slug: "a b/c", query: "hello world" })).toBe(
      "https://example.com/p/a%20b/c?q=hello%20world",
    );
  });

  it("path placeholder preserves multi-segment paths", () => {
    const c = compileTemplate("http://localhost:8081{{path}}");
    expect(c.resolver({ path: "/blog/hello-world" })).toBe(
      "http://localhost:8081/blog/hello-world",
    );
  });

  it("path placeholder still encodes ? and #", () => {
    const c = compileTemplate("https://example.com{{path}}");
    expect(c.resolver({ path: "/about?evil=1" })).toBe(
      "https://example.com/about%3Fevil%3D1",
    );
  });

  it("throws on missing required parameter", () => {
    const c = compileTemplate("https://example.com/{{slug}}");
    expect(() => c.resolver({})).toThrow(/required parameter "slug" missing/);
  });

  it("applies default values", () => {
    const c = compileTemplate("https://example.com/posts?per_page={{limit|default:10}}");
    expect(c.resolver({})).toBe("https://example.com/posts?per_page=10");
    expect(c.resolver({ limit: 25 })).toBe("https://example.com/posts?per_page=25");
  });

  it("strips an optional query param when missing", () => {
    const c = compileTemplate("https://example.com/posts?slug={{slug|optional}}&_fields=id");
    expect(c.resolver({})).toBe("https://example.com/posts?_fields=id");
    expect(c.resolver({ slug: "hello" })).toBe("https://example.com/posts?slug=hello&_fields=id");
  });

  it("strips a leading optional query param cleanly", () => {
    const c = compileTemplate("https://example.com/posts?slug={{slug|optional}}");
    expect(c.resolver({})).toBe("https://example.com/posts");
  });

  it("strips a middle optional param without leaving stray ampersands", () => {
    const c = compileTemplate(
      "https://example.com/posts?a=1&slug={{slug|optional}}&b=2",
    );
    expect(c.resolver({})).toBe("https://example.com/posts?a=1&b=2");
  });

  it("applies map operator", () => {
    const c = compileTemplate(
      "https://example.com/products?stock={{in_stock|map:true=instock,false=outofstock}}",
    );
    expect(c.resolver({ in_stock: true })).toBe("https://example.com/products?stock=instock");
    expect(c.resolver({ in_stock: false })).toBe("https://example.com/products?stock=outofstock");
  });

  it("throws on map miss", () => {
    const c = compileTemplate("https://example.com/x?s={{s|map:a=1,b=2}}");
    expect(() => c.resolver({ s: "c" })).toThrow(/no entry for key "c"/);
  });

  it("forbids optional in path position", () => {
    const c = compileTemplate("https://example.com/{{slug|optional}}/x");
    expect(() => c.resolver({})).toThrow(/cannot omit/);
  });
});
