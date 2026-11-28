import { describe, expect, it } from "vitest";

import { combineDecisions, rateLimitKey, windowDecision } from "./rate-limit";

const START = new Date("2026-11-28T10:00:00.000Z");
const WIDTH = 300;
const NEXT = new Date("2026-11-28T10:05:00.000Z");
const AFTER_NEXT = new Date("2026-11-28T10:10:00.000Z");

describe("windowDecision", () => {
  it.each([
    ["the first attempt", { current: 1, previous: 0 }, { allowed: true }],
    ["the attempt that reaches the limit exactly", { current: 20, previous: 0 }, { allowed: true }],
    ["the limit made up of both windows", { current: 5, previous: 15 }, { allowed: true }],
  ])("allows %s", (_title, counts, expected) => {
    expect(windowDecision(counts, 20, START, WIDTH)).toEqual(expected);
  });

  it("refuses one past the limit in one window, until the window after next, when nothing older counts", () => {
    expect(windowDecision({ current: 21, previous: 0 }, 20, START, WIDTH)).toEqual({ allowed: false, retryAt: AFTER_NEXT });
  });

  it("refuses a burst across the boundary (5 now and 16 just before is 21), and allows again at the next window", () => {
    expect(windowDecision({ current: 5, previous: 16 }, 20, START, WIDTH)).toEqual({ allowed: false, retryAt: NEXT });
  });

  it.each([
    ["one under the limit this window: next window has room for one", { current: 19, previous: 2 }, NEXT],
    ["exactly the limit this window: next window has none", { current: 20, previous: 1 }, AFTER_NEXT],
  ])("off by one at the boundary, %s", (_title, counts, retryAt) => {
    expect(windowDecision(counts, 20, START, WIDTH)).toEqual({ allowed: false, retryAt });
  });

  it("counts refused attempts too, so hammering the button never brings the time closer", () => {
    expect(windowDecision({ current: 40, previous: 0 }, 20, START, WIDTH)).toEqual({ allowed: false, retryAt: AFTER_NEXT });
  });
});

describe("combineDecisions", () => {
  it("allows only when every key allows", () => {
    expect(combineDecisions({ allowed: true }, { allowed: true })).toEqual({ allowed: true });
    expect(combineDecisions()).toEqual({ allowed: true });
  });

  it("refuses when either key refuses, with the later time, when both would allow", () => {
    expect(combineDecisions({ allowed: true }, { allowed: false, retryAt: NEXT })).toEqual({ allowed: false, retryAt: NEXT });
    expect(combineDecisions({ allowed: false, retryAt: AFTER_NEXT }, { allowed: false, retryAt: NEXT })).toEqual({
      allowed: false,
      retryAt: AFTER_NEXT,
    });
  });
});

describe("rateLimitKey", () => {
  const SECRET = Buffer.alloc(32, 7);

  it("is a 64 character lowercase hex digest, the only form the counters table accepts", () => {
    expect(rateLimitKey(SECRET, "send", "user", "10000000-0000-4000-8000-000000000001")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps scopes and kinds apart, so a send never spends a claim and a user never shares a row with an IP", () => {
    const keys = new Set([
      rateLimitKey(SECRET, "send", "user", "x"),
      rateLimitKey(SECRET, "claim", "user", "x"),
      rateLimitKey(SECRET, "send", "ip", "x"),
      rateLimitKey(SECRET, "claim", "ip", "x"),
    ]);
    expect(keys.size).toBe(4);
  });

  it("reads an address the same in any case, and differs under another secret", () => {
    expect(rateLimitKey(SECRET, "send", "ip", "2001:DB8::1")).toBe(rateLimitKey(SECRET, "send", "ip", "2001:db8::1"));
    expect(rateLimitKey(Buffer.alloc(32, 8), "send", "ip", "2001:db8::1")).not.toBe(rateLimitKey(SECRET, "send", "ip", "2001:db8::1"));
  });
});
