import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LICENSE_PREAMBLE } from "../src/widget-preamble";
import {
  checkBucketName,
  checkShellSafePath,
  objectKeyFor,
  readVendoredWidget,
  shellQuote,
  validateUploadInputs,
  verifyComposedWidget,
  wranglerConfigPath,
  wranglerPutArgs,
} from "./upload-widget";

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

describe("wranglerConfigPath", () => {
  const root = path.join(os.tmpdir(), "repo");

  it("uses wrangler.dev.toml for --local, the config `npm run dev:worker` starts wrangler dev with", () => {
    expect(wranglerConfigPath({ local: true, root, env: {} })).toBe(path.join(root, "wrangler.dev.toml"));
  });

  it("uses wrangler.toml for a deploy upload", () => {
    expect(wranglerConfigPath({ local: false, root, env: {} })).toBe(path.join(root, "wrangler.toml"));
  });

  it("lets CF_WEBMCP_WRANGLER_CONFIG override both, relative to the repo root", () => {
    const env = { CF_WEBMCP_WRANGLER_CONFIG: "deploy/wrangler.prod.toml" };
    expect(wranglerConfigPath({ local: true, root, env })).toBe(path.join(root, "deploy", "wrangler.prod.toml"));
    expect(wranglerConfigPath({ local: false, root, env })).toBe(path.join(root, "deploy", "wrangler.prod.toml"));
  });
});

describe("wranglerPutArgs", () => {
  const base = { bucket: "my-bucket", key: "widget.0123456789abcdef.js", file: "/tmp/x.js", config: "/repo/wrangler.dev.toml" };

  it("hands wrangler the config the bucket name was read from, so both name the same storage", () => {
    for (const local of [true, false]) {
      const args = wranglerPutArgs({ ...base, local });
      expect(args[args.indexOf("--config") + 1]).toBe("/repo/wrangler.dev.toml");
    }
  });

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

// The wrangler command runs through a shell (wrangler.cmd on Windows needs one), and quoting does
// not stop $(...), backticks or %VAR%. So the inputs that reach the command line are checked
// strictly instead: the bucket name against the R2 naming rule, the paths for shell metacharacters.
describe("checkBucketName: the R2 naming rule", () => {
  it.each(["my-bucket", "abc", "a1b", "cf-webmcp-assets", "0bucket9", "a".repeat(63)])("accepts %j", (name) => {
    expect(checkBucketName(name)).toBe(name);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(64)],
    ["upper case", "My-Bucket"],
    ["a leading hyphen", "-abc"],
    ["a trailing hyphen", "abc-"],
    ["an underscore", "a_b"],
    ["a dot", "a.b"],
    ["a space", "my bucket"],
    ["a command substitution", "$(touch x)"],
    ["a backtick", "a`id`b"],
    ["a cmd variable", "%PATH%"],
    ["a semicolon", "abc;rm"],
    ["an ampersand", "abc&calc"],
    ["a pipe", "abc|x"],
    ["a newline", "abc\ndef"],
    ["a slash", "abc/def"],
  ])("refuses %s, naming the rule", (_label, name) => {
    expect(() => checkBucketName(name)).toThrow(/\[upload-widget\] bucket name .* is not a valid R2 bucket name/);
  });
});

describe("checkShellSafePath: no shell metacharacters in a path on the command line", () => {
  it.each([
    "C:\\Users\\bg\\github-local\\webmcp\\wrangler.toml",
    "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\cf-webmcp-widget-abc",
    "/home/user/repo/wrangler.dev.toml",
    "/tmp/cf-webmcp-widget-x1y2",
    "C:\\Program Files (x86)\\x\\wrangler.toml",
  ])("accepts %j", (p) => {
    expect(checkShellSafePath("the wrangler config path", p)).toBe(p);
  });

  it.each([
    ["$", "/repo/$(touch pwned)/wrangler.toml"],
    ["a backtick", "/repo/`id`/wrangler.toml"],
    ["%", "C:\\%USERPROFILE%\\wrangler.toml"],
    ['"', 'C:\\a"b\\wrangler.toml'],
    ["'", "/repo/o'brien/wrangler.toml"],
    [";", "/repo;rm -rf x/wrangler.toml"],
    ["&", "C:\\a&calc\\wrangler.toml"],
    ["|", "/repo|x/wrangler.toml"],
    ["<", "/repo/<x/wrangler.toml"],
    [">", "/repo/>x/wrangler.toml"],
    ["a newline", "/repo/a\nb/wrangler.toml"],
    ["a carriage return", "/repo/a\rb/wrangler.toml"],
  ])("refuses a path with %s, naming what it is and the character", (_label, p) => {
    expect(() => checkShellSafePath("the wrangler config path", p)).toThrow(/\[upload-widget\] the wrangler config path .* contains a character the shell would interpret/);
  });
});

describe("validateUploadInputs", () => {
  const ok = { bucket: "cf-webmcp-assets", config: "/repo/wrangler.toml", tmpDir: "/tmp/cf-webmcp-widget-x" };

  it("passes inputs that are all safe", () => {
    expect(() => validateUploadInputs(ok)).not.toThrow();
  });

  it("refuses an unsafe bucket, config path or temp directory", () => {
    expect(() => validateUploadInputs({ ...ok, bucket: "$(id)" })).toThrow(/bucket name/);
    expect(() => validateUploadInputs({ ...ok, config: "/repo/`id`/wrangler.toml" })).toThrow(/wrangler config path/);
    expect(() => validateUploadInputs({ ...ok, tmpDir: "C:\\%TEMP%\\x" })).toThrow(/temporary directory/);
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
