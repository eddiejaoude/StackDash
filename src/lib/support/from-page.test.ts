import { describe, expect, it } from "vitest";

import { ADMIN_PATH } from "@/lib/auth/super-admin";

import { supportFromPage } from "./from-page";
import { SUPPORT_INBOX_PATH } from "./paths";
import { codePoints, normalizeBody, supportSubject } from "./text";

describe("supportFromPage", () => {
  it.each([
    ["a workspace page", "/w/abcdefghij/dashboard", "/w/abcdefghij/dashboard"],
    ["the app root", "/app", "/app"],
    ["the account page", "/account", "/account"],
    ["the messages page", "/account/messages", "/account/messages"],
    ["a page with a query and a fragment, which are dropped", "/w/abcdefghij/timeline?q=secret#top", "/w/abcdefghij/timeline"],
    ["dot segments, resolved first", "/w/abcdefghij/../abcdefghij/alerts", "/w/abcdefghij/alerts"],
  ])("keeps %s", (_title, input, expected) => {
    expect(supportFromPage(input)).toBe(expected);
  });

  it.each([
    ["nothing", null],
    ["a number", 42],
    ["an empty string", ""],
    ["an absolute URL", "https://evil.example/w/x"],
    ["a protocol-relative URL", "//evil.example/w/x"],
    ["a backslash trick", "/\\evil.example"],
    ["an encoded backslash", "/%5Cevil.example"],
    ["a tab, which browsers drop", "/w/x\t/y"],
    ["a public page", "/docs/providers"],
    ["the signed-out page after deletion", "/account/deleted"],
    ["dot segments that leave the app", "/w/../../docs"],
    ["a path over 512 characters", `/w/${"a".repeat(600)}`],
  ])("drops %s", (_title, input) => {
    expect(supportFromPage(input)).toBeNull();
  });
});

describe("normalizeBody", () => {
  it("keeps the message's own line breaks and trims the edges", () => {
    expect(normalizeBody("  Line one\r\n\r\nLine two  ")).toEqual({ ok: true, body: "Line one\n\nLine two" });
  });

  it.each([
    ["empty", ""],
    ["only whitespace and breaks", " \n\t\r\n "],
    ["only control characters", "\u0000\u0007"],
  ])("refuses a message that is %s", (_title, raw) => {
    expect(normalizeBody(raw)).toEqual({ ok: false, reason: "empty" });
  });

  it("allows exactly 4,000 characters, counting an emoji once, and refuses one more", () => {
    expect(normalizeBody("😀".repeat(4000)).ok).toBe(true);
    expect(normalizeBody("a".repeat(4001))).toEqual({ ok: false, reason: "too_long" });
  });
});

describe("supportSubject", () => {
  it("is the first line that says something, on one line", () => {
    expect(supportSubject("\n  Why is   the total zero?\nIt was 40 yesterday.")).toBe("Why is the total zero?");
  });

  it("cuts a long first line to 80 characters with an ellipsis", () => {
    const subject = supportSubject("word ".repeat(40));
    expect(codePoints(subject)).toBeLessThanOrEqual(81);
    expect(subject.endsWith("…")).toBe(true);
  });
});

describe("paths", () => {
  it("puts the inbox under the super admin path the proxy guards", () => {
    expect(SUPPORT_INBOX_PATH.startsWith(`${ADMIN_PATH}/`)).toBe(true);
  });
});
