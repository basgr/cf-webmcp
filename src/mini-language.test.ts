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

describe("placeholders read own properties of the input only", () => {
  it("a {{constructor}} placeholder is missing, not the Object function, when the input has none", () => {
    const c = compileTemplate("https://example.com/x/{{constructor}}");
    expect(() => c.resolver({})).toThrow(/required parameter "constructor" missing/);
    expect(c.resolver({ constructor: "abc" })).toBe("https://example.com/x/abc");
  });

  it("an optional or defaulted placeholder named like an inherited member behaves as absent", () => {
    const optional = compileTemplate("https://example.com/x?a={{constructor|optional}}&b=1");
    expect(optional.resolver({})).toBe("https://example.com/x?b=1");
    const defaulted = compileTemplate("https://example.com/x/{{constructor|default:none}}");
    expect(defaulted.resolver({})).toBe("https://example.com/x/none");
  });
});

describe("a path-position placeholder cannot carry a dot segment", () => {
  const path = compileTemplate("https://example.com/api/{{id}}");

  // The value is joined into the path: `..` would be resolved by the URL parser and move the
  // request out of /api/ (to /admin, with the deploy-token headers attached).
  it.each([
    ["../../admin", "a parent segment and more"],
    ["..", "a bare .."],
    [".", "a bare ."],
    ["../", "a parent segment with a slash"],
    ["/../", "slashes round a parent segment"],
    ["a/../b", "a parent segment in the middle"],
    ["a/..", "a trailing .."],
    ["a/.", "a trailing ."],
    ["/./", "a current-directory segment"],
    ["..%2F", "an encoded slash after .."],
    ["..%2f..%2fadmin", "lower-case encoded slashes"],
    ["%2e%2e/", "an encoded .."],
    ["%2E%2E/", "an encoded .. in capitals"],
    [".%2e/", "a mixed-case, mixed-form .."],
    ["%2e./", "an encoded dot then a dot"],
    ["a%2f%2e%2e%2fb", "an encoded slash, .. and slash"],
    ["..\\", "a backslash after .."],
    ["a\\..\\b", "backslashes round .."],
    ["a%5c..%5cb", "encoded backslashes round .."],
    ["%252e%252e/x", "a doubly encoded .."],
    ["%25252e%25252e/x", "a triply encoded .."],
  ])("refuses %j (%s)", (value) => {
    expect(() => path.resolver({ id: value })).toThrow(/must not contain a "\." or "\.\." path segment/);
  });

  it.each([
    ["v1.2"],
    ["file.json"],
    ["..foo"],
    ["foo.."],
    ["a..b"],
    ["..."],
    [".hidden"],
    ["a/b.c/d"],
    ["a%2Fb"],
    ["x y"],
    ["café"],
    ["100%"],
  ])("lets %j through, as text", (value) => {
    expect(() => path.resolver({ id: value })).not.toThrow();
  });

  it("writes an allowed value into the path as before", () => {
    expect(path.resolver({ id: "v1.2/file.json" })).toBe("https://example.com/api/v1.2/file.json");
    expect(path.resolver({ id: "..foo" })).toBe("https://example.com/api/..foo");
  });

  it("keeps a %2F the caller wrote as literal text: the percent sign is escaped, so it is never a slash", () => {
    expect(path.resolver({ id: "a%2Fb" })).toBe("https://example.com/api/a%252Fb");
    expect(new URL(path.resolver({ id: "a%2Fb" })).pathname).toBe("/api/a%252Fb");
  });

  it("applies to every operator that takes the caller's value: required, optional and default", () => {
    expect(() => compileTemplate("https://example.com/a/{{x|default:safe}}").resolver({ x: ".." })).toThrow(/path segment/);
    expect(() => compileTemplate("https://example.com/a/{{x|optional}}").resolver({ x: ".." })).toThrow(/path segment/);
    expect(() => compileTemplate("https://example.com/a/{{x}}").resolver({ x: ".." })).toThrow(/path segment/);
  });

  it("does not judge what the publisher wrote: a default and a map value are the template's own", () => {
    expect(compileTemplate("https://example.com/a/{{x|default:..}}").resolver({})).toBe("https://example.com/a/..");
    expect(compileTemplate("https://example.com/a/{{x|map:up=..}}").resolver({ x: "up" })).toBe("https://example.com/a/..");
  });

  it("does not apply in a query position, where .. is just text", () => {
    expect(compileTemplate("https://example.com/search?q={{q}}").resolver({ q: ".." })).toBe("https://example.com/search?q=..");
    expect(compileTemplate("https://example.com/search?q={{q}}").resolver({ q: "../x" })).toBe("https://example.com/search?q=..%2Fx");
  });

  it("names the placeholder and never echoes the value", () => {
    let message = "";
    try {
      path.resolver({ id: "../../secret-token" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("{{id}}");
    expect(message).not.toContain("secret-token");
  });

  it("still lets a root template take any normal path (get_page)", () => {
    const root = compileTemplate("https://example.com{{path}}");
    expect(root.resolver({ path: "/about/team" })).toBe("https://example.com/about/team");
    expect(root.resolver({ path: "/blog/hello-world.html" })).toBe("https://example.com/blog/hello-world.html");
    expect(() => root.resolver({ path: "/../admin" })).toThrow(/path segment/);
    expect(() => root.resolver({ path: "/a/%2e%2e/b" })).toThrow(/path segment/);
  });
});

describe("the static path prefix of a template", () => {
  it.each([
    ["https://example.com/api/{{id}}", "/api/"],
    ["https://example.com/api/v1/{{a}}/{{b}}", "/api/v1/"],
    ["https://example.com/{{path}}", "/"],
    ["https://example.com{{path}}", "/"],
    ["https://example.com/api{{x}}", "/"],
    ["https://example.com/a/b/c-{{id}}", "/a/b/"],
    ["https://example.com/api/items?x={{q}}", "/api/items"],
    ["https://example.com/api/items/?x={{q}}&y={{r}}", "/api/items/"],
    ["https://example.com/a%20b/{{x}}", "/a%20b/"],
    ["https://example.com/wp-json/wp/v2/posts?slug={{slug}}", "/wp-json/wp/v2/posts"],
    ["https://{{host}}.example.com/x", "/"],
    ["https://exa{{x}}.com/x", "/"],
  ])("%s has the prefix %j", (template, prefix) => {
    expect(compileTemplate(template).pathPrefix).toBe(prefix);
  });

  it("has none for a template without a placeholder: there is nothing to contain", () => {
    expect(compileTemplate("https://example.com/static/page").pathPrefix).toBeNull();
  });

  it("is the prefix as the URL parser writes it, so it compares with the pathname that new URL produced", () => {
    expect(compileTemplate("https://example.com/a/./b/{{x}}").pathPrefix).toBe("/a/b/");
    expect(compileTemplate("https://example.com/a/c/../b/{{x}}").pathPrefix).toBe("/a/b/");
  });
});
