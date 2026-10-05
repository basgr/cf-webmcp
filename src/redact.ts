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
 *   - Merge routes (redactResponse): the response a route hands back, its own merged document
 *     or origin's answer relayed as it came. Every header whose value holds the token is
 *     dropped, and the body is searched as it streams.
 *
 * The token is an opaque string: what is replaced is its value as written, and, where it differs,
 * the form JSON writes inside a string. An encoding beyond that (base64, percent-encoding, HTML
 * entities) is not recognised. An empty token (the secret is not set) is never searched for:
 * nothing is sent, so nothing can come back.
 */

import { err, type Envelope } from "./envelope";

export const REDACTED = "[redacted]";

/** The forms of the secret to look for, longest first: as written, and as JSON writes it in a string. */
function needles(secret: string): string[] {
  if (secret === "") return [];
  const escaped = JSON.stringify(secret).slice(1, -1);
  return escaped === secret ? [secret] : [escaped, secret];
}

/** `text` with every occurrence of the secret, as written or JSON-escaped, replaced by REDACTED. */
export function redactText(text: string, secret: string): string {
  let out = text;
  for (const needle of needles(secret)) out = out.split(needle).join(REDACTED);
  return out;
}

/**
 * The envelope as the exec route sends it, with every occurrence of the secret replaced: in a
 * value, a key or an error message. The same object when there is nothing to replace. A secret
 * made of JSON syntax could break the text it is cut out of; then the answer is a fixed
 * `internal` error rather than anything that might still hold it.
 */
export function redactEnvelope<T>(envelope: Envelope<T>, secret: string): Envelope<T> {
  if (secret === "") return envelope;
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

/**
 * The response with every header whose value holds the secret dropped and the secret replaced in
 * its body as it streams. Status, status text and every other header are kept, except
 * Content-Length: the body can change length. The same object when there is no secret.
 */
export function redactResponse(res: Response, secret: string): Response {
  if (secret === "" || res.webSocket || res.status < 200 || res.status > 599) return res;
  const headers = new Headers(res.headers);
  for (const [name, value] of res.headers) {
    if (value.includes(secret)) headers.delete(name);
  }
  const keepBody = res.body !== null && !NULL_BODY_STATUSES.has(res.status);
  if (keepBody) headers.delete("content-length");
  const body = keepBody ? res.body!.pipeThrough(redactingStream(secret)) : null;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * A byte stream transform that replaces the secret, as written or JSON-escaped, wherever the
 * chunks split it. It holds back at most the length of the longest form minus one byte between
 * chunks, the only bytes that could still begin an occurrence, and leaves every other byte as
 * it came (a body that is not UTF-8 included).
 */
export function redactingStream(secret: string): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const forms = needles(secret).map((n) => encoder.encode(n));
  const replacement = encoder.encode(REDACTED);
  const longest = Math.max(...forms.map((f) => f.byteLength));
  const firstBytes = [...new Set(forms.map((f) => f[0]!))];
  let carry: Uint8Array = new Uint8Array(0);

  /** Replace what can be decided in `data`; return the output and the undecided tail. */
  const scan = (data: Uint8Array, final: boolean): { out: Uint8Array; rest: Uint8Array } => {
    // Before `stop` every form fits, so a match (longest form first) is decided there.
    const stop = final ? data.byteLength : Math.max(0, data.byteLength - longest + 1);
    const pieces: Uint8Array[] = [];
    let last = 0;
    let i = 0;
    while (i < stop) {
      // Jump to the next byte that can begin a form; nothing before it can.
      let next = stop;
      for (const b of firstBytes) {
        const at = data.indexOf(b, i);
        if (at !== -1 && at < next) next = at;
      }
      i = next;
      if (i >= stop) break;
      let hit: Uint8Array | undefined;
      for (const f of forms) {
        if (startsWith(data, i, f)) {
          hit = f;
          break;
        }
      }
      if (hit === undefined) {
        i++;
        continue;
      }
      pieces.push(data.subarray(last, i), replacement);
      i += hit.byteLength;
      last = i;
    }
    const end = Math.max(i, last);
    pieces.push(data.subarray(last, end));
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

function startsWith(data: Uint8Array, at: number, form: Uint8Array): boolean {
  if (at + form.byteLength > data.byteLength) return false;
  for (let k = 0; k < form.byteLength; k++) if (data[at + k] !== form[k]) return false;
  return true;
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
