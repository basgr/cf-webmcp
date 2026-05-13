import { describe, it, expect } from "vitest";
import { ok, err, jsonResponse } from "./envelope";

describe("envelope", () => {
  it("ok wraps data", () => {
    expect(ok({ x: 1 })).toEqual({ ok: true, data: { x: 1 } });
  });

  it("err uses defaults", () => {
    const e = err("internal", "oops");
    expect(e.ok).toBe(false);
    if (!e.ok) {
      expect(e.error.code).toBe("internal");
      expect(e.error.retriable).toBe(false);
    }
  });

  it("jsonResponse picks a default 400 for invalid_input", async () => {
    const r = jsonResponse(err("invalid_input", "bad"));
    expect(r.status).toBe(400);
    expect(r.headers.get("content-type")).toContain("application/json");
    expect(await r.json()).toEqual({ ok: false, error: { code: "invalid_input", message: "bad", retriable: false } });
  });

  it("jsonResponse picks 429 for rate_limited", () => {
    expect(jsonResponse(err("rate_limited", "x", true)).status).toBe(429);
  });

  it("jsonResponse picks 404 for not_found", () => {
    expect(jsonResponse(err("not_found", "x")).status).toBe(404);
  });

  it("jsonResponse picks 502 for origin_5xx", () => {
    expect(jsonResponse(err("origin_5xx", "x", true)).status).toBe(502);
  });
});
