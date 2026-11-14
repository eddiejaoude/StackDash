import { z } from "zod";

import { AdapterScopedKeySchema } from "./types";

/**
 * Achievements an adapter declares beside its `eventTypes` (#413). Each one has one rule from a
 * closed set, so an adapter composes rules instead of writing evaluation code. The evaluator
 * (`src/lib/achievements/evaluate.ts`) reads only stored evidence: an adapter's events in
 * `activity_events` and its metric readings in `usage_snapshots`.
 *
 * Every day and hour here is a calendar day or a clock hour in Europe/London
 * (`TIMELINE_TIME_ZONE`, the activity heatmap's zone), never a rolling window: "10 deployments in
 * one day" means 10 on one date. Decided by Eddie on #413, 2026-11-14.
 */

/** Longest title a card and an SVG badge can hold on one line without truncation. */
export const ACHIEVEMENT_TITLE_MAX = 80;

export const WeekdaySchema = z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
export type Weekday = z.infer<typeof WeekdaySchema>;

const PositiveCount = z.number().int().positive();
const TypeIds = z.array(AdapterScopedKeySchema).min(1);

export const AchievementRuleSchema = z.discriminatedUnion("kind", [
  // The `count`th recorded event of any of `typeIds`, dated to that event.
  z.strictObject({ kind: z.literal("event_count"), typeIds: TypeIds, count: PositiveCount }),
  // The first stored reading of `metricKey` at or above `value`. When no earlier reading below
  // `value` is stored, the achievement is earned with "at least" evidence: DevMacro saw the value,
  // not the crossing.
  z.strictObject({ kind: z.literal("metric_threshold"), metricKey: AdapterScopedKeySchema, value: PositiveCount }),
  // `count` events of `successTypeIds` in a row, ordered by time, with no event of
  // `failureTypeIds` between them. Dated to the event that completes the run.
  z.strictObject({
    kind: z.literal("event_streak"),
    successTypeIds: TypeIds,
    failureTypeIds: TypeIds,
    count: PositiveCount,
  }),
  // `count` events of `typeIds` within one London calendar day or clock hour. Dated to the event
  // that reached the count.
  z.strictObject({
    kind: z.literal("events_in_window"),
    typeIds: TypeIds,
    count: PositiveCount,
    window: z.enum(["hour", "day"]),
  }),
  // An event of `typeIds` whose London local time is in [fromHour, toHour), on one of `weekdays`
  // when given. `toHour` 24 means midnight at the end of the day.
  z
    .strictObject({
      kind: z.literal("event_at_local_time"),
      typeIds: TypeIds,
      fromHour: z.number().int().min(0).max(23),
      toHour: z.number().int().min(1).max(24),
      weekdays: z.array(WeekdaySchema).min(1).optional(),
    })
    .refine((rule) => rule.fromHour < rule.toHour, { message: "fromHour must be before toHour", path: ["toHour"] }),
  // Events of `typeIds` on `days` consecutive London calendar days. With `startWeekday`, the run
  // must begin on that weekday (Saturday then Sunday for a weekend). Dated to the first event on
  // the last day of the run.
  z.strictObject({
    kind: z.literal("consecutive_days"),
    typeIds: TypeIds,
    days: PositiveCount,
    startWeekday: WeekdaySchema.optional(),
  }),
  // A usage metric whose readings are one day's total each (`ProviderAdapter.signupDailyTotals`,
  // one whole UTC day per reading). `cumulative` sums the days in order; `single_day` needs one
  // day's total at or above `value`. Dated to the reading's own day, never to a time.
  z.strictObject({
    kind: z.literal("daily_total_threshold"),
    metricKey: AdapterScopedKeySchema,
    value: PositiveCount,
    sum: z.enum(["cumulative", "single_day"]),
  }),
  // `metricKey` rising by at least `gain` within one London calendar day: the day's last reading
  // minus the previous day's last reading. Needs both readings stored. Dated to the first reading
  // that showed the gain.
  z.strictObject({ kind: z.literal("metric_daily_gain"), metricKey: AdapterScopedKeySchema, gain: PositiveCount }),
]);

const Title = z.string().trim().min(1).max(ACHIEVEMENT_TITLE_MAX);

export const AchievementSchema = z.strictObject({
  // Adapter-scoped and stable (`vercel.deployments.10`): stored on every earned row, so renaming one
  // orphans what projects already earned.
  id: AdapterScopedKeySchema,
  // Shown to workspace members: in the Achievements section and on the timeline.
  title: Title,
  // Shown on public pages, cards, share text, and badges once published. Never names an account,
  // a repository, or an amount.
  publicTitle: Title,
  // One sentence on how it is earned, shown beside it to members.
  description: z.string().trim().min(1).max(200),
  rule: AchievementRuleSchema,
});

export type AchievementRule = z.infer<typeof AchievementRuleSchema>;
export type AchievementRuleKind = AchievementRule["kind"];
export type Achievement = z.infer<typeof AchievementSchema>;

/** Every event type id a rule reads. */
export function achievementRuleTypeIds(rule: AchievementRule): string[] {
  switch (rule.kind) {
    case "event_count":
    case "events_in_window":
    case "event_at_local_time":
    case "consecutive_days":
      return [...rule.typeIds];
    case "event_streak":
      return [...rule.successTypeIds, ...rule.failureTypeIds];
    case "metric_threshold":
    case "daily_total_threshold":
    case "metric_daily_gain":
      return [];
  }
}

/** The metric key a rule reads, if it reads one. */
export function achievementRuleMetricKey(rule: AchievementRule): string | undefined {
  switch (rule.kind) {
    case "metric_threshold":
    case "daily_total_threshold":
    case "metric_daily_gain":
      return rule.metricKey;
    default:
      return undefined;
  }
}
