import { describe, expect, it } from "vitest";

import { instantMicros, isAfter, isUnread, unreadBadgeLabel } from "./unread";

describe("instantMicros", () => {
  it.each([
    ["Postgres's own spelling, microseconds and offset", "2026-11-28T10:00:00.123456+00:00", Date.UTC(2026, 10, 28, 10) * 1000 + 123_456],
    ["a Z offset and milliseconds", "2026-11-28T10:00:00.123Z", Date.UTC(2026, 10, 28, 10) * 1000 + 123_000],
    ["no fraction at all", "2026-11-28T10:00:00Z", Date.UTC(2026, 10, 28, 10) * 1000],
    ["a short fraction, padded", "2026-11-28T10:00:00.5Z", Date.UTC(2026, 10, 28, 10) * 1000 + 500_000],
  ])("reads %s", (_title, iso, micros) => {
    expect(instantMicros(iso)).toBe(micros);
  });

  it("reads one instant the same however it is spelled", () => {
    expect(instantMicros("2026-11-28T10:00:00.500000+00:00")).toBe(instantMicros("2026-11-28T11:00:00.5+01:00"));
  });

  it.each([["an empty string", ""], ["not a date", "yesterday"]])("is NaN for %s", (_title, iso) => {
    expect(instantMicros(iso)).toBeNaN();
  });
});

describe("isAfter", () => {
  it("tells apart two instants within one millisecond, which Date.parse cannot", () => {
    expect(isAfter("2026-11-28T10:00:00.000301+00:00", "2026-11-28T10:00:00.000300+00:00")).toBe(true);
    expect(Date.parse("2026-11-28T10:00:00.000301Z") > Date.parse("2026-11-28T10:00:00.000300Z")).toBe(false);
  });

  it("is false for an equal instant and for an unreadable one", () => {
    expect(isAfter("2026-11-28T10:00:00Z", "2026-11-28T10:00:00.000000+00:00")).toBe(false);
    expect(isAfter("not a date", "2026-11-28T10:00:00Z")).toBe(false);
  });
});

describe("isUnread", () => {
  const LAST = "2026-11-28T10:00:00.000500+00:00";

  it.each([
    ["never opened by this side", null, true],
    ["read before the last message", "2026-11-28T09:59:59.999999+00:00", true],
    ["read one microsecond before the last message", "2026-11-28T10:00:00.000499+00:00", true],
    ["read exactly through the last message", LAST, false],
    ["read after the last message", "2026-11-28T10:00:01+00:00", false],
  ])("%s", (_title, readAt, expected) => {
    expect(isUnread(LAST, readAt)).toBe(expected);
  });

  it("never raises a badge for a timestamp it cannot read", () => {
    expect(isUnread("not a date", null)).toBe(false);
    expect(isUnread("not a date", LAST)).toBe(false);
  });
});

describe("unreadBadgeLabel", () => {
  it.each([
    [0, null],
    [-1, null],
    [Number.NaN, null],
    [1, "1"],
    [99, "99"],
    [100, "99+"],
    [250, "99+"],
  ])("%s threads show %s", (count, label) => {
    expect(unreadBadgeLabel(count, 100)).toBe(label);
  });
});
