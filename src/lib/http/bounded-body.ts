/*
 * Reads a request body with a size cap, chunk by chunk, so an oversized body is never buffered in
 * full: the read stops at the first chunk past the cap. One home for the web routes (a fetch
 * `Request`) and the fake Resend API (a Node `IncomingMessage`, which is an async iterable of
 * Buffers).
 */

/**
 * The bytes of `chunks`, or null as soon as they pass `maxBytes`. Stopping early ends the source
 * through its iterator's `return`, which cancels a web stream and destroys a Node stream.
 */
export async function readBoundedChunks(chunks: AsyncIterable<Uint8Array>, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > maxBytes) return null;
    parts.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.byteLength;
  }
  return body;
}

// The DOM typings this project compiles with do not declare ReadableStream as async iterable, so
// the reader is walked by hand. An early `return` from the consumer runs `finally`, which cancels
// the stream rather than leave the rest of the upload unread.
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let done = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!done) await reader.cancel();
  }
}

/** A fetch `Request`'s body, or null when it is longer than `maxBytes`. No body reads as empty. */
export function readBoundedRequestBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return Promise.resolve(new Uint8Array());
  return readBoundedChunks(streamChunks(request.body), maxBytes);
}
