import { describe, expect, it } from "vitest";
import { appendOriginTrialHeaders, decodeOriginTrialToken, ORIGIN_TRIAL_TOKEN_RE } from "./origin-trial";
import { encodeOriginTrialToken, expiryInDays, makeOriginTrialToken } from "./test-support/origin-trial";

/** A token that is `totalBytes` bytes long before base64 (header 69 bytes, rest JSON payload). */
function tokenOfBytes(totalBytes: number): string {
  const expiry = 2_000_000_000;
  const base = JSON.stringify({ origin: "https://example.com:443", feature: "WebMCP", expiry, usage: "" }).length;
  return makeOriginTrialToken({ expiry, usage: "x".repeat(totalBytes - 69 - base) });
}

/** A valid token whose base64 ends in "=" (its byte length is not a multiple of 3). */
function paddedToken(): string {
  for (let n = 0; n < 3; n++) {
    const token = makeOriginTrialToken({ usage: "x".repeat(n) });
    if (token.endsWith("=")) return token;
  }
  throw new Error("no padded token");
}

/** A valid token without any "=" padding, so two of them back to back are still base64. */
function unpaddedToken(): string {
  for (let n = 0; n < 3; n++) {
    const token = makeOriginTrialToken({ usage: "x".repeat(n) });
    if (!token.endsWith("=")) return token;
  }
  throw new Error("no unpadded token");
}

describe("decodeOriginTrialToken", () => {
  it("decodes a hand-built version 3 token", () => {
    const expiry = expiryInDays(90);
    const token = encodeOriginTrialToken(
      JSON.stringify({
        origin: "https://example.com:443",
        feature: "WebMCP",
        expiry,
        isSubdomain: true,
        isThirdParty: false,
        usage: "subset",
      }),
    );

    const decoded = decodeOriginTrialToken(token);

    expect(decoded.version).toBe(3);
    expect(decoded.payload.origin).toBe("https://example.com:443");
    expect(decoded.payload.feature).toBe("WebMCP");
    expect(decoded.payload.expiry).toBe(expiry);
    expect(decoded.payload.isSubdomain).toBe(true);
    expect(decoded.payload.isThirdParty).toBe(false);
  });

  it("decodes a version 2 token and leaves the optional flags undefined", () => {
    const token = makeOriginTrialToken({}, { version: 2 });
    const decoded = decodeOriginTrialToken(token);
    expect(decoded.version).toBe(2);
    expect(decoded.payload.isSubdomain).toBeUndefined();
    expect(decoded.payload.isThirdParty).toBeUndefined();
  });

  it("reads a payload with non-ASCII characters as UTF-8", () => {
    const token = makeOriginTrialToken({ feature: "Feature-\u00e4\u00f6\u00fc" });
    expect(decodeOriginTrialToken(token).payload.feature).toBe("Feature-\u00e4\u00f6\u00fc");
  });

  it("still reports isThirdParty on a version 2 token (the build decides what it means)", () => {
    const token = makeOriginTrialToken({ isThirdParty: true }, { version: 2 });
    expect(decodeOriginTrialToken(token).payload.isThirdParty).toBe(true);
  });

  it("accepts an expiry of 2147483647, the largest Chrome reads", () => {
    const token = makeOriginTrialToken({ expiry: 2_147_483_647 });
    expect(decodeOriginTrialToken(token).payload.expiry).toBe(2_147_483_647);
  });

  it("accepts a token of exactly 6144 characters, the most Chrome parses", () => {
    const token = tokenOfBytes(4608);
    expect(token).toHaveLength(6144);
    expect(decodeOriginTrialToken(token).payload.feature).toBe("WebMCP");
  });

  it("produces tokens the config schema pattern accepts", () => {
    expect(ORIGIN_TRIAL_TOKEN_RE.test(makeOriginTrialToken())).toBe(true);
  });

  describe("rejects malformed input", () => {
    it("a string that is not base64", () => {
      expect(() => decodeOriginTrialToken("not base64 at all!")).toThrow(/not valid base64/);
    });

    it("an empty string", () => {
      expect(() => decodeOriginTrialToken("")).toThrow(/not valid base64/);
    });

    it("a token shorter than the fixed header", () => {
      expect(() => decodeOriginTrialToken(btoa("\u0003short"))).toThrow(/too short/);
    });

    it.each([0, 1, 4, 255])("version %i", (version) => {
      const token = makeOriginTrialToken({}, { version });
      expect(() => decodeOriginTrialToken(token)).toThrow(new RegExp(`unsupported version ${version}`));
    });

    it("a declared payload length beyond the buffer", () => {
      const token = makeOriginTrialToken({}, { declaredLength: 100_000 });
      expect(() => decodeOriginTrialToken(token)).toThrow(/payload length/);
    });

    // Chrome (TrialToken::Extract) wants the declared length to equal exactly the bytes after the
    // header; anything after the payload makes the token malformed and the trial silently off.
    it("bytes after the payload", () => {
      const token = makeOriginTrialToken({}, { trailing: new Uint8Array([1, 2, 3]) });
      expect(() => decodeOriginTrialToken(token)).toThrow(/payload length/);
    });

    it("a declared payload length shorter than what follows the header", () => {
      const payload = JSON.stringify({ origin: "https://example.com:443", feature: "WebMCP", expiry: expiryInDays(30) });
      const token = encodeOriginTrialToken(payload, { declaredLength: payload.length - 1 });
      expect(() => decodeOriginTrialToken(token)).toThrow(/payload length/);
    });

    it("two tokens pasted together with no separator", () => {
      // Token one must carry no "=" padding for the pair to be base64 at all.
      const one = unpaddedToken();
      const two = makeOriginTrialToken({ feature: "Other" });
      expect(() => decodeOriginTrialToken(one + two)).toThrow(/payload length/);
    });

    it("two tokens pasted together where the first is padded", () => {
      const one = paddedToken();
      const two = makeOriginTrialToken({ feature: "Other" });
      expect(() => decodeOriginTrialToken(one + two)).toThrow(/not valid base64/);
    });

    it("a padded token with its = stripped", () => {
      const stripped = paddedToken().replace(/=+$/, "");
      expect(() => decodeOriginTrialToken(stripped)).toThrow(/base64 padding missing or wrong length/);
    });

    it("a token of 6145 characters", () => {
      expect(() => decodeOriginTrialToken("A".repeat(6145))).toThrow(/too long/);
    });

    it("a well-formed token of 6148 characters", () => {
      const token = tokenOfBytes(4611);
      expect(token).toHaveLength(6148);
      expect(() => decodeOriginTrialToken(token)).toThrow(/too long/);
    });

    it("a 7140-character token", () => {
      expect(() => decodeOriginTrialToken(tokenOfBytes(5354))).toThrow(/too long/);
    });

    it.each([
      ["unpadded", () => paddedToken().replace(/=+$/, "")],
      ["6145 characters", () => "A".repeat(6145)],
      ["trailing bytes", () => makeOriginTrialToken({}, { trailing: new Uint8Array([9]) })],
      ["two tokens", () => unpaddedToken() + unpaddedToken()],
    ])("messages for a token that is %s show at most the prefix", (_label, make) => {
      const token = make();
      let message = "";
      try {
        decodeOriginTrialToken(token);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(token.slice(0, 12));
      expect(message).toContain(`${token.slice(0, 8)}...`);
    });

    it("a payload that is not valid UTF-8", () => {
      const token = encodeOriginTrialToken(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
      expect(() => decodeOriginTrialToken(token)).toThrow(/UTF-8/);
    });

    it("a payload that is not JSON", () => {
      expect(() => decodeOriginTrialToken(encodeOriginTrialToken("{origin: nope"))).toThrow(/JSON/);
    });

    it.each(["[]", "null", "42", '"text"'])("a JSON payload that is not an object (%s)", (json) => {
      expect(() => decodeOriginTrialToken(encodeOriginTrialToken(json))).toThrow(/JSON object/);
    });

    it.each([
      ["missing", undefined],
      ["not a string", 7],
      ["not a URL", "example.com"],
      ["not http(s)", "ftp://example.com:21"],
      ["an opaque scheme", "data:text/plain,x"],
    ])("an origin that is %s", (_label, origin) => {
      const token = encodeOriginTrialToken(
        JSON.stringify({ origin, feature: "WebMCP", expiry: expiryInDays(30) }),
      );
      expect(() => decodeOriginTrialToken(token)).toThrow(/payload\.origin/);
    });

    it.each([
      ["missing", undefined],
      ["empty", ""],
      ["not a string", 5],
    ])("a feature that is %s", (_label, feature) => {
      const token = encodeOriginTrialToken(
        JSON.stringify({ origin: "https://example.com:443", feature, expiry: expiryInDays(30) }),
      );
      expect(() => decodeOriginTrialToken(token)).toThrow(/payload\.feature/);
    });

    it.each([
      ["missing", undefined],
      ["a string", "1790000000"],
      ["null", null],
      ["beyond the Date range", 1e300],
      // Chrome reads expiry with FindInt and wants it positive: a whole number of seconds, 1 to 2147483647.
      ["fractional", 1_790_000_000.5],
      ["beyond 32 bits (3e9)", 3_000_000_000],
      ["just beyond 32 bits", 2_147_483_648],
      ["zero", 0],
      ["negative", -5],
    ])("an expiry that is %s", (_label, expiry) => {
      const token = encodeOriginTrialToken(
        JSON.stringify({ origin: "https://example.com:443", feature: "WebMCP", expiry }),
      );
      expect(() => decodeOriginTrialToken(token)).toThrow(/payload\.expiry/);
    });

    it.each([
      ["isSubdomain", "yes"],
      ["isThirdParty", 1],
    ])("%s that is not a boolean", (key, value) => {
      const token = encodeOriginTrialToken(
        JSON.stringify({ origin: "https://example.com:443", feature: "WebMCP", expiry: expiryInDays(30), [key]: value }),
      );
      expect(() => decodeOriginTrialToken(token)).toThrow(new RegExp(`payload\\.${key}`));
    });
  });

  describe("error messages", () => {
    it("never echo the whole token, only a short prefix", () => {
      const token = makeOriginTrialToken({}, { version: 9 });
      let message = "";
      try {
        decodeOriginTrialToken(token);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(token);
      expect(message).toContain(`${token.slice(0, 8)}...`);
      expect(message).not.toContain(token.slice(0, 12));
    });

    it("do not echo a short invalid token in full", () => {
      let message = "";
      try {
        decodeOriginTrialToken("abc!");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toContain("abc!");
    });
  });
});

describe("appendOriginTrialHeaders", () => {
  it("appends one Origin-Trial header per token", () => {
    const headers = new Headers();
    appendOriginTrialHeaders(headers, ["tokenAAA", "tokenBBB"]);
    expect(headers.get("origin-trial")).toBe("tokenAAA, tokenBBB");
  });

  it("does nothing for an empty token list", () => {
    const headers = new Headers({ "content-type": "text/html" });
    appendOriginTrialHeaders(headers, []);
    expect(headers.has("origin-trial")).toBe(false);
  });

  it("keeps a value the origin already sent and appends ours", () => {
    const headers = new Headers({ "origin-trial": "originToken" });
    appendOriginTrialHeaders(headers, ["ourToken"]);
    expect(headers.get("origin-trial")).toBe("originToken, ourToken");
  });

  it("does not repeat a token the origin sent as a quoted string", () => {
    const headers = new Headers({ "origin-trial": '"tokenAAA"' });
    appendOriginTrialHeaders(headers, ["tokenAAA", "tokenBBB"]);
    expect(headers.get("origin-trial")).toBe('"tokenAAA", tokenBBB');
  });

  it("sees through quotes and spaces inside a comma-separated list", () => {
    const headers = new Headers({ "origin-trial": '"tokenAAA" ,  "tokenBBB"  , tokenCCC' });
    appendOriginTrialHeaders(headers, ["tokenAAA", "tokenBBB", "tokenCCC", "tokenDDD"]);
    const value = headers.get("origin-trial")!;
    for (const t of ["tokenAAA", "tokenBBB", "tokenCCC"]) expect(value.split(t), t).toHaveLength(2);
    expect(value.endsWith(", tokenDDD")).toBe(true);
  });

  it("does not duplicate a token that is already present", () => {
    const headers = new Headers();
    headers.append("origin-trial", "tokenAAA");
    headers.append("origin-trial", "tokenBBB, tokenCCC");
    appendOriginTrialHeaders(headers, ["tokenBBB", "tokenDDD", "tokenDDD"]);
    expect(headers.get("origin-trial")).toBe("tokenAAA, tokenBBB, tokenCCC, tokenDDD");
  });
});
