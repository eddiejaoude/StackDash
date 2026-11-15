import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { readBoundedChunks, readBoundedRequestBody } from "./bounded-body";

const encoder = new TextEncoder();
const LIMIT = 8;

/** A request whose body arrives in the given chunks, and whether the stream was cancelled. */
function chunkedRequest(chunks: readonly string[]): { request: Request; cancelled: () => boolean } {
  let cancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) controller.close();
      else controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      cancelled = true;
    },
  });
  // Node needs `duplex: "half"` for a stream body; the DOM typings do not declare it yet, so the
  // init is built first and passed as a RequestInit with that one extra field.
  const init = { method: "POST", body, duplex: "half" };
  return { request: new Request("http://localhost/", init), cancelled: () => cancelled };
}

const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));

describe("readBoundedRequestBody", () => {
  it("joins a body sent in several chunks", async () => {
    const { request } = chunkedRequest(["ab", "cd", "e"]);
    expect(text(await readBoundedRequestBody(request, LIMIT))).toBe("abcde");
  });

  it("reads a request without a body as empty", async () => {
    const bytes = await readBoundedRequestBody(new Request("http://localhost/", { method: "POST" }), LIMIT);
    expect(bytes?.byteLength).toBe(0);
  });

  it("accepts a body of exactly the cap", async () => {
    const { request, cancelled } = chunkedRequest(["abcd", "efgh"]);
    expect(text(await readBoundedRequestBody(request, LIMIT))).toBe("abcdefgh");
    expect(cancelled()).toBe(false);
  });

  it("refuses a body one byte over the cap and cancels the rest of the upload", async () => {
    const { request, cancelled } = chunkedRequest(["abcd", "efgh", "i", "never read"]);
    expect(await readBoundedRequestBody(request, LIMIT)).toBeNull();
    expect(cancelled()).toBe(true);
  });
});

describe("readBoundedChunks (a Node request stream)", () => {
  it("joins Buffer chunks", async () => {
    expect(text(await readBoundedChunks(Readable.from([Buffer.from("ab"), Buffer.from("cd")]), LIMIT))).toBe("abcd");
  });

  it("accepts exactly the cap and refuses one byte over, destroying the stream", async () => {
    expect(text(await readBoundedChunks(Readable.from([Buffer.from("abcdefgh")]), LIMIT))).toBe("abcdefgh");
    const over = Readable.from([Buffer.from("abcdefgh"), Buffer.from("i")]);
    expect(await readBoundedChunks(over, LIMIT)).toBeNull();
    expect(over.destroyed).toBe(true);
  });
});
