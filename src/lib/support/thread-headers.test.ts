import { describe, expect, it } from "vitest";

import { REFERENCE_LIMIT, buildThreadHeaders, normalizeMessageId, threadSubject } from "./thread-headers";

describe("normalizeMessageId", () => {
  it.each([
    ["an id in brackets", "<a1@email.example.com>", "<a1@email.example.com>"],
    ["an id that lost its brackets", "a1@email.example.com", "<a1@email.example.com>"],
    ["padding inside and outside the brackets", "  < a1@email.example.com >  ", "<a1@email.example.com>"],
  ])("keeps %s", (_title, raw, expected) => {
    expect(normalizeMessageId(raw)).toBe(expected);
  });

  it.each([
    ["an empty string", ""],
    ["empty brackets", "<>"],
    ["whitespace inside the id", "<a1 b@email.example.com>"],
    ["a bracket inside the id", "<a<1@email.example.com>"],
    ["no @, so no msg-id at all", "<a1.email.example.com>"],
  ])("drops %s", (_title, raw) => {
    expect(normalizeMessageId(raw)).toBeNull();
  });
});

describe("buildThreadHeaders", () => {
  it("sends the first email to a recipient with no threading headers and no Re:", () => {
    expect(buildThreadHeaders([])).toEqual({ headers: {}, isReply: false });
  });

  it("answers the newest email that recipient received and references every one, oldest first", () => {
    expect(buildThreadHeaders(["<one@x>", "<two@x>", "<three@x>"])).toEqual({
      isReply: true,
      headers: { "In-Reply-To": "<three@x>", References: "<one@x> <two@x> <three@x>" },
    });
  });

  it("answers the only email for a second one", () => {
    expect(buildThreadHeaders(["<one@x>"])).toEqual({ isReply: true, headers: { "In-Reply-To": "<one@x>", References: "<one@x>" } });
  });

  it("drops an id it cannot repair rather than sending a malformed header, and keeps the rest", () => {
    expect(buildThreadHeaders(["<one@x>", "bad id"])).toEqual({ isReply: true, headers: { "In-Reply-To": "<one@x>", References: "<one@x>" } });
  });

  it("still says Re: when no id survived, so subject grouping keeps the thread", () => {
    expect(buildThreadHeaders(["bad id"])).toEqual({ headers: {}, isReply: true });
  });

  it("at the limit, leads References with the first email ever sent and stays at the limit", () => {
    const window = Array.from({ length: REFERENCE_LIMIT }, (_, index) => `<m${index + 5}@x>`);
    const { headers } = buildThreadHeaders(window, "<m1@x>");
    const references = (headers.References ?? "").split(" ");
    expect(references).toHaveLength(REFERENCE_LIMIT);
    expect(references[0]).toBe("<m1@x>");
    expect(headers["In-Reply-To"]).toBe(`<m${REFERENCE_LIMIT + 4}@x>`);
  });

  it("one under the limit, ignores the root: the window already starts at the first email", () => {
    const window = Array.from({ length: REFERENCE_LIMIT - 1 }, (_, index) => `<m${index + 1}@x>`);
    expect((buildThreadHeaders(window, "<m0@x>").headers.References ?? "").split(" ")[0]).toBe("<m1@x>");
  });
});

describe("threadSubject", () => {
  it.each([
    ["the first email keeps the subject", "Support chat: Why is it zero", false, "Support chat: Why is it zero"],
    ["a later email says Re:", "Support chat: Why is it zero", true, "Re: Support chat: Why is it zero"],
    ["Re: is never doubled", "RE: hello", true, "RE: hello"],
    ["line breaks never reach a header", "Hello\r\nBcc: someone@example.com", false, "Hello Bcc: someone@example.com"],
  ])("%s", (_title, subject, isReply, expected) => {
    expect(threadSubject(subject, isReply)).toBe(expected);
  });
});
