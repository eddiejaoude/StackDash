/**
 * The dashboard's activity heatmap (#414): events per weekday and hour of day over the last four
 * weeks, on a five step color scale, with the busiest run of hours outlined and named. Pure: no
 * I/O and no clock; the caller passes `now` and the counts the database returned.
 *
 * Rules decided here, once:
 * - Weekday and hour are London's (`TIMELINE_TIME_ZONE`), counted by `occurred_at` in the database
 *   (`activity_heatmap`), so a cell agrees with the times the timeline shows.
 * - The window is whole weeks, so every cell is sampled the same number of times (decided on #414).
 * - The filter groups are derived from the event types the adapters declare, never listed by hand:
 *   deploys and signups are the adapters' own categories (`typeIdsOfCategory`, as the headline
 *   strip counts them), and failures are critical events plus every known type whose id ends in
 *   `failed` or `crashed`.
 * - The scale ranks the distinct non-zero counts (`heatSteps`), so one spike takes the top step
 *   alone instead of pushing every other cell down to the first.
 */
import { typeIdsOfCategory, type EventSeverity, type EventType } from "@/lib/adapters/events";

export const HEAT_FILTERS = ["all", "deploys", "signups", "failures"] as const;

export type HeatFilter = (typeof HEAT_FILTERS)[number];

/**
 * How far back the heatmap counts, in days. Whole weeks: with 30 days, two weekdays would be
 * sampled five times and the rest four, so even activity would read as a peak on those two.
 */
export const HEATMAP_DAYS = 28;

const DAY_MS = 86_400_000;

/** The first instant the heatmap counts: exactly `HEATMAP_DAYS` days before `now`. */
export function heatmapWindowStart(now: Date): string {
  return new Date(now.getTime() - HEATMAP_DAYS * DAY_MS).toISOString();
}

/** An event type the app knows: an adapter's declaration, or one of StackDash's own ids, which have no category. */
export type KnownEventType = Readonly<Pick<EventType, "id" | "category">>;

/**
 * What the database counts for a filter. `every` counts all events; `some` counts events whose type
 * is listed or whose severity is, which is how `activity_heatmap` reads its two lists. Two kinds,
 * so a group that matched no known type can never turn into "every event".
 */
export type HeatMatch =
  | Readonly<{ kind: "every" }>
  | Readonly<{ kind: "some"; typeIds: readonly string[]; severities: readonly EventSeverity[] }>;

// The last segment of the id ends in "failed" or "crashed": `vercel.deployment.failed`,
// `stripe.charge.failed`, `digitalocean.droplet.action_failed`, `stackdash.sync_failed`, and
// `railway.deployment.crashed`, which is only critical in production.
const FAILED_TYPE_ID = /(failed|crashed)$/;

export function heatMatch(filter: HeatFilter, known: readonly KnownEventType[]): HeatMatch {
  switch (filter) {
    case "all":
      return { kind: "every" };
    case "deploys":
      return { kind: "some", typeIds: typeIdsOfCategory(known, ["deploy_succeeded", "deploy_failed"]), severities: [] };
    case "signups":
      return { kind: "some", typeIds: typeIdsOfCategory(known, ["signup"]), severities: [] };
    case "failures":
      return {
        kind: "some",
        typeIds: [...new Set(known.filter((type) => FAILED_TYPE_ID.test(type.id)).map((type) => type.id))],
        severities: ["critical"],
      };
  }
}

/** The noun a filter's empty state uses: "No deploy events in the last 28 days". */
const FILTER_NOUNS: Readonly<Record<HeatFilter, string>> = {
  all: "events",
  deploys: "deploy events",
  signups: "signup events",
  failures: "failure events",
};

export function heatEmptyLabel(filter: HeatFilter): string {
  return `No ${FILTER_NOUNS[filter]} in the last ${HEATMAP_DAYS} days`;
}

// The grid.

/** Row order and labels: ISO weekdays 1 (Monday) to 7 (Sunday). */
export const HEAT_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const HEAT_DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;
export const HOURS_PER_DAY = 24;

/** One `activity_heatmap` row: `isodow` 1 to 7, `hour` 0 to 23. */
export type HeatCountRow = Readonly<{ isodow: number; hour: number; events: number }>;

/** Counts by day (0 is Monday) then hour; every cell present, zero when nothing happened. */
export type HeatGrid = readonly (readonly number[])[];

export function heatGrid(rows: readonly HeatCountRow[]): HeatGrid {
  const grid = HEAT_DAYS.map(() => Array.from({ length: HOURS_PER_DAY }, () => 0));
  for (const { isodow, hour, events } of rows) {
    const day = grid[isodow - 1];
    if (day === undefined || !Number.isInteger(hour) || hour < 0 || hour >= HOURS_PER_DAY) {
      throw new Error(`Heatmap row out of range: isodow ${isodow}, hour ${hour}`);
    }
    day[hour] = (day[hour] ?? 0) + events;
  }
  return grid;
}

// The scale.

export const HEAT_STEPS = [0, 1, 2, 3, 4] as const;

export type HeatStep = (typeof HEAT_STEPS)[number];

const TOP_STEP = 4;

/**
 * Each cell's step on the five step scale. Zero is step 0. Every distinct non-zero count is ranked,
 * lowest first, and the ranks are spread evenly over steps 1 to 4: the lowest count is step 1 and
 * the highest is step 4, so the busiest cell always reaches the top and one spike takes only the top
 * rank. Equal counts always share a step, and a higher count never gets a lower step. When every
 * non-zero cell holds the same count, each of them is the busiest, so all are step 4.
 */
export function heatSteps(grid: HeatGrid): HeatStep[][] {
  const distinct = [...new Set(grid.flat().filter((count) => count > 0))].sort((a, b) => a - b);
  const rank = new Map(distinct.map((count, index) => [count, index]));
  const last = distinct.length - 1;
  const stepOf = (count: number): HeatStep => {
    const index = rank.get(count);
    if (index === undefined) return 0;
    if (last === 0) return TOP_STEP;
    const spread = 1 + Math.round((3 * index) / last);
    return HEAT_STEPS.find((step) => step === spread) ?? 0;
  };
  return grid.map((day) => day.map(stepOf));
}

// The peak.

/** Hours `startHour` up to but not including `endHour` on one day (0 is Monday). */
export type HeatRun = Readonly<{
  day: number;
  startHour: number;
  endHour: number;
  events: number;
  /** Other runs with exactly as many events. */
  tiedWith: number;
}>;

/**
 * The busiest contiguous run: adjacent hours on the same day that are all on the top step present,
 * the one holding the most events. Runs never wrap past midnight into the next day's row. On a tie
 * the earliest (Monday first, then the earliest hour) is returned and `tiedWith` counts the rest,
 * so the sentence can say so rather than crown one of equals. null when there are no events.
 */
export function peakRun(grid: HeatGrid, steps: readonly (readonly HeatStep[])[]): HeatRun | null {
  const top = Math.max(0, ...steps.flat());
  if (top === 0) return null;
  const runs: Omit<HeatRun, "tiedWith">[] = [];
  steps.forEach((daySteps, day) => {
    let start: number | null = null;
    for (let hour = 0; hour <= HOURS_PER_DAY; hour += 1) {
      const onTop = hour < HOURS_PER_DAY && daySteps[hour] === top;
      if (onTop && start === null) start = hour;
      if (!onTop && start !== null) {
        const counts = grid[day]?.slice(start, hour) ?? [];
        runs.push({ day, startHour: start, endHour: hour, events: counts.reduce((sum, count) => sum + count, 0) });
        start = null;
      }
    }
  });
  const most = Math.max(...runs.map((run) => run.events));
  const tied = runs.filter((run) => run.events === most);
  const [first] = tied;
  return first === undefined ? null : { ...first, tiedWith: tied.length - 1 };
}

export function isInRun(run: HeatRun | null, day: number, hour: number): boolean {
  return run !== null && run.day === day && hour >= run.startHour && hour < run.endHour;
}

// Wording.

const COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** "1 event", "1,204 events". */
export function eventCountLabel(events: number): string {
  return `${COUNT_FORMAT.format(events)} ${events === 1 ? "event" : "events"}`;
}

/** "15:00"; the end of the day is "24:00", so a run ending at midnight stays on its own day. */
export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

/** "Fri 15:00, 42 events": what one cell says to hover and to assistive tech. */
export function heatCellLabel(day: number, hour: number, events: number): string {
  return `${HEAT_DAYS[day] ?? ""} ${hourLabel(hour)}, ${eventCountLabel(events)}`;
}

/** "Fri 15:00 to 17:00 · 42 events", with ", tied with 2 other runs" when others hold as many. */
export function peakRunLabel(run: HeatRun): string {
  const ties = run.tiedWith === 0 ? "" : `, tied with ${run.tiedWith} other ${run.tiedWith === 1 ? "run" : "runs"}`;
  return `${HEAT_DAYS[run.day] ?? ""} ${hourLabel(run.startHour)} to ${hourLabel(run.endHour)} · ${eventCountLabel(run.events)}${ties}`;
}
