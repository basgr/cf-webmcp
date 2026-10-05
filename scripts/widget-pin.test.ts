import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LICENSE_PREAMBLE } from "../src/widget-preamble";
import { bridgeNpmVersion, composeWidget, computeServedFields, makePin, sha256Hex, widgetAssetName } from "./widget-pin";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Known-answer vector, computed once with `openssl dgst` over the bytes
// "P\n" + "abc". Pins the encodings (hex for sha256, base64 for the sha384 SRI)
// independently of the implementation under test.
const RAW = new TextEncoder().encode("abc");
const PREAMBLE = "P\n";
const VECTOR = {
  rawSha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  servedSha256: "132667c404b46cd7d9a6cdd4982bb9e438058d23ce1dba4c0f2bd005408e43a4",
  servedSri: "sha384-60l6Ekgm2JuXv/bhXNab8Y3BZMue9QxJNj6vKDsQNrLR4vjmidz3i01g0ZEGa361",
  preambleSha256: "852a478ece1b66d04d107ae488dd476a5a43b317f62729e25152e4bfba096cac",
};

describe("composeWidget", () => {
  it("is the utf-8 preamble bytes followed by the raw bytes, nothing else", () => {
    const composed = composeWidget(RAW, PREAMBLE);
    expect(new TextDecoder().decode(composed)).toBe("P\nabc");
    expect(composed.length).toBe(PREAMBLE.length + RAW.length);
  });

  it("keeps non-ascii raw bytes intact (no text round trip)", () => {
    const raw = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const composed = composeWidget(raw, PREAMBLE);
    expect(Array.from(composed.slice(2))).toEqual([0xff, 0xfe, 0x00, 0x80]);
  });
});

describe("computeServedFields", () => {
  it("matches the known-answer vector", () => {
    expect(computeServedFields(RAW, PREAMBLE)).toEqual({
      served_sha256: VECTOR.servedSha256,
      served_sri: VECTOR.servedSri,
      preamble_sha256: VECTOR.preambleSha256,
    });
  });

  it("emits served_sri as the complete sha384 base64 string, not hex", () => {
    const { served_sri } = computeServedFields(RAW, PREAMBLE);
    expect(served_sri).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
  });

  it("hashes the composed bytes, so a different preamble gives a different served hash", () => {
    const a = computeServedFields(RAW, "A\n");
    const b = computeServedFields(RAW, "B\n");
    expect(a.served_sha256).not.toBe(b.served_sha256);
    expect(a.served_sri).not.toBe(b.served_sri);
  });
});

describe("makePin", () => {
  it("records the raw sha256 plus the served fields, in a stable key order", () => {
    const pin = makePin("v9.9.9", RAW, PREAMBLE);
    expect(Object.keys(pin)).toEqual(["version", "sha256", "served_sha256", "served_sri", "preamble_sha256"]);
    expect(pin).toEqual({
      version: "v9.9.9",
      sha256: VECTOR.rawSha256,
      served_sha256: VECTOR.servedSha256,
      served_sri: VECTOR.servedSri,
      preamble_sha256: VECTOR.preambleSha256,
    });
  });
});

describe("widgetAssetName", () => {
  it("is widget.<first 16 hex of served_sha256>.js", () => {
    expect(widgetAssetName(VECTOR.servedSha256)).toBe("widget.132667c404b46cd7.js");
  });

  it("rejects a value that is not a 64-char lowercase hex digest", () => {
    expect(() => widgetAssetName("nope")).toThrow(/served_sha256/);
    expect(() => widgetAssetName(VECTOR.servedSha256.toUpperCase())).toThrow(/served_sha256/);
  });
});

describe("bridgeNpmVersion", () => {
  it("is the npm version of a release tag vX.Y.Z: the tag without its v", () => {
    expect(bridgeNpmVersion("v0.1.13")).toBe("0.1.13");
    expect(bridgeNpmVersion("v10.20.300")).toBe("10.20.300");
  });

  it.each(["0.1.13", "main", "v0.1", "v0.1.13-beta.1", "v0.1.13 ", " v0.1.13", "v0.1.13\n", "V0.1.13", "", "unpinned"])(
    "is null for %j, which is not a release tag",
    (version) => {
      expect(bridgeNpmVersion(version)).toBeNull();
    },
  );
});

describe("sha256Hex", () => {
  it("hashes strings as utf-8 and bytes as given", () => {
    expect(sha256Hex("abc")).toBe(VECTOR.rawSha256);
    expect(sha256Hex(RAW)).toBe(VECTOR.rawSha256);
  });
});

describe("committed vendor/webmcp/current.json", () => {
  async function readPin(): Promise<Record<string, unknown>> {
    return JSON.parse(await fs.readFile(path.join(ROOT, "vendor", "webmcp", "current.json"), "utf8"));
  }

  it("carries the served fields in the right shapes", async () => {
    const pin = await readPin();
    expect(pin["version"]).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(pin["sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(pin["served_sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(pin["served_sri"]).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    expect(pin["preamble_sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records the hash of the current LICENSE_PREAMBLE (edit the preamble, re-run update-widget)", async () => {
    const pin = await readPin();
    expect(pin["preamble_sha256"]).toBe(createHash("sha256").update(LICENSE_PREAMBLE, "utf8").digest("hex"));
  });
});
