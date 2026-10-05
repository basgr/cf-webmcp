/**
 * The bounded read of origin's file that every merge route shares: the ARD manifest, llms.txt,
 * robots.txt, agents.md, the API catalog and SKILL.md in merge mode. They fetch a document of
 * origin's to splice their own block into it, and that document is origin's to size.
 *
 * A body is read up to MERGE_MAX_BYTES (1 MiB). Past that it is not ours to merge: the caller
 * relays origin's response, status, headers and every byte, with its own X-Robots-Tag policy.
 * A body that fails before the cap is a failed origin: the caller serves what it serves when
 * origin has no file, with ORIGIN_FAILURE_CACHE_CONTROL so origin's own file is back within
 * a minute once origin is. Without this a failing read throws out of the route, and the
 * platform's error page that answers carries no X-Robots-Tag. robots.txt is the exception: its
 * stand-in would drop origin's Disallow rules, so it answers 503 instead (src/routes/robots-txt.ts).
 */

/** Origin documents over this many bytes are relayed, not merged. */
export const MERGE_MAX_BYTES = 1024 * 1024;

/**
 * Cache-Control of the stand-in document a route serves when origin's body failed while it
 * was read, so that origin's own file is back within a minute once origin is.
 */
export const ORIGIN_FAILURE_CACHE_CONTROL = "public, max-age=60, s-maxage=60";

/** The Content-Length origin declared, or 0 when there is none or it is not a number. */
export function declaredLength(res: Response): number {
  const value = res.headers.get("content-length")?.trim() ?? "";
  return /^\d+$/.test(value) ? Number(value) : 0;
}

export type CappedRead = { kind: "bytes"; bytes: Uint8Array } | { kind: "too_large"; rest: ReadableStream<Uint8Array> };

/**
 * Read a body up to `limit` bytes. Past the limit, stop and hand back a stream
 * of the bytes read so far followed by the unread rest, so the body can still be
 * relayed whole. A failing stream throws.
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number): Promise<CappedRead> {
  if (!body) return { kind: "bytes", bytes: new Uint8Array(0) };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    chunks.push(next.value);
    total += next.value.byteLength;
    if (total > limit) {
      const rest = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c);
        },
        async pull(controller) {
          try {
            const more = await reader.read();
            if (more.done) controller.close();
            else controller.enqueue(more.value);
          } catch (e) {
            controller.error(e);
          }
        },
        cancel(reason) {
          return reader.cancel(reason);
        },
      });
      return { kind: "too_large", rest };
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { kind: "bytes", bytes };
}

/** What the text merge routes got from origin's 200: the text, a response to relay, or a failed read. */
export type BoundedText =
  | { kind: "text"; text: string }
  /** Over the cap: origin's response as it came (its own object when Content-Length said so, else a copy over the full stream). */
  | { kind: "relay"; upstream: Response }
  /** The body failed before the cap. */
  | { kind: "failed" };

/**
 * Read origin's 200 response as UTF-8 text, capped. A body whose Content-Length is over the cap
 * is relayed without reading a byte. Otherwise it is read up to the cap, and one over it comes
 * back as origin's status and headers around the bytes read plus the unread rest. Decoded like
 * Response.text(): UTF-8, a leading byte order mark dropped, bad sequences replaced.
 */
export async function readTextCapped(upstream: Response, limit: number = MERGE_MAX_BYTES): Promise<BoundedText> {
  if (declaredLength(upstream) > limit) return { kind: "relay", upstream };
  let read: CappedRead;
  try {
    read = await readCapped(upstream.body, limit);
  } catch {
    return { kind: "failed" };
  }
  if (read.kind === "too_large") {
    return {
      kind: "relay",
      upstream: new Response(read.rest, { status: upstream.status, statusText: upstream.statusText, headers: upstream.headers }),
    };
  }
  return { kind: "text", text: new TextDecoder().decode(read.bytes) };
}
