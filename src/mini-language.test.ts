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

  it("forbids optional in path position, when the template is compiled", () => {
    expect(() => compileTemplate("https://example.com/{{slug|optional}}/x")).toThrow(/\{\{slug\|optional\}\} sits in the path/);
  });
});

describe("an |optional placeholder must be the whole value of its query parameter", () => {
  // Dropping the parameter takes everything between its `?` or `&` and the next `&` with it, so
  // anything else in that parameter would go too, and the old resolver cut it out with offsets
  // taken from the template after an earlier splice had moved the text (a caller's "-admin" ended
  // up in the path).
  it.each([
    ["shares its parameter with a required placeholder before it", "https://example.com/api?q={{a}}{{b|optional}}"],
    ["shares its parameter with text and a later parameter", "https://example.com/api?q={{a}}-{{b|optional}}&z=1"],
    ["shares its parameter with a required placeholder after it", "https://example.com/api?q={{b|optional}}{{a}}"],
    ["has fixed text after it in its parameter", "https://example.com/api?q={{b|optional}}x"],
    ["has fixed text in front of it in its value", "https://example.com/api?q=x{{b|optional}}"],
    ["is a value after a second =", "https://example.com/api?q=a={{b|optional}}"],
    ["has no key", "https://example.com/api?{{b|optional}}"],
    ["has an empty key", "https://example.com/api?={{b|optional}}"],
    ["has a placeholder for a key", "https://example.com/api?{{k}}={{b|optional}}"],
  ])("refuses one that %s, naming the placeholder", (_label, template) => {
    expect(() => compileTemplate(template)).toThrow(/\{\{b\|optional\}\} must be the whole value of its query parameter/);
  });

  it("refuses one in the fragment", () => {
    expect(() => compileTemplate("https://example.com/api?x=1#{{b|optional}}")).toThrow(/\{\{b\|optional\}\} sits in the fragment/);
    expect(() => compileTemplate("https://example.com/api#k={{b|optional}}")).toThrow(/\{\{b\|optional\}\} sits in the fragment/);
  });

  it("refuses one in the path, also after another placeholder", () => {
    expect(() => compileTemplate("https://example.com/api/{{a}}/{{b|optional}}?q=1")).toThrow(/\{\{b\|optional\}\} sits in the path/);
  });

  it("never echoes the rest of the template's query beyond the parameter", () => {
    let message = "";
    try {
      compileTemplate("https://example.com/api?q={{a}}{{b|optional}}&secret=1");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('"q={{a}}{{b|optional}}"');
    expect(message).not.toContain("secret");
  });

  const three = compileTemplate("https://example.com/p?a={{a|optional}}&b={{b|optional}}&c={{c|optional}}");
  it.each([
    [{}, "https://example.com/p"],
    [{ a: "1" }, "https://example.com/p?a=1"],
    [{ b: "2" }, "https://example.com/p?b=2"],
    [{ c: "3" }, "https://example.com/p?c=3"],
    [{ a: "1", b: "2" }, "https://example.com/p?a=1&b=2"],
    [{ a: "1", c: "3" }, "https://example.com/p?a=1&c=3"],
    [{ b: "2", c: "3" }, "https://example.com/p?b=2&c=3"],
    [{ a: "1", b: "2", c: "3" }, "https://example.com/p?a=1&b=2&c=3"],
    [{ a: "", b: null, c: "3" }, "https://example.com/p?c=3"],
  ])("three optional parameters, %j, resolve to %s", (input, expected) => {
    expect(three.resolver(input)).toBe(expected);
  });

  const mixed = compileTemplate("https://example.com/p/{{id}}?x=1&a={{a|optional}}&q={{q}}&b={{b|optional}}&n={{n|default:5}}#top");
  it.each([
    [{ id: "7", q: "-admin" }, "https://example.com/p/7?x=1&q=-admin&n=5#top"],
    [{ id: "7", q: "s", a: "a b" }, "https://example.com/p/7?x=1&a=a%20b&q=s&n=5#top"],
    [{ id: "7", q: "s", b: "&z=1" }, "https://example.com/p/7?x=1&q=s&b=%26z%3D1&n=5#top"],
    [{ id: "7", q: "s", a: "1", b: "2", n: 9 }, "https://example.com/p/7?x=1&a=1&q=s&b=2&n=9#top"],
  ])("optional parameters between fixed and required ones, %j, resolve to %s", (input, expected) => {
    expect(mixed.resolver(input)).toBe(expected);
  });

  it("keeps the fragment when it drops the last parameter", () => {
    const c = compileTemplate("https://example.com/p?a={{a|optional}}#top");
    expect(c.resolver({})).toBe("https://example.com/p#top");
    expect(c.resolver({ a: "1" })).toBe("https://example.com/p?a=1#top");
  });

  it("keeps the template's empty parameters as written", () => {
    expect(compileTemplate("https://example.com/p?a={{a|optional}}&").resolver({})).toBe("https://example.com/p?");
    expect(compileTemplate("https://example.com/p?&a={{a|optional}}").resolver({})).toBe("https://example.com/p?");
    expect(compileTemplate("https://example.com/p?x=1&&a={{a|optional}}").resolver({})).toBe("https://example.com/p?x=1&");
  });

  it("splits parameters on the template's own &, never on one inside a default", () => {
    const c = compileTemplate("https://example.com/p?d={{d|default:x&y}}&a={{a|optional}}");
    expect(c.resolver({})).toBe("https://example.com/p?d=x%26y");
    expect(c.resolver({ a: "1" })).toBe("https://example.com/p?d=x%26y&a=1");
  });

  it("never lets a caller's value reach the path, whichever parameters are dropped", () => {
    const c = compileTemplate("https://example.com/api?a={{a|optional}}&q={{q}}&b={{b|optional}}");
    for (const input of [{ q: "-admin" }, { q: "-admin", a: "x" }, { q: "-admin", b: "x" }, { q: "/../admin" }]) {
      expect(new URL(c.resolver(input)).pathname, JSON.stringify(input)).toBe("/api");
    }
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

  it("applies to every operator that takes the caller's value in a path: required and default (optional cannot sit there)", () => {
    expect(() => compileTemplate("https://example.com/a/{{x|default:safe}}").resolver({ x: ".." })).toThrow(/path segment/);
    expect(() => compileTemplate("https://example.com/a/{{x}}").resolver({ x: ".." })).toThrow(/path segment/);
    expect(() => compileTemplate("https://example.com/a/{{x|optional}}")).toThrow(/sits in the path/);
  });

  it("does not judge what the publisher wrote: a default and a map value are the template's own", () => {
    expect(compileTemplate("https://example.com/a/{{x|default:..}}").resolver({})).toBe("https://example.com/a/..");
    expect(compileTemplate("https://example.com/a/{{x|map:up=..}}").resolver({ x: "up" })).toBe("https://example.com/a/..");
  });

  it("does not apply in a query position, where .. is just text", () => {
    expect(compileTemplate("https://example.com/search?q={{q}}").resolver({ q: ".." })).toBe("https://example.com/search?q=..");
    expect(compileTemplate("https://example.com/search?q={{q}}").resolver({ q: "../x" })).toBe("https://example.com/search?q=..%2Fx");
  });

  it.each([
    ["a ? in a default", "https://example.com/api/{{a|default:v?1}}/{{b}}", {}, "https://example.com/api/v%3F1/x/y"],
    ["a # in a default", "https://example.com/api/{{a|default:v#1}}/{{b}}", {}, "https://example.com/api/v%231/x/y"],
    ["a ? in a map value", "https://example.com/api/{{a|map:k=v?1}}/{{b}}", { a: "k" }, "https://example.com/api/v%3F1/x/y"],
  ])("finds the query by the template's own text, never by %s of an earlier placeholder", (_label, template, input, resolved) => {
    // Such a ? made every later placeholder a query value: `..` went through unchecked, and only
    // the path-prefix check stood between it and the parent path.
    const compiled = compileTemplate(template);
    expect(compiled.slots.map((s) => s.isQuery)).toEqual([false, false]);
    expect(() => compiled.resolver({ ...input, b: ".." })).toThrow(/\{\{b\}\} in a path position must not contain a "\." or "\.\." path segment/);
    expect(compiled.resolver({ ...input, b: "x/y" })).toBe(resolved);
  });

  it("still reads a placeholder after the template's own ? or # as a query (or fragment) value", () => {
    const query = compileTemplate("https://example.com/api/{{a|default:v?1}}?q={{b}}");
    expect(query.slots.map((s) => s.isQuery)).toEqual([false, true]);
    expect(query.resolver({ b: "../x" })).toBe("https://example.com/api/v%3F1?q=..%2Fx");
    const fragment = compileTemplate("https://example.com/page#{{frag}}");
    expect(fragment.slots.map((s) => s.isQuery)).toEqual([true]);
    expect(fragment.resolver({ frag: "a/b" })).toBe("https://example.com/page#a%2Fb");
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

  it.each([
    ["https://example.com/api/items?x={{q}}", true],
    ["https://example.com/api?q={{a}}&b={{b|optional}}", true],
    ["https://example.com/page#{{frag}}", true],
    ["https://example.com?q={{q}}", true],
    ["https://example.com/api/{{id}}?q={{q}}", false],
    ["https://example.com{{path}}", false],
    ["https://{{host}}.example.com/x?q={{q}}", false],
    ["https://example.com/static/page", false],
  ])("%s fixes the whole path: %s", (template, exact) => {
    // No placeholder before the query means no caller value reaches the path: the resolved
    // pathname must then equal the prefix, so /api can never pass for /api-admin.
    expect(compileTemplate(template).pathExact).toBe(exact);
  });

  it("is the prefix as the URL parser writes it, so it compares with the pathname that new URL produced", () => {
    expect(compileTemplate("https://example.com/a/./b/{{x}}").pathPrefix).toBe("/a/b/");
    expect(compileTemplate("https://example.com/a/c/../b/{{x}}").pathPrefix).toBe("/a/b/");
  });
});
