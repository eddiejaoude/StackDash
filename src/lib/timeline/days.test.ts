import { describe, expect, it } from "vitest";

import { groupEventsByDay } from "./days";

// 12:00 London summer time on Tuesday 2026-06-16.
const NOW = new Date("2026-06-16T11:00:00Z");

const event = (id: string, occurredAt: string) => ({ id, occurred_at: occurredAt });

describe("groupEventsByDay", () => {
  it("returns no days for no events", () => {
    expect(groupEventsByDay([], NOW)).toEqual([]);
  });

  it("labels an older day with its weekday and ISO date", () => {
    const only = event("a", "2026-06-10T09:00:00Z");
    expect(groupEventsByDay([only], NOW)).toEqual([{ label: "Wednesday, 2026-06-10", date: "2026-06-10", events: [only] }]);
  });

  it("splits at midnight London time, not UTC, in summer time", () => {
    // 23:30 UTC on June 9 is 00:30 on June 10 in London; 22:30 UTC is still June 9.
    const afterMidnight = event("a", "2026-06-09T23:30:00Z");
    const beforeMidnight = event("b", "2026-06-09T22:30:00Z");
    expect(groupEventsByDay([afterMidnight, beforeMidnight], NOW)).toEqual([
      { label: "Wednesday, 2026-06-10", date: "2026-06-10", events: [afterMidnight] },
      { label: "Tuesday, 2026-06-09", date: "2026-06-09", events: [beforeMidnight] },
    ]);
  });

  it("labels today and yesterday in London time", () => {
    const today = event("a", "2026-06-15T23:30:00Z");
    const yesterday = event("b", "2026-06-15T22:30:00Z");
    expect(groupEventsByDay([today, yesterday], NOW).map(({ label }) => label)).toEqual(["Today", "Yesterday"]);
  });

  it("finds yesterday across the 23 hour day when the clocks go forward", () => {
    // 00:30 on 2026-03-30 in London; 24 hours earlier is already March 28.
    const now = new Date("2026-03-29T23:30:00Z");
    const days = groupEventsByDay(
      [event("a", "2026-03-29T00:30:00Z"), event("b", "2026-03-28T23:30:00Z")],
      now,
    );
    expect(days.map(({ label }) => label)).toEqual(["Yesterday", "Saturday, 2026-03-28"]);
  });

  it("keeps the events in the order given, newest first", () => {
    const events = [
      event("a", "2026-06-16T10:00:00Z"),
      event("b", "2026-06-16T08:00:00Z"),
      event("c", "2026-06-15T12:00:00Z"),
      event("d", "2026-06-15T07:00:00Z"),
      event("e", "2026-06-12T07:00:00Z"),
    ];
    const days = groupEventsByDay(events, NOW);
    expect(days.map(({ date }) => date)).toEqual(["2026-06-16", "2026-06-15", "2026-06-12"]);
    expect(days.flatMap((day) => day.events.map(({ id }) => id))).toEqual(["a", "b", "c", "d", "e"]);
  });
});
