import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LICENSE_PREAMBLE } from "../src/widget-preamble";
import { objectKeyFor, readVendoredWidget, shellQuote, verifyComposedWidget, wranglerPutArgs } from "./upload-widget";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Independent computation of the pin for a fake widget, straight from node:crypto.
const RAW = new TextEncoder().encode("(function(){/* fake widget */})();\n");
const PREAMBLE = "/*! license */\n";
const COMPOSED = Buffer.concat([Buffer.from(PREAMBLE, "utf8"), Buffer.from(RAW)]);
const PIN = {
  version: "v0.0.1",
  sha256: createHash("sha256").update(RAW).digest("hex"),
  served_sha256: createHash("sha256").update(COMPOSED).digest("hex"),
  served_sri: `sha384-${createHash("sha384").update(COMPOSED).digest("base64")}`,
  preamble_sha256: createHash("sha256").update(PREAMBLE, "utf8").digest("hex"),
};

describe("verifyComposedWidget", () => {
  it("passes on a correct pair and returns the composed bytes to upload", () => {
    const composed = verifyComposedWidget(RAW, PREAMBLE, PIN);
    expect(Buffer.from(composed).equals(COMPOSED)).toBe(true);
  });

  it("throws when the raw file does not match the pinned sha256", () => {
    const tampered = new TextEncoder().encode("(function(){/* other widget */})();\n");
    expect(() => verifyComposedWidget(tampered, PREAMBLE, PIN)).toThrow(/sha256/);
    expect(() => verifyComposedWidget(tampered, PREAMBLE, PIN)).toThrow(/update-widget/);
  });

  it("throws when the composed bytes do not match served_sha256 (preamble drifted)", () => {
    expect(() => verifyComposedWidget(RAW, "/*! a different license */\n", PIN)).toThrow(/served_sha256/);
    expect(() => verifyComposedWidget(RAW, "/*! a different license */\n", PIN)).toThrow(/update-widget/);
  });

  it("throws when served_sri does not describe the composed bytes", () => {
    const badSri = { ...PIN, served_sri: `sha384-${"A".repeat(64)}` };
    expect(() => verifyComposedWidget(RAW, PREAMBLE, badSri)).toThrow(/served_sri/);
  });

  it("throws when the pin has no served fields (legacy two-field current.json)", () => {
    const legacy = { version: PIN.version, sha256: PIN.sha256 };
    expect(() => verifyComposedWidget(RAW, PREAMBLE, legacy)).toThrow(/update-widget/);
  });

  it("compares hashes case-insensitively for the hand-edited raw sha256", () => {
    const upper = { ...PIN, sha256: PIN.sha256.toUpperCase() };
    expect(() => verifyComposedWidget(RAW, PREAMBLE, upper)).not.toThrow();
  });
});

describe("objectKeyFor", () => {
  it("is widget.<first 16 hex of served_sha256>.js, from the pin alone", () => {
    expect(objectKeyFor(PIN)).toBe(`widget.${PIN.served_sha256.slice(0, 16)}.js`);
  });

  it("throws when the pin has no served_sha256", () => {
    expect(() => objectKeyFor({ version: "v0.0.1", sha256: PIN.sha256 })).toThrow(/update-widget/);
  });
});

describe("readVendoredWidget", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cf-webmcp-upload-"));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads the file bytes", async () => {
    const file = path.join(tmpDir, "webmcp.js");
    await fs.writeFile(file, RAW);
    expect(Buffer.from(await readVendoredWidget(file)).equals(Buffer.from(RAW))).toBe(true);
  });

  it("throws 'vendored widget missing, run update-widget' when the file is absent", async () => {
    await expect(readVendoredWidget(path.join(tmpDir, "missing.js"))).rejects.toThrow(
      /vendored widget missing, run update-widget/,
    );
  });
});

describe("wranglerPutArgs", () => {
  const base = { bucket: "my-bucket", key: "widget.0123456789abcdef.js", file: "/tmp/x.js" };

  it("targets remote storage explicitly (wrangler 4 defaults r2 object put to local)", () => {
    const args = wranglerPutArgs({ ...base, local: false });
    expect(args).toContain("--remote");
    expect(args).not.toContain("--local");
  });

  it("passes --local, and not --remote, for a wrangler dev upload", () => {
    const args = wranglerPutArgs({ ...base, local: true });
    expect(args).toContain("--local");
    expect(args).not.toContain("--remote");
  });

  it("uploads bucket/key from the given file as application/javascript", () => {
    const args = wranglerPutArgs({ ...base, local: false });
    expect(args.slice(0, 4)).toEqual(["r2", "object", "put", "my-bucket/widget.0123456789abcdef.js"]);
    expect(args[args.indexOf("--file") + 1]).toContain("/tmp/x.js");
    expect(args[args.indexOf("--content-type") + 1]).toBe("application/javascript");
  });
});

describe("shellQuote", () => {
  it("leaves plain bucket/key and path arguments untouched", () => {
    expect(shellQuote("my-bucket/widget.0123456789abcdef.js")).toBe("my-bucket/widget.0123456789abcdef.js");
    expect(shellQuote("C:\\Users\\bg\\AppData\\Local\\Temp\\x.js")).toBe("C:\\Users\\bg\\AppData\\Local\\Temp\\x.js");
    expect(shellQuote("--content-type")).toBe("--content-type");
  });

  it("double-quotes an argument with spaces and escapes embedded quotes", () => {
    expect(shellQuote("C:\\Users\\Jane Doe\\x.js")).toBe('"C:\\Users\\Jane Doe\\x.js"');
    expect(shellQuote('a"b c')).toBe('"a\\"b c"');
  });
});

describe("the committed pin against the vendored file (skipped when the file is not present, e.g. CI)", () => {
  const pinPath = path.join(ROOT, "vendor", "webmcp", "current.json");
  const pin = JSON.parse(readTextOrNull(pinPath) ?? "{}") as { version?: string };
  const vendored = pin.version ? path.join(ROOT, "vendor", "webmcp", pin.version, "webmcp.js") : "";

  it.skipIf(!vendored || !existsSync(vendored))("verifies against LICENSE_PREAMBLE", async () => {
    const committed = JSON.parse(await fs.readFile(pinPath, "utf8"));
    const raw = await fs.readFile(vendored);
    expect(() => verifyComposedWidget(raw, LICENSE_PREAMBLE, committed)).not.toThrow();
  });
});

function readTextOrNull(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
