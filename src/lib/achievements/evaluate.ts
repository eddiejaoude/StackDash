import type { Achievement, AchievementRule, Weekday } from "@/lib/adapters/achievements";
import { addUtcDays } from "@/lib/alerts/anomaly";
import { utcDate } from "@/lib/jobs/ingest";
import type { Database } from "@/lib/supabase/database.types";
import { TIMELINE_TIME_ZONE } from "@/lib/timeline/query";

/*
 * Which of one provider's achievements a project's stored evidence proves (#413). Pure: the
 * definitions, the ids already earned, and the stored events and metric readings in; the newly
 * provable achievements out, each at the first instant (or day) the evidence supports. No I/O and
 * no clock; `run.ts` loads the inputs and records the result.
 *
 * Evaluating over everything retained is also the backfill: the first evaluation earns everything
 * the stored history proves, at its historical date. Nothing before the first stored event or
 * reading is ever inferred, so a first-sync baseline only ever yields "recorded" counts and
 * "at least" thresholds.
 */

export type EarnedPrecision = Database["public"]["Enums"]["achievement_date_precision"];
export type AchievementEvidence = Database["public"]["Enums"]["achievement_evidence"];

/** One stored activity event of the provider. */
export type AchievementEvent = Readonly<{ typeId: string; occurredAt: Date }>;

/** One stored `usage_snapshots` row of the provider: one account's reading of one metric on one UTC day. */
export type MetricReading = Readonly<{
  accountId: string;
  metricKey: string;
  // The row's UTC day (`snapshot_date`). Each sync on that day overwrites the row, so it holds the
  // day's last reading.
  snapshotDate: string;
  value: number;
  // When the value held: `point_at` for a point in time reading (a star count), else `retrieved_at`.
  observedAt: Date;
  // The start of the reading's period, which for a daily total is the UTC day it counts; null for
  // a point in time reading.
  periodStart: Date | null;
}>;

export type EvaluationInput = Readonly<{
  achievements: readonly Achievement[];
  // Earned ids are permanent and never re-evaluated: an earned date never moves.
  earnedIds: ReadonlySet<string>;
  // Ordered by occurred_at, then id.
  events: readonly AchievementEvent[];
  readings: readonly MetricReading[];
}>;

export type EarnedAchievement = Readonly<{
  achievementId: string;
  title: string;
  publicTitle: string;
  description: string;
  earnedAt: Date;
  earnedPrecision: EarnedPrecision;
  evidence: AchievementEvidence;
  // The threshold an "at least" achievement was recorded at; null when the crossing was observed.
  threshold: number | null;
}>;

type Proof = Readonly<{ earnedAt: Date; precision: EarnedPrecision; evidence: AchievementEvidence; threshold: number | null }>;

const HOUR_MS = 60 * 60 * 1000;

const crossedAt = (earnedAt: Date): Proof => ({ earnedAt, precision: "instant", evidence: "crossed", threshold: null });

// ── London calendar ────────────────────────────────────────────────────────────

type LondonClock = Readonly<{ date: string; hour: number; weekday: Weekday }>;

const LONDON_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMELINE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  weekday: "long",
});

const WEEKDAYS: readonly Weekday[] = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
// Intl's English weekday names (`weekday: "long"`).
const WEEKDAY_BY_NAME: Readonly<Record<string, Weekday>> = {
  Monday: "monday",
  Tuesday: "tuesday",
  Wednesday: "wednesday",
  Thursday: "thursday",
  Friday: "friday",
  Saturday: "saturday",
  Sunday: "sunday",
};

/**
 * London's date, clock hour, and weekday of an instant, cached per UTC hour. London is a whole
 * number of hours ahead of UTC and changes its clocks on a UTC hour, so every instant in one UTC
 * hour shares them; for the same reason a London clock hour is exactly one UTC hour, also on the
 * night the clocks go back and 01:00 happens twice.
 */
function londonClocks(): (at: Date) => LondonClock {
  const cache = new Map<number, LondonClock>();
  return (at) => {
    const hourIndex = Math.floor(at.getTime() / HOUR_MS);
    const cached = cache.get(hourIndex);
    if (cached !== undefined) return cached;
    const parts: Record<string, string> = {};
    for (const part of LONDON_PARTS.formatToParts(at)) parts[part.type] = part.value;
    const clock: LondonClock = {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      hour: Number(parts.hour),
      weekday: WEEKDAY_BY_NAME[parts.weekday ?? ""] ?? "monday",
    };
    cache.set(hourIndex, clock);
    return clock;
  };
}

/** The weekday of a calendar date (`YYYY-MM-DD`). */
function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? "monday";
}

// ── Event rules ────────────────────────────────────────────────────────────────

function ofTypes(events: readonly AchievementEvent[], typeIds: readonly string[]): AchievementEvent[] {
  const types = new Set(typeIds);
  return events.filter((event) => types.has(event.typeId));
}

function nthEvent(events: readonly AchievementEvent[], typeIds: readonly string[], count: number): Proof | null {
  const event = ofTypes(events, typeIds)[count - 1];
  return event === undefined ? null : crossedAt(event.occurredAt);
}

function streak(
  events: readonly AchievementEvent[],
  successTypeIds: readonly string[],
  failureTypeIds: readonly string[],
  count: number,
): Proof | null {
  const success = new Set(successTypeIds);
  const failure = new Set(failureTypeIds);
  let run = 0;
  for (const event of events) {
    if (success.has(event.typeId)) {
      run += 1;
      if (run === count) return crossedAt(event.occurredAt);
    } else if (failure.has(event.typeId)) {
      run = 0;
    }
  }
  return null;
}

function inWindow(
  events: readonly AchievementEvent[],
  typeIds: readonly string[],
  count: number,
  window: "hour" | "day",
  clock: (at: Date) => LondonClock,
): Proof | null {
  const counts = new Map<string | number, number>();
  for (const event of ofTypes(events, typeIds)) {
    // A London clock hour is one UTC hour (londonClocks), so the hour bucket is the UTC hour.
    const key = window === "hour" ? Math.floor(event.occurredAt.getTime() / HOUR_MS) : clock(event.occurredAt).date;
    const seen = (counts.get(key) ?? 0) + 1;
    if (seen === count) return crossedAt(event.occurredAt);
    counts.set(key, seen);
  }
  return null;
}

function atLocalTime(
  events: readonly AchievementEvent[],
  rule: Extract<AchievementRule, { kind: "event_at_local_time" }>,
  clock: (at: Date) => LondonClock,
): Proof | null {
  const weekdays = rule.weekdays === undefined ? null : new Set(rule.weekdays);
  for (const event of ofTypes(events, rule.typeIds)) {
    const local = clock(event.occurredAt);
    if (local.hour < rule.fromHour || local.hour >= rule.toHour) continue;
    if (weekdays !== null && !weekdays.has(local.weekday)) continue;
    return crossedAt(event.occurredAt);
  }
  return null;
}

function consecutiveDays(
  events: readonly AchievementEvent[],
  rule: Extract<AchievementRule, { kind: "consecutive_days" }>,
  clock: (at: Date) => LondonClock,
): Proof | null {
  // The first event of each London day, in day order (the events arrive in time order).
  const firstOfDay = new Map<string, Date>();
  for (const event of ofTypes(events, rule.typeIds)) {
    const day = clock(event.occurredAt).date;
    if (!firstOfDay.has(day)) firstOfDay.set(day, event.occurredAt);
  }
  // Every run has the same length, so the run that starts first also ends first.
  for (const start of firstOfDay.keys()) {
    if (rule.startWeekday !== undefined && weekdayOf(start) !== rule.startWeekday) continue;
    let complete = true;
    for (let offset = 1; offset < rule.days && complete; offset += 1) complete = firstOfDay.has(addUtcDays(start, offset));
    if (!complete) continue;
    const reached = firstOfDay.get(addUtcDays(start, rule.days - 1));
    if (reached !== undefined) return crossedAt(reached);
  }
  return null;
}

// ── Metric rules ───────────────────────────────────────────────────────────────

type CombinedReading = Readonly<{
  observedAt: Date;
  value: number;
  // Accounts whose first stored reading is part of this one.
  newAccounts: ReadonlySet<string>;
}>;

/**
 * One metric across the project's accounts of the provider, one combined reading per UTC
 * snapshot day. A project may hold several accounts of one provider (two GitHub organizations),
 * and each account has one row per day, so each day's combined value is the sum of every account's
 * value carried forward from its last stored reading: an account without a row that day (a missed
 * sync) neither drops out of the total nor fakes a dip. The combined reading is dated to the
 * latest of the day's rows, the moment the sum was known.
 */
function combinedReadings(readings: readonly MetricReading[], metricKey: string): CombinedReading[] {
  const rows = readings
    .filter((reading) => reading.metricKey === metricKey)
    .toSorted((a, b) => a.snapshotDate.localeCompare(b.snapshotDate) || a.observedAt.getTime() - b.observedAt.getTime());
  const carried = new Map<string, number>();
  const combined: CombinedReading[] = [];
  let index = 0;
  while (index < rows.length) {
    const date = rows[index]?.snapshotDate;
    let observedAt = 0;
    const newAccounts = new Set<string>();
    for (; index < rows.length && rows[index]?.snapshotDate === date; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      if (!carried.has(row.accountId)) newAccounts.add(row.accountId);
      carried.set(row.accountId, row.value);
      observedAt = Math.max(observedAt, row.observedAt.getTime());
    }
    let value = 0;
    for (const accountValue of carried.values()) value += accountValue;
    combined.push({ observedAt: new Date(observedAt), value, newAccounts });
  }
  return combined;
}

/**
 * The first combined reading at or above `value`. The crossing counts as observed only when the
 * reading before it was below `value` and no account's first reading is part of it: an account's
 * first reading, like the very first reading, shows a level DevMacro never saw being reached, so
 * that achievement is recorded "at least" `value` instead.
 */
function metricThreshold(readings: readonly MetricReading[], metricKey: string, value: number): Proof | null {
  const combined = combinedReadings(readings, metricKey);
  const index = combined.findIndex((reading) => reading.value >= value);
  const reading = combined[index];
  if (reading === undefined) return null;
  const observed = index > 0 && reading.newAccounts.size === 0;
  return observed
    ? crossedAt(reading.observedAt)
    : { earnedAt: reading.observedAt, precision: "instant", evidence: "at_least", threshold: value };
}

/**
 * A rise of at least `gain` from one stored daily reading to the next: for each snapshot day D,
 * the sum over the accounts with a row on both D and the day before of (D's value minus the day
 * before's). `usage_snapshots` keeps one row per account, metric, and UTC `snapshot_date`, each
 * sync overwriting it, so a stored day is a UTC day and the two rows bound one UTC day: London's
 * day in winter, 01:00 to 01:00 London time in summer. Keying by snapshot date rather than by the
 * London date of `observedAt` keeps a late evening row in summer (23:xx UTC, already the next
 * London date) from being compared with the row two days back, and an account with a missed day
 * never adds two days' rise together. Accounts read on only one of the two days (one added to the
 * project) never count. Dated to the latest of D's contributing rows, the moment the rise was known.
 */
function metricDailyGain(readings: readonly MetricReading[], metricKey: string, gain: number): Proof | null {
  const byAccount = new Map<string, Map<string, MetricReading>>();
  for (const reading of readings) {
    if (reading.metricKey !== metricKey) continue;
    const days = byAccount.get(reading.accountId) ?? new Map<string, MetricReading>();
    days.set(reading.snapshotDate, reading);
    byAccount.set(reading.accountId, days);
  }
  const dates = [...new Set([...byAccount.values()].flatMap((days) => [...days.keys()]))].sort();
  for (const date of dates) {
    const before = addUtcDays(date, -1);
    let rise = 0;
    let observedAt = 0;
    let compared = false;
    for (const days of byAccount.values()) {
      const current = days.get(date);
      const previous = days.get(before);
      if (current === undefined || previous === undefined) continue;
      rise += current.value - previous.value;
      observedAt = Math.max(observedAt, current.observedAt.getTime());
      compared = true;
    }
    if (compared && rise >= gain) return crossedAt(new Date(observedAt));
  }
  return null;
}

/**
 * Daily totals (one UTC day's signups per reading), summed across accounts per day. Each day is
 * its own total, so nothing is carried forward. A total is dated to the day it counts, at 00:00
 * UTC with day precision, never to a time.
 */
function dailyTotalThreshold(
  readings: readonly MetricReading[],
  rule: Extract<AchievementRule, { kind: "daily_total_threshold" }>,
): Proof | null {
  // The day a reading counts is its period's (PostHog stores yesterday's total in today's row).
  const latest = new Map<string, MetricReading & Readonly<{ day: string }>>();
  for (const reading of readings) {
    if (reading.metricKey !== rule.metricKey) continue;
    const day = reading.periodStart === null ? reading.snapshotDate : utcDate(reading.periodStart);
    const key = `${reading.accountId} ${day}`;
    const known = latest.get(key);
    if (known === undefined || known.observedAt.getTime() <= reading.observedAt.getTime()) latest.set(key, { ...reading, day });
  }
  const totals = new Map<string, number>();
  for (const reading of latest.values()) totals.set(reading.day, (totals.get(reading.day) ?? 0) + reading.value);

  let sum = 0;
  for (const day of [...totals.keys()].sort()) {
    const total = totals.get(day) ?? 0;
    sum = rule.sum === "cumulative" ? sum + total : total;
    if (sum >= rule.value) {
      return { earnedAt: new Date(`${day}T00:00:00.000Z`), precision: "day", evidence: "crossed", threshold: null };
    }
  }
  return null;
}

// ── Evaluation ─────────────────────────────────────────────────────────────────

function prove(rule: AchievementRule, input: EvaluationInput, clock: (at: Date) => LondonClock): Proof | null {
  switch (rule.kind) {
    case "event_count":
      return nthEvent(input.events, rule.typeIds, rule.count);
    case "event_streak":
      return streak(input.events, rule.successTypeIds, rule.failureTypeIds, rule.count);
    case "events_in_window":
      return inWindow(input.events, rule.typeIds, rule.count, rule.window, clock);
    case "event_at_local_time":
      return atLocalTime(input.events, rule, clock);
    case "consecutive_days":
      return consecutiveDays(input.events, rule, clock);
    case "metric_threshold":
      return metricThreshold(input.readings, rule.metricKey, rule.value);
    case "daily_total_threshold":
      return dailyTotalThreshold(input.readings, rule);
    case "metric_daily_gain":
      return metricDailyGain(input.readings, rule.metricKey, rule.gain);
  }
}

/** The achievements not yet earned that the stored evidence proves, in definition order. */
export function evaluateAchievements(input: EvaluationInput): EarnedAchievement[] {
  const clock = londonClocks();
  const earned: EarnedAchievement[] = [];
  for (const achievement of input.achievements) {
    if (input.earnedIds.has(achievement.id)) continue;
    const proof = prove(achievement.rule, input, clock);
    if (proof === null) continue;
    earned.push({
      achievementId: achievement.id,
      title: achievement.title,
      publicTitle: achievement.publicTitle,
      description: achievement.description,
      earnedAt: proof.earnedAt,
      earnedPrecision: proof.precision,
      evidence: proof.evidence,
      threshold: proof.threshold,
    });
  }
  return earned;
}
