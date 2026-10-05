import { describe, expect, it } from "vitest";
import { canonicalJson, makeCacheKey } from "./cache";

describe("canonicalJson", () => {
  it("sorts object keys, recursively, and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: true, c: "x" } })).toBe('{"a":{"c":"x","d":true},"b":1}');
    expect(canonicalJson({ z: [{ y: 1, x: 2 }] })).toBe('{"z":[{"x":2,"y":1}]}');
  });

  it("is the same for any key order and any insertion order", () => {
    expect(canonicalJson({ a: "1", b: "2" })).toBe(canonicalJson({ b: "2", a: "1" }));
    const parsed = JSON.parse('{ "b" : "2" ,\n "a" : "1" }') as Record<string, unknown>;
    expect(canonicalJson(parsed)).toBe(canonicalJson({ a: "1", b: "2" }));
  });

  it("keeps the order of an array: it is data", () => {
    expect(canonicalJson({ tags: ["a", "b"] })).not.toBe(canonicalJson({ tags: ["b", "a"] }));
    expect(canonicalJson({ tags: [["b", "a"], 1] })).toBe('{"tags":[["b","a"],1]}');
  });

  it("tells values apart: a number from its string, true from \"true\", the empty array from absent", () => {
    expect(canonicalJson({ n: 1 })).not.toBe(canonicalJson({ n: "1" }));
    expect(canonicalJson({ b: true })).not.toBe(canonicalJson({ b: "true" }));
    expect(canonicalJson({ t: [] })).not.toBe(canonicalJson({}));
  });

  it("writes scalars as JSON does", () => {
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson({ s: 'quo"te\n', u: "é☃", n: 1.5, z: 0 })).toBe('{"n":1.5,"s":"quo\\"te\\n","u":"é☃","z":0}');
  });

  it("sorts by code unit, the same on every machine", () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4, "1": 5 })).toBe('{"1":5,"B":2,"_":4,"a":3,"b":1}');
  });

  it("does not let a __proto__ key it was handed set a prototype", () => {
    const hostile = JSON.parse('{"a":1,"__proto__":{"x":1}}') as Record<string, unknown>;
    const out = canonicalJson(hostile);
    expect(out).toBe('{"__proto__":{"x":1},"a":1}');
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });
});

describe("makeCacheKey", () => {
  const key = (scope: { version: string; configHash: string }, toolName: string, inputJson: string) =>
    makeCacheKey("example.com", scope, { toolName, inputJson });

  it("names the version, the config hash and the tool in the URL, then a hash of the input", async () => {
    const k = await key({ version: "0.6.0", configHash: "aaaa1111" }, "search_pages", "{}");
    expect(k.url).toMatch(/^https:\/\/example\.com\/__webmcp-cache\/0\.6\.0\/aaaa1111\/search_pages\/[0-9a-f]{64}$/);
  });

  it("differs with the version, the config hash, the tool and the input, and with nothing else", async () => {
    const scope = { version: "0.6.0", configHash: "aaaa1111" };
    const base = (await key(scope, "t", '{"a":1}')).url;
    expect((await key(scope, "t", '{"a":1}')).url).toBe(base);
    expect((await key({ ...scope, version: "0.6.1" }, "t", '{"a":1}')).url).not.toBe(base);
    expect((await key({ ...scope, configHash: "bbbb2222" }, "t", '{"a":1}')).url).not.toBe(base);
    expect((await key(scope, "u", '{"a":1}')).url).not.toBe(base);
    expect((await key(scope, "t", '{"a":2}')).url).not.toBe(base);
  });
});
