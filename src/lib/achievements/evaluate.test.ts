import { describe, expect, it } from "vitest";

import type { Achievement, AchievementRule } from "@/lib/adapters/achievements";

import { evaluateAchievements, type AchievementEvent, type EarnedAchievement, type MetricReading } from "./evaluate";

const DEPLOYED = "acme.deploy.succeeded";
const FAILED = "acme.deploy.failed";
const STARS = "acme.stars.total";
const SIGNUPS = "acme.signups.daily";
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function achievement(rule: AchievementRule, id = "acme.test"): Achievement {
  return { id, title: `Title of ${id}`, publicTitle: `Public ${id}`, description: `How ${id} is earned.`, rule };
}

function event(at: string, typeId = DEPLOYED): AchievementEvent {
  return { typeId, occurredAt: new Date(at) };
}

/** `count` events an hour apart from `start`. */
function hourly(start: string, count: number, typeId = DEPLOYED): AchievementEvent[] {
  return Array.from({ length: count }, (_, index) => ({ typeId, occurredAt: new Date(Date.parse(start) + index * HOUR_MS) }));
}

function reading(fields: Partial<MetricReading> & Pick<MetricReading, "snapshotDate" | "value">): MetricReading {
  return {
    accountId: "account-a",
    metricKey: STARS,
    observedAt: new Date(`${fields.snapshotDate}T12:00:00.000Z`),
    periodStart: null,
    ...fields,
  };
}

function evaluate(
  rule: AchievementRule,
  evidence: Readonly<{ events?: AchievementEvent[]; readings?: MetricReading[]; earned?: string[] }>,
): EarnedAchievement | undefined {
  const earned = evaluateAchievements({
    achievements: [achievement(rule)],
    earnedIds: new Set(evidence.earned ?? []),
    events: evidence.events ?? [],
    readings: evidence.readings ?? [],
  });
  expect(earned.length).toBeLessThanOrEqual(1);
  return earned[0];
}

const instant = (at: string) => ({ earnedAt: new Date(at), earnedPrecision: "instant", evidence: "crossed", threshold: null });

describe("event_count", () => {
  const tenth: AchievementRule = { kind: "event_count", typeIds: [DEPLOYED], count: 10 };

  it("is earned at the event that reached the count, with the definition's titles", () => {
    const events = hourly("2026-03-01T08:00:00.000Z", 12);
    expect(evaluate(tenth, { events })).toEqual({
      achievementId: "acme.test",
      title: "Title of acme.test",
      publicTitle: "Public acme.test",
      description: "How acme.test is earned.",
      ...instant("2026-03-01T17:00:00.000Z"),
    });
  });

  it("counts only the rule's event types and is not earned one short", () => {
    const events = [...hourly("2026-03-01T08:00:00.000Z", 9), event("2026-03-02T08:00:00.000Z", FAILED)];
    expect(evaluate(tenth, { events })).toBeUndefined();
  });

  it("counts every retained event, so the 10th and 100th stay provable long after a 30 day window", () => {
    // One deployment every three days for a year: the 100th is months older than any 30 day window.
    const events = Array.from({ length: 120 }, (_, index) => ({
      typeId: DEPLOYED,
      occurredAt: new Date(Date.parse("2025-11-01T10:00:00.000Z") + index * 3 * DAY_MS),
    }));
    expect(evaluate(tenth, { events })?.earnedAt).toEqual(new Date("2025-11-28T10:00:00.000Z"));
    const hundredth = evaluate({ kind: "event_count", typeIds: [DEPLOYED], count: 100 }, { events });
    expect(hundredth?.earnedAt).toEqual(new Date(Date.parse("2025-11-01T10:00:00.000Z") + 99 * 3 * DAY_MS));
  });
});

describe("event_streak", () => {
  const rule: AchievementRule = { kind: "event_streak", successTypeIds: [DEPLOYED], failureTypeIds: [FAILED], count: 3 };

  it("is earned at the success that completes a run with no failure between", () => {
    const events = [
      event("2026-03-01T08:00:00.000Z"),
      event("2026-03-01T09:00:00.000Z"),
      event("2026-03-01T10:00:00.000Z", FAILED),
      event("2026-03-01T11:00:00.000Z"),
      event("2026-03-01T12:00:00.000Z"),
      event("2026-03-01T13:00:00.000Z"),
    ];
    expect(evaluate(rule, { events })).toMatchObject(instant("2026-03-01T13:00:00.000Z"));
  });

  it("is broken by a failure", () => {
    const events = [
      event("2026-03-01T08:00:00.000Z"),
      event("2026-03-01T09:00:00.000Z"),
      event("2026-03-01T10:00:00.000Z", FAILED),
      event("2026-03-01T11:00:00.000Z"),
    ];
    expect(evaluate(rule, { events })).toBeUndefined();
  });

  it("ignores event types that are neither success nor failure", () => {
    const events = [
      event("2026-03-01T08:00:00.000Z"),
      event("2026-03-01T09:00:00.000Z", "acme.domain.added"),
      event("2026-03-01T10:00:00.000Z"),
      event("2026-03-01T11:00:00.000Z"),
    ];
    expect(evaluate(rule, { events })).toMatchObject(instant("2026-03-01T11:00:00.000Z"));
  });
});

describe("events_in_window", () => {
  const busyDay: AchievementRule = { kind: "events_in_window", typeIds: [DEPLOYED], count: 4, window: "day" };
  const busyHour: AchievementRule = { kind: "events_in_window", typeIds: [DEPLOYED], count: 4, window: "hour" };

  it("counts a London calendar day, which in summer starts at 23:00 UTC the day before", () => {
    // 2026-06-12 23:10 to 23:40 UTC is 00:10 to 00:40 on 13 June in London.
    const events = [
      event("2026-06-12T23:10:00.000Z"),
      event("2026-06-12T23:40:00.000Z"),
      event("2026-06-13T09:00:00.000Z"),
      event("2026-06-13T21:00:00.000Z"),
    ];
    expect(evaluate(busyDay, { events })).toMatchObject(instant("2026-06-13T21:00:00.000Z"));
  });

  it("does not join two London days that share a UTC date", () => {
    // 22:30 UTC is 23:30 on 12 June in London; the rest fall on 13 June.
    const events = [
      event("2026-06-12T22:30:00.000Z"),
      event("2026-06-12T23:10:00.000Z"),
      event("2026-06-13T09:00:00.000Z"),
      event("2026-06-13T21:00:00.000Z"),
    ];
    expect(evaluate(busyDay, { events })).toBeUndefined();
  });

  it("counts a London clock hour, and the hour repeated when the clocks go back is two hours", () => {
    // On 2026-10-25 London shows 01:00 to 01:59 twice: 00:00 to 01:00 UTC (BST) and 01:00 to 02:00 UTC (GMT).
    const repeated = [
      event("2026-10-25T00:10:00.000Z"),
      event("2026-10-25T00:50:00.000Z"),
      event("2026-10-25T01:10:00.000Z"),
      event("2026-10-25T01:50:00.000Z"),
    ];
    expect(evaluate(busyHour, { events: repeated })).toBeUndefined();
    const oneHour = [...repeated, event("2026-10-25T01:55:00.000Z"), event("2026-10-25T01:58:00.000Z")];
    expect(evaluate(busyHour, { events: oneHour })).toMatchObject(instant("2026-10-25T01:58:00.000Z"));
  });
});

describe("event_at_local_time", () => {
  const nightOwl: AchievementRule = { kind: "event_at_local_time", typeIds: [DEPLOYED], fromHour: 0, toHour: 5 };
  const fridayShip: AchievementRule = {
    kind: "event_at_local_time",
    typeIds: [DEPLOYED],
    fromHour: 16,
    toHour: 24,
    weekdays: ["friday"],
  };

  it("reads the hour in London: 23:30 UTC in summer is 00:30 BST, a night owl", () => {
    expect(evaluate(nightOwl, { events: [event("2026-07-01T23:30:00.000Z")] })).toMatchObject(
      instant("2026-07-01T23:30:00.000Z"),
    );
  });

  it("leaves 23:30 GMT in winter and 05:00 London out", () => {
    const events = [event("2026-01-15T23:30:00.000Z"), event("2026-07-02T04:00:00.000Z")];
    expect(evaluate(nightOwl, { events })).toBeUndefined();
  });

  it("is earned at 16:00 on a London Friday, in summer at 15:00 UTC", () => {
    const events = [event("2026-07-03T14:59:00.000Z"), event("2026-07-03T15:00:00.000Z")];
    expect(evaluate(fridayShip, { events })).toMatchObject(instant("2026-07-03T15:00:00.000Z"));
  });

  it("uses the London weekday: 23:30 UTC on a summer Friday is already Saturday", () => {
    expect(evaluate(fridayShip, { events: [event("2026-07-03T23:30:00.000Z")] })).toBeUndefined();
    expect(evaluate(fridayShip, { events: [event("2026-01-09T23:30:00.000Z")] })).toMatchObject(
      instant("2026-01-09T23:30:00.000Z"),
    );
  });
});

describe("consecutive_days", () => {
  const weeklyRhythm: AchievementRule = { kind: "consecutive_days", typeIds: [DEPLOYED], days: 3 };
  const weekend: AchievementRule = { kind: "consecutive_days", typeIds: [DEPLOYED], days: 2, startWeekday: "saturday" };

  it("is earned at the first event of the run's last London day", () => {
    const events = [
      event("2026-06-01T10:00:00.000Z"),
      // 23:30 UTC on 2 June is 00:30 on 3 June in London, so 2 June has no event.
      event("2026-06-02T23:30:00.000Z"),
      event("2026-06-04T09:00:00.000Z"),
      event("2026-06-05T08:00:00.000Z"),
      event("2026-06-05T18:00:00.000Z"),
    ];
    expect(evaluate(weeklyRhythm, { events })).toMatchObject(instant("2026-06-05T08:00:00.000Z"));
  });

  it("is not earned across a day with no event", () => {
    const events = [event("2026-06-01T10:00:00.000Z"), event("2026-06-02T10:00:00.000Z"), event("2026-06-04T10:00:00.000Z")];
    expect(evaluate(weeklyRhythm, { events })).toBeUndefined();
  });

  it("with a start weekday, needs the run to begin on it: Saturday then Sunday", () => {
    // 2026-07-03 is a Friday, 2026-07-05 a Sunday, 2026-07-06 a Monday.
    const fridaySaturday = [event("2026-07-03T10:00:00.000Z"), event("2026-07-04T10:00:00.000Z")];
    expect(evaluate(weekend, { events: fridaySaturday })).toBeUndefined();
    const sundayMonday = [event("2026-07-05T10:00:00.000Z"), event("2026-07-06T10:00:00.000Z")];
    expect(evaluate(weekend, { events: sundayMonday })).toBeUndefined();
    const fridayToSunday = [...fridaySaturday, event("2026-07-05T07:00:00.000Z"), event("2026-07-05T10:00:00.000Z")];
    expect(evaluate(weekend, { events: fridayToSunday })).toMatchObject(instant("2026-07-05T07:00:00.000Z"));
  });
});

describe("metric_threshold", () => {
  const hundred: AchievementRule = { kind: "metric_threshold", metricKey: STARS, value: 100 };

  it("is recorded at least the threshold when the first stored reading is already above it", () => {
    const readings = [reading({ snapshotDate: "2026-05-01", value: 140 }), reading({ snapshotDate: "2026-05-02", value: 150 })];
    expect(evaluate(hundred, { readings })).toMatchObject({
      earnedAt: new Date("2026-05-01T12:00:00.000Z"),
      earnedPrecision: "instant",
      evidence: "at_least",
      threshold: 100,
    });
  });

  it("is crossed at the first reading at or above it after a stored reading below it", () => {
    const readings = [
      reading({ snapshotDate: "2026-05-01", value: 90 }),
      reading({ snapshotDate: "2026-05-02", value: 100, observedAt: new Date("2026-05-02T17:45:00.000Z") }),
      reading({ snapshotDate: "2026-05-03", value: 120 }),
    ];
    expect(evaluate(hundred, { readings })).toMatchObject(instant("2026-05-02T17:45:00.000Z"));
  });

  it("is not earned below the threshold", () => {
    expect(evaluate(hundred, { readings: [reading({ snapshotDate: "2026-05-01", value: 99 })] })).toBeUndefined();
  });

  it("sums the project's accounts, carrying an account without a reading that day forward", () => {
    const readings = [
      reading({ snapshotDate: "2026-05-01", value: 60 }),
      reading({ snapshotDate: "2026-05-01", value: 30, accountId: "account-b" }),
      // Account b missed a sync on 2 May: its 30 still counts.
      reading({ snapshotDate: "2026-05-02", value: 70, observedAt: new Date("2026-05-02T08:00:00.000Z") }),
    ];
    expect(evaluate(hundred, { readings })).toMatchObject(instant("2026-05-02T08:00:00.000Z"));
  });

  it("is only at least the threshold when an account's first reading takes the total over it", () => {
    const readings = [
      reading({ snapshotDate: "2026-05-01", value: 20 }),
      reading({ snapshotDate: "2026-05-02", value: 21 }),
      reading({ snapshotDate: "2026-05-02", value: 500, accountId: "account-b" }),
    ];
    expect(evaluate(hundred, { readings })).toMatchObject({ evidence: "at_least", threshold: 100 });
  });

  it("reads only its own metric key", () => {
    const readings = [reading({ snapshotDate: "2026-05-01", value: 10 }), reading({ snapshotDate: "2026-05-02", value: 500, metricKey: "acme.forks.total" })];
    expect(evaluate(hundred, { readings })).toBeUndefined();
  });
});

describe("daily_total_threshold", () => {
  // Each reading holds the whole UTC day before the one it was read on, as PostHog stores them.
  function day(date: string, value: number, accountId = "account-a"): MetricReading {
    const start = new Date(`${date}T00:00:00.000Z`);
    const readOn = new Date(start.getTime() + DAY_MS + 6 * HOUR_MS);
    return { accountId, metricKey: SIGNUPS, snapshotDate: readOn.toISOString().slice(0, 10), value, observedAt: readOn, periodStart: start };
  }

  it("sums the days in order and is dated to the day it counts, at 00:00 UTC with day precision", () => {
    const rule: AchievementRule = { kind: "daily_total_threshold", metricKey: SIGNUPS, value: 10, sum: "cumulative" };
    const readings = [day("2026-03-28", 4), day("2026-03-29", 3), day("2026-03-30", 5), day("2026-03-31", 9)];
    expect(evaluate(rule, { readings })).toMatchObject({
      earnedAt: new Date("2026-03-30T00:00:00.000Z"),
      earnedPrecision: "day",
      evidence: "crossed",
      threshold: null,
    });
  });

  it("adds the accounts' totals of the same day", () => {
    const rule: AchievementRule = { kind: "daily_total_threshold", metricKey: SIGNUPS, value: 100, sum: "single_day" };
    const readings = [day("2026-04-01", 60), day("2026-04-02", 60), day("2026-04-02", 45, "account-b"), day("2026-04-03", 99)];
    expect(evaluate(rule, { readings })?.earnedAt).toEqual(new Date("2026-04-02T00:00:00.000Z"));
  });

  it("needs one day at or above the value for a single day total", () => {
    const rule: AchievementRule = { kind: "daily_total_threshold", metricKey: SIGNUPS, value: 100, sum: "single_day" };
    const readings = [day("2026-04-01", 60), day("2026-04-02", 60), day("2026-04-03", 99)];
    expect(evaluate(rule, { readings })).toBeUndefined();
  });
});

describe("metric_daily_gain", () => {
  const trending: AchievementRule = { kind: "metric_daily_gain", metricKey: STARS, gain: 10 };

  it("is earned when a day's reading is at least the gain above the previous day's last", () => {
    const readings = [
      reading({ snapshotDate: "2026-05-01", value: 100 }),
      reading({ snapshotDate: "2026-05-02", value: 109 }),
      reading({ snapshotDate: "2026-05-03", value: 119, observedAt: new Date("2026-05-03T20:00:00.000Z") }),
    ];
    expect(evaluate(trending, { readings })).toMatchObject(instant("2026-05-03T20:00:00.000Z"));
  });

  it("needs the previous day's reading stored: a gap is not one day's gain", () => {
    const readings = [reading({ snapshotDate: "2026-05-01", value: 100 }), reading({ snapshotDate: "2026-05-03", value: 150 })];
    expect(evaluate(trending, { readings })).toBeUndefined();
  });

  it("does not count an account added to the project as a gain", () => {
    const readings = [
      reading({ snapshotDate: "2026-05-01", value: 100 }),
      reading({ snapshotDate: "2026-05-02", value: 101 }),
      reading({ snapshotDate: "2026-05-02", value: 300, accountId: "account-b" }),
    ];
    expect(evaluate(trending, { readings })).toBeUndefined();
  });
});

describe("evaluateAchievements", () => {
  it("skips achievements already earned and keeps the rest in definition order", () => {
    const events = hourly("2026-03-01T08:00:00.000Z", 10);
    const earned = evaluateAchievements({
      achievements: [
        achievement({ kind: "event_count", typeIds: [DEPLOYED], count: 1 }, "acme.deployments.first"),
        achievement({ kind: "event_count", typeIds: [DEPLOYED], count: 10 }, "acme.deployments.10"),
        achievement({ kind: "event_count", typeIds: [DEPLOYED], count: 100 }, "acme.deployments.100"),
      ],
      earnedIds: new Set(["acme.deployments.first"]),
      events,
      readings: [],
    });
    expect(earned.map((item) => item.achievementId)).toEqual(["acme.deployments.10"]);
  });

  it("proves nothing without stored evidence", () => {
    const earned = evaluateAchievements({
      achievements: [
        achievement({ kind: "event_count", typeIds: [DEPLOYED], count: 1 }, "acme.deployments.first"),
        achievement({ kind: "metric_threshold", metricKey: STARS, value: 1 }, "acme.stars.first"),
      ],
      earnedIds: new Set(),
      events: [],
      readings: [],
    });
    expect(earned).toEqual([]);
  });
});
