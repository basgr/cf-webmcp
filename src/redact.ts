/**
 * Keep the deploy token out of what the Worker answers.
 *
 * The Worker sends the CF_WEBMCP_DEPLOY_TOKEN secret to origin with every executor fetch and
 * every merge-route fetch (cf-webmcp-deploy-token). An origin endpoint that echoes request
 * headers (a debug page, a header-echo API, an error page that lists the request) would hand
 * it back, and the executors and the merge routes pass origin's text on. So everything those
 * two answer is searched for the token's value, and every occurrence is replaced:
 *
 *   - Executor output (redactEnvelope): the envelope, serialised the way the exec route sends
 *     it. Done on that final text, after any parse, so a token origin wrote with JSON escapes
 *     and the parse decoded is caught too.
 *   - Merge routes, headers (withoutSecretHeaders): origin's response as it arrives, before a
 *     route adds anything of its own (src/handler.ts, proxyToOrigin). Every header of origin's
 *     whose value holds the token is dropped. A header the Worker sets (Content-Type,
 *     Cache-Control, X-Robots-Tag, an ETag it computed, CORS) is never looked at, so it can
 *     never be dropped.
 *   - Merge routes, bodies (redactBody): the body a route answers, its own merged document or
 *     origin's answer relayed as it came, searched as it streams. A merged document is searched
 *     after the merge, so a token origin wrote with JSON escapes that a JSON merge decoded is
 *     caught too. The ARD manifest redacts its merged document itself (redactText), before it
 *     hashes it for the ETag: the tag must describe the bytes that are served.
 *
 * The token is an opaque string: what is replaced is its value as written, and, where it differs,
 * the form JSON.stringify writes inside a string (a quote, a backslash or a control character
 * escaped, the controls as \n, \t or \uXXXX). Nothing else is recognised: not the `\/` some JSON
 * writers put for a slash, not a \uXXXX escape of an ordinary character, not percent-encoding,
 * base64, HTML entities, a change of letter case, nor a URL the Worker writes again (a relayed
 * Location). A token of letters, digits, `_` and `-` (`openssl rand -hex 32`) has no character
 * any of these encodings change, so for such a token the value as written is every form there
 * is, except an encoder that escapes characters it need not (every character as \uXXXX, say).
 *
 * A token under MIN_REDACTED_LENGTH characters is not searched for at all: replacing so short a
 * string replaces it in ordinary text too, and drops every header that happens to contain it
 * (a one-letter token took Content-Type, Cache-Control and X-Robots-Tag off the merge routes).
 * The first time that happens in an isolate, a warning goes to the log. An empty token (the
 * secret is not set) is never searched for either, and nothing is logged: nothing is sent, so
 * nothing can come back.
 */

import { err, type Envelope } from "./envelope";

export const REDACTED = "[redacted]";

/** The shortest deploy token the Worker searches its answers for. */
export const MIN_REDACTED_LENGTH = 16;

/**
 * Logged once per isolate for a token under MIN_REDACTED_LENGTH characters. It names neither the
 * token nor its length.
 */
const SHORT_TOKEN_WARNING =
  `cf-webmcp: CF_WEBMCP_DEPLOY_TOKEN is shorter than ${MIN_REDACTED_LENGTH} characters, so the Worker does not ` +
  `take it out of tool output or merge-route answers (replacing so short a string would mangle ordinary text ` +
  `and headers). Set a token of at least 32 characters, such as the output of \`openssl rand -hex 32\`.`;

let warnedShort = false;

/** The token to search for: "" (search for nothing) when it is unset or too short to search for. */
function searchable(secret: string): string {
  if (secret.length >= MIN_REDACTED_LENGTH) return secret;
  if (secret !== "" && !warnedShort) {
    warnedShort = true;
    console.warn(SHORT_TOKEN_WARNING);
  }
  return "";
}

/** Test hook: forget that the short-token warning was logged. */
export function _resetForTests(): void {
  warnedShort = false;
}

/** The forms of the secret to look for, longest first: as written, and as `JSON.stringify` writes it. */
function needles(secret: string): string[] {
  if (secret === "") return [];
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [escaped, secret];
}

/** `text` with every occurrence of the secret, as written or JSON-escaped, replaced by REDACTED. */
export function redactText(text: string, secret: string): string {
  let out = text;
  for (const needle of needles(searchable(secret))) out = out.split(needle).join(REDACTED);
  return out;
}

/** Whether `value` holds the secret as written: the test for a header value of origin's. */
export function holdsSecret(value: string, secret: string): boolean {
  const s = searchable(secret);
  return s !== "" && value.includes(s);
}

/**
 * The envelope as the exec route sends it, with every occurrence of the secret replaced: in a
 * value, a key or an error message. The same object when there is nothing to replace. A secret
 * made of JSON syntax could break the text it is cut out of; then the answer is a fixed
 * `internal` error rather than anything that might still hold it.
 */
export function redactEnvelope<T>(envelope: Envelope<T>, secret: string): Envelope<T> {
  if (searchable(secret) === "") return envelope;
  const json = JSON.stringify(envelope);
  const redacted = redactText(json, secret);
  if (redacted === json) return envelope;
  try {
    return JSON.parse(redacted) as Envelope<T>;
  } catch {
    return err("internal", "the tool's answer could not be returned", false);
  }
}

/** Statuses whose response has no body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** A response that cannot be rebuilt: a WebSocket upgrade, or a status outside 200 to 599. */
function unbuildable(res: Response): boolean {
  return Boolean(res.webSocket) || res.status < 200 || res.status > 599;
}

/**
 * Origin's response with every header whose value holds the secret dropped; status, status text,
 * every other header and the body as they came (Content-Length included: the body is not touched
 * here, and the merge routes judge their 1 MiB cap by it). The same object when nothing is
 * dropped. For origin's response as it arrives, before the Worker adds a header of its own.
 */
export function withoutSecretHeaders(res: Response, secret: string): Response {
  const s = searchable(secret);
  if (s === "" || unbuildable(res)) return res;
  const holding = [...res.headers].filter(([, value]) => value.includes(s)).map(([name]) => name);
  if (holding.length === 0) return res;
  const headers = new Headers(res.headers);
  for (const name of holding) headers.delete(name);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * The response with the secret replaced in its body as it streams. Status, status text and every
 * header are kept, except Content-Length: the body can change length. Headers are not searched:
 * by the time a merge route answers, each one is either the Worker's own or one of origin's that
 * withoutSecretHeaders let through. The same object when there is no secret or no body.
 */
export function redactBody(res: Response, secret: string): Response {
  const s = searchable(secret);
  if (s === "" || unbuildable(res) || res.body === null || NULL_BODY_STATUSES.has(res.status)) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(res.body.pipeThrough(redactingStream(s)), { status: res.status, statusText: res.statusText, headers });
}

/**
 * A byte stream transform that replaces the secret, as written or JSON-escaped, wherever the
 * chunks split it. From the left, wherever a form starts, the longest form that starts there is
 * replaced and the scan goes on after it. It holds back at most the length of the longest form
 * minus one byte between chunks, the only bytes that could still begin an occurrence, and leaves
 * every other byte as it came (a body that is not UTF-8 included).
 *
 * Linear in the bytes it reads, whatever they hold: each form is found in its own pass with a
 * Knuth-Morris-Pratt automaton, which never looks at a byte twice, and outside a partial match
 * the pass jumps to the next byte that can begin the form (see occurrences). The search it
 * replaces was quadratic: for a token that starts with a quote, 1 MiB of quotes took minutes.
 */
export function redactingStream(secret: string): TransformStream<Uint8Array, Uint8Array> {
  const s = searchable(secret);
  // Nothing to search for: every byte passes as it came.
  if (s === "") return new TransformStream<Uint8Array, Uint8Array>();
  const encoder = new TextEncoder();
  // Longest first, as needles() orders them: at a position where both start, the longer wins.
  const forms = needles(s).map((n) => compilePattern(encoder.encode(n)));
  const replacement = encoder.encode(REDACTED);
  const longest = Math.max(...forms.map((f) => f.bytes.byteLength));
  let carry: Uint8Array = new Uint8Array(0);

  /** Replace what can be decided in `data`; return the output and the undecided tail. */
  const scan = (data: Uint8Array, final: boolean): { out: Uint8Array; rest: Uint8Array } => {
    // A form that starts before `stop` fits in `data`, so whether one starts there is decided.
    const stop = final ? data.byteLength : Math.max(0, data.byteLength - longest + 1);
    const found = forms.map((f) => occurrences(data, f));
    const next = forms.map(() => 0);
    const pieces: Uint8Array[] = [];
    let i = 0;
    for (;;) {
      // The leftmost occurrence at or after i; at equal starts the earlier (longer) form.
      let start = Number.POSITIVE_INFINITY;
      let which = -1;
      for (let f = 0; f < forms.length; f++) {
        const starts = found[f]!;
        let k = next[f]!;
        while (k < starts.length && starts[k]! < i) k++;
        next[f] = k;
        if (k < starts.length && starts[k]! < start) {
          start = starts[k]!;
          which = f;
        }
      }
      if (which === -1 || start >= stop) break;
      pieces.push(data.subarray(i, start), replacement);
      i = start + forms[which]!.bytes.byteLength;
    }
    // No form starts in [i, stop): those bytes are decided and go out as they came.
    const end = Math.max(i, stop);
    pieces.push(data.subarray(i, end));
    return { out: concat(pieces), rest: data.slice(end) };
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const { out, rest } = scan(concat([carry, chunk]), false);
      if (out.byteLength > 0) controller.enqueue(out);
      carry = rest;
    },
    flush(controller) {
      const { out } = scan(carry, true);
      if (out.byteLength > 0) controller.enqueue(out);
    },
  });
}

/** A byte pattern with its Knuth-Morris-Pratt failure table. */
interface Pattern {
  bytes: Uint8Array;
  /** fail[k]: the length of the longest proper prefix of bytes[0..k] that is also a suffix of it. */
  fail: Int32Array;
}

function compilePattern(bytes: Uint8Array): Pattern {
  const fail = new Int32Array(bytes.byteLength);
  let k = 0;
  for (let i = 1; i < bytes.byteLength; i++) {
    while (k > 0 && bytes[i] !== bytes[k]) k = fail[k - 1]!;
    if (bytes[i] === bytes[k]) k++;
    fail[i] = k;
  }
  return { bytes, fail };
}

/**
 * The start of every occurrence of `pattern` in `data`, overlapping ones included, in ascending
 * order. The automaton takes each byte once (its fallbacks are paid for by the bytes that
 * advanced it). Outside a partial match, the bytes before the next one that begins the pattern
 * change nothing, so the pass jumps there; each such search starts where the pass stands, after
 * the previous hit, so the searches read each byte at most once too.
 */
function occurrences(data: Uint8Array, pattern: Pattern): number[] {
  const { bytes, fail } = pattern;
  const m = bytes.byteLength;
  const n = data.byteLength;
  const first = bytes[0]!;
  const found: number[] = [];
  let k = 0;
  let i = 0;
  while (i < n) {
    if (k === 0) {
      i = data.indexOf(first, i);
      if (i === -1) break;
    }
    const b = data[i]!;
    while (k > 0 && bytes[k] !== b) k = fail[k - 1]!;
    if (bytes[k] === b) k++;
    if (k === m) {
      found.push(i - m + 1);
      k = fail[m - 1]!;
    }
    i++;
  }
  return found;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const nonEmpty = parts.filter((p) => p.byteLength > 0);
  if (nonEmpty.length === 1) return nonEmpty[0]!;
  const out = new Uint8Array(nonEmpty.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of nonEmpty) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}
