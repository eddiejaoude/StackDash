/**
 * Pure reductions for the dashboard's headline strip (#173): revenue against spend, signups, cost
 * per signup, and deploys over one common UTC window, each against the same days of the window
 * before. No I/O and no clock: the caller passes `now`. Kept apart from the billing period
 * reductions in `aggregate.ts`, because this strip deliberately ignores each provider's own period.
 *
 * Rules decided here, once:
 * - A window is the UTC calendar week (Monday first, ISO 8601) or month, to date. The previous
 *   window covers the same number of days from its own start, cut at its last day, so a part week
 *   is never compared with a whole one.
 * - Money comes from the daily snapshots of running billing period totals. A day's amount is the
 *   change in a running total since the previous reading of the same period; the first reading of
 *   a period counts everything since the period started. A change that spans a window edge cannot
 *   be split, so it makes its connection unavailable for that window instead of counting a part.
 *   A total read after its period ended (an invoice) is not a running total and does not count,
 *   and neither does an estimate its adapter declares a projection of the whole period
 *   (`isDeclaredProjection`, the rule every reading of spend shares), on any day it is read.
 * - A connection is available for a figure in a window only when every series it reports covers
 *   every day of the window up to the last required day (yesterday for the current window, since
 *   today is still running). Otherwise it is named unavailable and none of its amounts count.
 * - Money is grouped by currency and never converted. Verified and estimated amounts stay apart,
 *   in revenue minus spend and in cost per signup too.
 * - Signups and deploys are counts of synced events of the types adapters declare in that
 *   category. A connection counts in a window when it had reported by the window's first day (its
 *   oldest reading, read on its own) and has synced since the start of the last required day.
 * - A provider that reports signups only as one total per UTC day (PostHog) declares the usage
 *   metric holding it, and its signups are the sum of those daily readings. A day's total exists
 *   once the day has ended, so such a provider counts the current window's whole days, up to
 *   yesterday, and the same number of days of the previous window. Every one of those days needs
 *   a reading, or the provider is unavailable for the window.
 * - A comparison needs every connection behind the current figure to be available in the previous
 *   window as well, and the previous figure is taken over those same connections.
 * - When no figure can be reported for the window to date because a connection in view has not
 *   synced since its last required day (stale, #267), the strip shows the last complete week or
 *   month instead: the newest one that ended before the day of the newest of those stale syncs,
 *   against the whole one before it. When that has no figure either, one explanation replaces the
 *   figures, never six "Unavailable" cards. Without a stale connection the strip keeps its reasons.
 */
import { typeIdsOfCategory, type EventType } from "@/lib/adapters/events";
import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { formatList, formatMoney, formatQuantity } from "@/lib/format";
import { divideMinorUnits } from "@/lib/money";
import { providerName } from "@/lib/providers";

import {
  dropSubWindows,
  dropSupersededBreakdowns,
  isDeclaredProjection,
  isEstimated,
  type ConnectionInput,
  type SnapshotInput,
} from "./aggregate";
import { compareValues, type TrendComparison } from "./trends";

export const HEADLINE_WINDOW_KINDS = ["week", "month"] as const;
export type HeadlineWindowKind = (typeof HEADLINE_WINDOW_KINDS)[number];

const DAY_MS = 86_400_000;

/** UTC dates, `YYYY-MM-DD`, both ends inclusive. */
export type DateRange = Readonly<{ start: string; end: string }>;

/** The kind of window, and whether it is a whole one that has ended rather than the window to date. */
export type HeadlineWindowLabel = Readonly<{ kind: HeadlineWindowKind; complete: boolean }>;

export type HeadlineWindows = HeadlineWindowLabel &
  Readonly<{
    current: DateRange;
    previous: DateRange;
  }>;

/**
 * A window plus the last day every source must have reported for it to be complete, and the last
 * day a source that reports whole UTC days counts (before `start` when there is none).
 */
type WindowSpec = DateRange & Readonly<{ requiredEnd: string; wholeDaysEnd: string }>;

/**
 * What the strip counts, as the adapters declare it, so a new provider's signups and deploys count
 * without a list here: the event type ids of each category (`EventType.category`), and the usage
 * metric keys that hold a day's signups (`ProviderAdapter.signupDailyTotals`). The provider is the
 * id's or key's prefix. `deploys` holds every outcome; `failedDeploys` the failed ones among them.
 */
export type HeadlineEventTypes = Readonly<{
  signups: readonly string[];
  deploys: readonly string[];
  failedDeploys: readonly string[];
  signupDailyTotals: readonly string[];
}>;

export function headlineEventTypes(declared: readonly EventType[], signupDailyTotals: readonly string[]): HeadlineEventTypes {
  return {
    signups: typeIdsOfCategory(declared, ["signup"]),
    deploys: typeIdsOfCategory(declared, ["deploy_succeeded", "deploy_failed"]),
    failedDeploys: typeIdsOfCategory(declared, ["deploy_failed"]),
    signupDailyTotals,
  };
}

/** Events of one type from one connection within one window. */
export type EventCount = Readonly<{ connection_id: string; type_id: string; events: number }>;

/**
 * What the event figures read, for the included accounts in scope: counts per window, and each
 * connection's oldest reading on or before the current window's first day (UTC date), read on its
 * own so a truncated snapshot history cannot move it. No entry means no reading by then.
 */
export type HeadlineEvents = Readonly<{
  current: readonly EventCount[];
  previous: readonly EventCount[];
  firstReadings: ReadonlyMap<string, string>;
}>;

function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function dayStart(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

function addDays(date: string, days: number): string {
  return isoDate(dayStart(date) + days * DAY_MS);
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

/** Every UTC date from `from` to `to`, both inclusive; none when `to` is before `from`. */
function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) out.push(date);
  return out;
}

/** The current window to date and the same days of the window before it, in UTC. */
export function headlineWindows(kind: HeadlineWindowKind, now: Date): HeadlineWindows {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (kind === "week") {
    const sinceMonday = (now.getUTCDay() + 6) % 7;
    const start = today - sinceMonday * DAY_MS;
    const previousStart = start - 7 * DAY_MS;
    return {
      kind,
      complete: false,
      current: { start: isoDate(start), end: isoDate(today) },
      previous: { start: isoDate(previousStart), end: isoDate(previousStart + sinceMonday * DAY_MS) },
    };
  }
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const previousStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  return {
    kind,
    complete: false,
    current: { start: isoDate(start), end: isoDate(today) },
    // A shorter month ends first: 2026-03-31 compares with all of February.
    previous: { start: isoDate(previousStart), end: isoDate(Math.min(previousStart + (today - start), start - DAY_MS)) },
  };
}

/**
 * The last whole UTC week (Monday to Sunday) or month that ended on or before `through`, against
 * the whole one before it. Whole months differ in length, so October compares with all of September.
 */
function lastCompleteWindows(kind: HeadlineWindowKind, through: string): HeadlineWindows {
  const day = new Date(dayStart(through));
  if (kind === "week") {
    const end = addDays(through, -day.getUTCDay());
    const start = addDays(end, -6);
    return { kind, complete: true, current: { start, end }, previous: { start: addDays(start, -7), end: addDays(end, -7) } };
  }
  const monthEnds = addDays(through, 1).endsWith("-01");
  const end = monthEnds ? through : isoDate(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1) - DAY_MS);
  const start = `${end.slice(0, 7)}-01`;
  return { kind, complete: true, current: { start, end }, previous: { start: `${addDays(start, -1).slice(0, 7)}-01`, end: addDays(start, -1) } };
}

/**
 * The windows to show when the window to date has no figure because its data is stale (#267): the
 * last whole week or month that ended before the day of the newest sync among the connections in
 * view that have not synced since the window's last required day began (the test `eventsOf` applies),
 * so every day of it had been read, and never after yesterday. Null when the strip has a figure, or
 * when no connection in view is stale that way: a strip whose providers report none of its kinds,
 * or one connected too recently, keeps its own reasons and costs no second read. A disconnected
 * connection is never stale here, as in the dashboard's stale notice: no sync brings it up to date.
 */
export function fallbackWindows(strip: HeadlineStrip, connections: readonly ConnectionInput[], now: Date): HeadlineWindows | null {
  if (hasFigure(strip)) return null;
  const requiredFrom = dayStart(windowSpecs(strip.windows).current.requiredEnd);
  const staleSyncs = connections.flatMap((connection) => {
    if (connection.last_synced_at === null || connection.status === "revoked") return [];
    const syncedAt = Date.parse(connection.last_synced_at);
    return syncedAt < requiredFrom ? [syncedAt] : [];
  });
  if (staleSyncs.length === 0) return null;
  const yesterday = addDays(isoDate(now.getTime()), -1);
  const beforeSyncDay = addDays(isoDate(Math.max(...staleSyncs)), -1);
  return lastCompleteWindows(strip.windows.kind, beforeSyncDay < yesterday ? beforeSyncDay : yesterday);
}

/**
 * Today is still running, so the current window must be complete up to yesterday (or its first
 * day). A daily total exists only once its day has ended, so a source that reports whole days
 * counts the current window up to yesterday and the previous window over as many days. A window
 * that has ended must be complete to its last day, and so must the one before it.
 */
function windowSpecs(windows: HeadlineWindows): Readonly<{ current: WindowSpec; previous: WindowSpec }> {
  const previousWhole: WindowSpec = { ...windows.previous, requiredEnd: windows.previous.end, wholeDaysEnd: windows.previous.end };
  if (windows.complete) {
    return { current: { ...windows.current, requiredEnd: windows.current.end, wholeDaysEnd: windows.current.end }, previous: previousWhole };
  }
  const wholeDays = (dayStart(windows.current.end) - dayStart(windows.current.start)) / DAY_MS;
  const previousWholeDaysEnd = addDays(windows.previous.start, wholeDays - 1);
  return {
    current: {
      ...windows.current,
      requiredEnd: maxDate(windows.current.start, addDays(windows.current.end, -1)),
      wholeDaysEnd: addDays(windows.current.end, -1),
    },
    previous: {
      ...previousWhole,
      // A shorter previous month ends before as many days have passed.
      wholeDaysEnd: previousWholeDaysEnd < windows.previous.end ? previousWholeDaysEnd : windows.previous.end,
    },
  };
}

// Money: running totals to daily amounts.

type MoneyMeasure = "revenue" | "spend";

function moneyMeasure(kind: SnapshotInput["kind"]): MoneyMeasure | null {
  if (kind === "revenue") return "revenue";
  if (kind === "verified_spend" || kind === "estimated_spend") return "spend";
  return null;
}

/**
 * A row of a running total over a period that starts on a UTC day boundary and was still open
 * when it was read, as `isCurrentPeriod` decides for the dashboard's current values.
 */
function isRunningTotal(row: SnapshotInput): boolean {
  if (moneyMeasure(row.kind) === null || row.currency === null || row.amount_minor === null) return false;
  if (row.period_start === null || row.period_end === null) return false;
  // A period that had ended when it was read is a final total, such as DigitalOcean's last
  // invoice or one day's estimated spend read the next day, not a total still running.
  if (Date.parse(row.period_end) < Date.parse(row.retrieved_at)) return false;
  // Rolling windows such as Stripe's last 30 days start at an arbitrary instant and are skipped.
  return Date.parse(row.period_start) % DAY_MS === 0;
}

/** Money that accrued over the UTC days `from` to `to`, both inclusive. */
type Increment = Readonly<{ from: string; to: string; amountMinor: number }>;

type MoneySeries = Readonly<{
  connectionId: string;
  measure: MoneyMeasure;
  currency: string;
  estimated: boolean;
  increments: readonly Increment[];
  /** The first UTC day of every period read, so a last complete month is checked against its own. */
  periodStarts: ReadonlySet<string>;
}>;

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return groups;
}

function buildMoneySeries(rows: readonly SnapshotInput[], projectedSpend: readonly string[]): MoneySeries[] {
  const seriesKey = (row: SnapshotInput) => `${row.connection_id} ${row.external_account_id} ${row.kind} ${row.metric_key} ${row.currency ?? ""}`;
  // A declared projection is left out (`isDeclaredProjection`) before a projection's long window
  // could hide a day's estimate inside it.
  const spent = rows.filter((row) => isRunningTotal(row) && !isDeclaredProjection(row, projectedSpend));
  const byDay = groupBy(spent, (row) => row.snapshot_date);
  // Each day's amounts once, by the rules of the dashboard's current values (`countedSnapshots`):
  // a total supersedes its breakdowns, and a longer window supersedes a day inside it, such as
  // GitHub's daily spend inside its month.
  const counted = [...byDay.values()].flatMap((day) => dropSubWindows(dropSupersededBreakdowns(day)));
  const bySeries = groupBy(counted, seriesKey);
  const series: MoneySeries[] = [];
  for (const list of bySeries.values()) {
    list.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const increments: Increment[] = [];
    let previous: SnapshotInput | undefined;
    for (const row of list) {
      const amountMinor = row.amount_minor ?? 0;
      const periodStart = Date.parse(row.period_start ?? "");
      const periodFirstDay = isoDate(periodStart);
      if (previous !== undefined && Date.parse(previous.period_start ?? "") === periodStart) {
        increments.push({
          from: addDays(previous.snapshot_date, 1),
          to: row.snapshot_date,
          amountMinor: amountMinor - (previous.amount_minor ?? 0),
        });
      } else if (periodFirstDay <= row.snapshot_date) {
        increments.push({ from: periodFirstDay, to: row.snapshot_date, amountMinor });
      } else {
        // Read before its period started: nothing has accrued yet.
        continue;
      }
      previous = row;
    }
    const first = list[0];
    const measure = first === undefined ? null : moneyMeasure(first.kind);
    if (first === undefined || measure === null || increments.length === 0) continue;
    series.push({
      connectionId: first.connection_id,
      measure,
      currency: first.currency ?? "",
      estimated: isEstimated(first),
      increments,
      periodStarts: new Set(list.map((row) => isoDate(Date.parse(row.period_start ?? "")))),
    });
  }
  return series;
}

type SeriesInWindow =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "incomplete" }>
  | Readonly<{ status: "complete"; amountMinor: number }>;

/**
 * A series in one window. Absent when it started after the window or stopped before it; incomplete
 * when an amount spans a window edge or a required day has no reading.
 */
function seriesInWindow(series: MoneySeries, window: WindowSpec): SeriesInWindow {
  const first = series.increments.reduce((min, { from }) => (from < min ? from : min), series.increments[0]?.from ?? "");
  const last = series.increments.reduce((max, { to }) => (to > max ? to : max), "");
  if (first > window.end || last < addDays(window.start, -1)) return { status: "absent" };
  let amountMinor = 0;
  const inside: Increment[] = [];
  for (const increment of series.increments) {
    if (increment.to < window.start || increment.from > window.end) continue;
    if (increment.from < window.start || increment.to > window.end) return { status: "incomplete" };
    amountMinor += increment.amountMinor;
    inside.push(increment);
  }
  let next = maxDate(window.start, first);
  for (const increment of inside.sort((a, b) => a.from.localeCompare(b.from))) {
    if (increment.from > next) break;
    if (increment.to >= next) next = addDays(increment.to, 1);
  }
  return next <= window.requiredEnd ? { status: "incomplete" } : { status: "complete", amountMinor };
}

/** Amounts per currency and provenance, keyed `USD verified` or `USD estimated`. */
type Totals = Map<string, number>;

const totalsKey = (currency: string, estimated: boolean) => `${currency} ${estimated ? "estimated" : "verified"}`;

function addTotals(into: Totals, from: Totals, sign = 1): void {
  for (const [key, amount] of from) into.set(key, (into.get(key) ?? 0) + sign * amount);
}

/** One connection's amounts for one measure in one window, or null when it is unavailable. */
function moneySource(series: readonly MoneySeries[], window: WindowSpec): Totals | null {
  const totals: Totals = new Map();
  let reported = false;
  for (const entry of series) {
    const result = seriesInWindow(entry, window);
    if (result.status === "incomplete") return null;
    if (result.status === "absent") continue;
    reported = true;
    const key = totalsKey(entry.currency, entry.estimated);
    totals.set(key, (totals.get(key) ?? 0) + result.amountMinor);
  }
  return reported ? totals : null;
}

// Signups reported as one total per UTC day.

/** One account's readings of one daily total metric: the total for each UTC day, keyed by the day. */
type DailySeries = ReadonlyMap<string, number>;

/** A `usage` reading of a declared daily total whose period is exactly one UTC day. */
function isDailyTotal(row: SnapshotInput, metricKeys: readonly string[]): boolean {
  if (row.kind !== "usage" || row.value === null || !metricKeys.includes(row.metric_key)) return false;
  if (row.period_start === null || row.period_end === null) return false;
  const start = Date.parse(row.period_start);
  return start % DAY_MS === 0 && Date.parse(row.period_end) - start === DAY_MS;
}

/** Each connection's daily total series, one per account and metric; a later reading of a day wins. */
function buildDailySeries(rows: readonly SnapshotInput[], metricKeys: readonly string[]): Map<string, DailySeries[]> {
  const byConnection = new Map<string, DailySeries[]>();
  const totals = rows.filter((row) => isDailyTotal(row, metricKeys));
  for (const list of groupBy(totals, (row) => `${row.connection_id} ${row.external_account_id} ${row.metric_key}`).values()) {
    list.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    const days = new Map(list.map((row) => [isoDate(Date.parse(row.period_start ?? "")), row.value ?? 0]));
    const connectionId = list[0]?.connection_id ?? "";
    byConnection.set(connectionId, [...(byConnection.get(connectionId) ?? []), days]);
  }
  return byConnection;
}

/**
 * One connection's signups over the window's whole days, or null when it is unavailable: the
 * window has no whole day yet, or a series misses one of the days. A series that stopped before
 * the window or started after its last whole day is absent, as a money series is.
 */
function dailyTotalsInWindow(series: readonly DailySeries[], window: WindowSpec): number | null {
  const days = datesBetween(window.start, window.wholeDaysEnd);
  if (days.length === 0) return null;
  let total = 0;
  let reported = false;
  for (const entry of series) {
    const known = [...entry.keys()].sort();
    const first = known[0];
    const last = known.at(-1);
    if (first === undefined || last === undefined || first > window.wholeDaysEnd || last < window.start) continue;
    reported = true;
    for (const day of days) {
      const value = entry.get(day);
      if (value === undefined) return null;
      total += value;
    }
  }
  return reported ? total : null;
}

// Figures.

export type FigureValue = Readonly<{ value: number; comparison: TrendComparison }>;

/** One currency. Verified and estimated are never added together; null when there is none. */
export type MoneyLine = Readonly<{ currency: string; verified: FigureValue | null; estimated: FigureValue | null }>;

export type FigureSources = Readonly<{
  /** Provider names behind the current value. */
  included: readonly string[];
  /** Provider names that could not report the window; never counted as zero. */
  unavailable: readonly string[];
  /** Provider names behind the current value with no complete previous window, so no comparison. */
  previousUnavailable: readonly string[];
}>;

/** `lines` is null when no source could report the window. */
export type MoneyFigure = FigureSources & Readonly<{ lines: readonly MoneyLine[] | null }>;

/** `value` is null when no source could report the window. */
export type CountFigure = FigureSources & Readonly<{ value: FigureValue | null }>;

export type DeploysFigure = CountFigure & Readonly<{ failed: number | null }>;

/** `wholeDays`: the signup sources that report whole UTC days, so today is not in their count. */
export type SignupsFigure = CountFigure & Readonly<{ wholeDays: readonly string[] }>;

/**
 * Revenue minus spend, per currency and provenance. `lines` is null unless both revenue and spend
 * have a source; the providers left out on each side are the revenue and spend figures' own.
 */
export type NetFigure = Readonly<{
  lines: readonly MoneyLine[] | null;
  /** Providers behind either side with no complete previous window, so no comparison. */
  previousUnavailable: readonly string[];
}>;

/** The providers behind cost per signup, and the ones left out because they could not report. */
export type CostPerSignupSources = Readonly<{
  spendFrom: readonly string[];
  signupsFrom: readonly string[];
  spendUnavailable: readonly string[];
  signupsUnavailable: readonly string[];
  /** Of `signupsFrom`, the ones that report whole UTC days, so today is not in their count. */
  signupsWholeDays: readonly string[];
}>;

/** Lines only when spend and signups both have a source and there was at least one signup. */
export type CostPerSignupFigure = CostPerSignupSources &
  (
    | Readonly<{ missing: null; lines: readonly MoneyLine[]; comparisonGap: ComparisonGap | null }>
    | Readonly<{ missing: "spend" | "signups" | "no_signups"; lines: null }>
  );

export type HeadlineStrip = Readonly<{
  windows: HeadlineWindows;
  revenue: MoneyFigure;
  spend: MoneyFigure;
  net: NetFigure;
  signups: SignupsFigure;
  costPerSignup: CostPerSignupFigure;
  deploys: DeploysFigure;
  /** Providers in the money figures whose own billing period is not this window. */
  otherBillingPeriods: readonly string[];
  /** True when any connection behind a figure was made by the provider simulator (#131). */
  simulated: boolean;
}>;

export type HeadlineInput = Readonly<{
  /** Snapshot history already narrowed to the scope filter, reaching back before the previous window. */
  snapshots: readonly SnapshotInput[];
  /** Connections already narrowed to the scope filter. */
  connections: readonly ConnectionInput[];
  /** Event counts and first readings, for the included accounts in scope. */
  events: HeadlineEvents;
  /** The event types and daily totals counted, from the adapters' declarations (`headlineEventTypes`). */
  eventTypes: HeadlineEventTypes;
  /** Estimated spend metric keys the adapters declare projections (`ProviderAdapter.projectedSpend`). */
  projectedSpend: readonly string[];
  /**
   * Providers whose adapters declare revenue (`capabilities.revenue`): their connections are revenue
   * sources even before their first revenue reading, so one that cannot report it is named.
   */
  revenueProviders: readonly string[];
  /**
   * Providers whose adapters declare spend (`capabilities.spending`): one with no spend for the
   * window is named as unavailable, and one that never reports spend is left out (#286).
   */
  spendProviders: readonly string[];
  /** The window to date (`headlineWindows`), or the last complete one (`fallbackWindows`). */
  windows: HeadlineWindows;
}>;

function names(connections: readonly ConnectionInput[]): string[] {
  return [...new Set(connections.map((connection) => providerName(connection.provider)))].sort((a, b) => a.localeCompare(b));
}

/** Current and previous totals for one figure, with the connections behind them. */
type Assembled = Readonly<{
  current: Totals | null;
  /** null when there is no comparison. */
  previous: Totals | null;
  included: ConnectionInput[];
  unavailable: ConnectionInput[];
  previousUnavailable: ConnectionInput[];
}>;

/** Each candidate's value in both windows; `valueOf` returns null when it cannot report one. */
function assemble(
  candidates: readonly ConnectionInput[],
  valueOf: (connection: ConnectionInput, window: WindowSpec) => Totals | null,
  specs: Readonly<{ current: WindowSpec; previous: WindowSpec }>,
): Assembled {
  const included: ConnectionInput[] = [];
  const unavailable: ConnectionInput[] = [];
  const previousUnavailable: ConnectionInput[] = [];
  const current: Totals = new Map();
  const previous: Totals = new Map();
  for (const connection of candidates) {
    const inCurrent = valueOf(connection, specs.current);
    if (inCurrent === null) {
      unavailable.push(connection);
      continue;
    }
    included.push(connection);
    addTotals(current, inCurrent);
    const inPrevious = valueOf(connection, specs.previous);
    if (inPrevious === null) previousUnavailable.push(connection);
    else addTotals(previous, inPrevious);
  }
  return {
    current: included.length === 0 ? null : current,
    previous: included.length === 0 || previousUnavailable.length > 0 ? null : previous,
    included,
    unavailable,
    previousUnavailable,
  };
}

function sourcesOf(assembled: Assembled): FigureSources {
  return {
    included: names(assembled.included),
    unavailable: names(assembled.unavailable),
    previousUnavailable: names(assembled.previousUnavailable),
  };
}

/**
 * Lines per currency, sorted by code. With a comparison, a currency or provenance on only one side
 * is zero on the other: every connection behind the figure reported both windows in full.
 */
function toLines(current: Totals, previous: Totals | null): MoneyLine[] {
  const keys = new Set([...current.keys(), ...(previous?.keys() ?? [])]);
  const currencies = [...new Set([...keys].map((key) => key.split(" ")[0] ?? ""))].sort();
  const valueFor = (currency: string, estimated: boolean): FigureValue | null => {
    const key = totalsKey(currency, estimated);
    if (!keys.has(key)) return null;
    const value = current.get(key) ?? 0;
    return { value, comparison: compareValues(value, previous === null ? null : (previous.get(key) ?? 0)) };
  };
  return currencies.map((currency) => ({ currency, verified: valueFor(currency, false), estimated: valueFor(currency, true) }));
}

function moneyFigure(assembled: Assembled): MoneyFigure {
  return { ...sourcesOf(assembled), lines: assembled.current === null ? null : toLines(assembled.current, assembled.previous) };
}

function countFigure(assembled: Assembled): CountFigure {
  const total = (totals: Totals | null) => (totals === null ? null : [...totals.values()].reduce((sum, value) => sum + value, 0));
  const current = total(assembled.current);
  return {
    ...sourcesOf(assembled),
    value: current === null ? null : { value: current, comparison: compareValues(current, total(assembled.previous)) },
  };
}

function divideTotals(totals: Totals, count: number): Totals {
  return new Map([...totals].map(([key, amount]) => [key, divideMinorUnits(amount, count)]));
}

export function buildHeadline(input: HeadlineInput): HeadlineStrip {
  const { windows } = input;
  const specs = windowSpecs(windows);
  const connections = [...input.connections].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id),
  );
  const inScope = new Set(connections.map((connection) => connection.id));
  const series = buildMoneySeries(input.snapshots.filter((row) => inScope.has(row.connection_id)), input.projectedSpend);
  const seriesOf = (connection: ConnectionInput, measure: MoneyMeasure) =>
    series.filter((entry) => entry.connectionId === connection.id && entry.measure === measure);

  // Money.
  const moneyOf = (measure: MoneyMeasure) => (connection: ConnectionInput, window: WindowSpec) =>
    moneySource(seriesOf(connection, measure), window);
  const revenueCandidates = connections.filter(
    (connection) => input.revenueProviders.includes(connection.provider) || seriesOf(connection, "revenue").length > 0,
  );
  const revenue = assemble(revenueCandidates, moneyOf("revenue"), specs);
  // Only a provider that reports spend can fail to: one that never does is left out, not named.
  const spendCandidates = connections.filter(
    (connection) => input.spendProviders.includes(connection.provider) || seriesOf(connection, "spend").length > 0,
  );
  const spend = assemble(spendCandidates, moneyOf("spend"), specs);

  // Events.
  const countsFor = (window: WindowSpec) => (window === specs.current ? input.events.current : input.events.previous);
  const eventsOf = (typeIds: readonly string[]) => (connection: ConnectionInput, window: WindowSpec) => {
    const first = input.events.firstReadings.get(connection.id);
    if (first === undefined || first > window.start) return null;
    if (connection.last_synced_at === null || Date.parse(connection.last_synced_at) < dayStart(window.requiredEnd)) return null;
    const events = countsFor(window)
      .filter((count) => count.connection_id === connection.id && typeIds.includes(count.type_id))
      .reduce((sum, count) => sum + count.events, 0);
    return new Map([["count", events]]) satisfies Totals;
  };
  const ownsAny = (typeIds: readonly string[]) => (connection: ConnectionInput) =>
    typeIds.some((typeId) => typeId.split(".")[0] === connection.provider);
  const { signups: signupTypes, deploys: deployTypes, failedDeploys: failedTypes, signupDailyTotals } = input.eventTypes;
  const countsSignupEvents = ownsAny(signupTypes);
  const reportsDailyTotals = ownsAny(signupDailyTotals);
  const dailySeries = buildDailySeries(input.snapshots.filter((row) => inScope.has(row.connection_id)), signupDailyTotals);
  // A connection's signup events and daily totals, each of which must be able to report the window.
  const signupsOf = (connection: ConnectionInput, window: WindowSpec): Totals | null => {
    let count = 0;
    if (countsSignupEvents(connection)) {
      const events = eventsOf(signupTypes)(connection, window);
      if (events === null) return null;
      count += events.get("count") ?? 0;
    }
    if (reportsDailyTotals(connection)) {
      const total = dailyTotalsInWindow(dailySeries.get(connection.id) ?? [], window);
      if (total === null) return null;
      count += total;
    }
    return new Map([["count", count]]);
  };
  const signupCandidates = connections.filter((connection) => countsSignupEvents(connection) || reportsDailyTotals(connection));
  const signups = assemble(signupCandidates, signupsOf, specs);
  const deploys = assemble(connections.filter(ownsAny(deployTypes)), eventsOf(deployTypes), specs);
  const signupsFigure: SignupsFigure = { ...countFigure(signups), wholeDays: names(signupCandidates.filter(reportsDailyTotals)) };
  const deploysFigure = countFigure(deploys);
  const failed = deploysFigure.value === null ? null : deploys.included.reduce((sum, connection) => {
    return sum + (eventsOf(failedTypes)(connection, specs.current)?.get("count") ?? 0);
  }, 0);

  // Revenue minus spend: both sides must have a source.
  const netTotals = (revenueTotals: Totals | null, spendTotals: Totals | null): Totals | null => {
    if (revenueTotals === null || spendTotals === null) return null;
    const totals: Totals = new Map();
    addTotals(totals, revenueTotals);
    addTotals(totals, spendTotals, -1);
    return totals;
  };
  const netCurrent = netTotals(revenue.current, spend.current);
  const net: NetFigure = {
    previousUnavailable: names([...revenue.previousUnavailable, ...spend.previousUnavailable]),
    lines: netCurrent === null ? null : toLines(netCurrent, netTotals(revenue.previous, spend.previous)),
  };

  // Cost per signup: spend over signups, per currency and provenance, only when both are there.
  const signupCount = signupsFigure.value?.value ?? null;
  const previousSignups = signups.previous === null ? null : (signups.previous.get("count") ?? 0);
  const costSources = {
    spendFrom: names(spend.included),
    signupsFrom: names(signups.included),
    spendUnavailable: names(spend.unavailable),
    signupsUnavailable: names(signups.unavailable),
    signupsWholeDays: names(signups.included.filter(reportsDailyTotals)),
  };
  let costPerSignup: CostPerSignupFigure;
  if (spend.current === null) costPerSignup = { ...costSources, missing: "spend", lines: null };
  else if (signupCount === null) costPerSignup = { ...costSources, missing: "signups", lines: null };
  else if (signupCount === 0) costPerSignup = { ...costSources, missing: "no_signups", lines: null };
  else {
    const unavailableBefore = names([...spend.previousUnavailable, ...signups.previousUnavailable]);
    const comparisonGap: ComparisonGap | null =
      unavailableBefore.length > 0
        ? { reason: "providers", names: unavailableBefore }
        : previousSignups === 0
          ? { reason: "no_signups" }
          : null;
    const previousCost =
      spend.previous === null || previousSignups === null || previousSignups === 0
        ? null
        : divideTotals(spend.previous, previousSignups);
    costPerSignup = {
      ...costSources,
      missing: null,
      lines: toLines(divideTotals(spend.current, signupCount), previousCost),
      comparisonGap,
    };
  }

  // A provider's billing period differs from the window unless it starts on the window's first day.
  const moneySources = [...new Set([...revenue.included, ...spend.included])];
  const otherBillingPeriods = names(
    moneySources.filter((connection) =>
      series.some(
        (entry) =>
          entry.connectionId === connection.id &&
          (windows.kind === "week" || !entry.periodStarts.has(windows.current.start)),
      ),
    ),
  );

  const behindFigures = [...revenue.included, ...spend.included, ...signups.included, ...deploys.included];
  return {
    windows,
    revenue: moneyFigure(revenue),
    spend: moneyFigure(spend),
    net,
    signups: signupsFigure,
    costPerSignup,
    deploys: { ...deploysFigure, failed },
    otherBillingPeriods,
    simulated: behindFigures.some(isSimulatedConnection),
  };
}

/** True when any figure has a value; revenue minus spend and cost per signup follow from these. */
export function hasFigure(strip: HeadlineStrip): boolean {
  return strip.revenue.lines !== null || strip.spend.lines !== null || strip.signups.value !== null || strip.deploys.value !== null;
}

/**
 * What the strip shows (#267): the window to date when it has a figure or no fallback was taken
 * (`fallbackWindows` is null), so its per-figure reasons stand; else the last complete window when
 * that has a figure; else one explanation in place of the figures.
 */
export type HeadlineView =
  | Readonly<{ status: "current"; strip: HeadlineStrip }>
  | Readonly<{ status: "fallback"; strip: HeadlineStrip; current: HeadlineWindows }>
  | Readonly<{ status: "empty"; current: HeadlineWindows }>;

export function chooseHeadline(current: HeadlineStrip, fallback: HeadlineStrip | null): HeadlineView {
  if (hasFigure(current) || fallback === null) return { status: "current", strip: current };
  if (hasFigure(fallback)) return { status: "fallback", strip: fallback, current: current.windows };
  return { status: "empty", current: current.windows };
}

// Copy. US English, sentence case, no dashes; days are UTC dates because snapshot days are.

/** The previous window in words, with the preposition and verb that go with it. */
type PreviousWords = Readonly<{ name: string; at: "on" | "in"; are: "are" | "is" }>;

const WINDOW_WORDS = {
  week: {
    title: "This week so far",
    completeTitle: "Last complete week",
    noun: "week",
    previous: { name: "the same days last week", at: "on", are: "are" },
    completePrevious: { name: "the week before", at: "in", are: "is" },
    choice: "This week",
  },
  month: {
    title: "This month so far",
    completeTitle: "Last complete month",
    noun: "month",
    previous: { name: "the same days last month", at: "on", are: "are" },
    completePrevious: { name: "the month before", at: "in", are: "is" },
    choice: "This month",
  },
} as const satisfies Record<
  HeadlineWindowKind,
  Readonly<{ title: string; completeTitle: string; noun: string; previous: PreviousWords; completePrevious: PreviousWords; choice: string }>
>;

/** "This week so far", or "Last complete week" for a window that has ended. */
export function headlineTitle(windows: HeadlineWindowLabel): string {
  const words = WINDOW_WORDS[windows.kind];
  return windows.complete ? words.completeTitle : words.title;
}

export function headlineChoiceLabel(kind: HeadlineWindowKind): string {
  return WINDOW_WORDS[kind].choice;
}

function rangeText(range: DateRange): string {
  return range.start === range.end ? range.start : `${range.start} to ${range.end}`;
}

/** "2026-11-02 to 2026-11-05 in UTC, compared with 2026-10-26 to 2026-10-29." */
export function windowDescription(windows: HeadlineWindows): string {
  return `${rangeText(windows.current)} in UTC, compared with ${rangeText(windows.previous)}.`;
}

/** Why the strip shows the last complete window: the window to date has no figure yet. */
export function headlineFallbackNote(current: HeadlineWindowLabel): string {
  const words = WINDOW_WORDS[current.kind];
  return `Nothing can be shown for ${words.title.toLowerCase()}: no connection in this view has a reading for every day of it yet. These figures are for the ${words.completeTitle.toLowerCase()} instead.`;
}

/** The one explanation in place of the figures when neither window has one. */
export function headlineEmptyNote(current: HeadlineWindowLabel): string {
  const words = WINDOW_WORDS[current.kind];
  return `Nothing can be shown for ${words.title.toLowerCase()} or for the ${words.completeTitle.toLowerCase()}: each figure needs a reading for every day of its window, and no connection in this view has one. Figures appear once a connection has synced every day of a ${words.noun}.`;
}

/** Why there is no comparison, when the figure knows more than "unavailable". */
export type ComparisonGap =
  | Readonly<{ reason: "providers"; names: readonly string[] }>
  | Readonly<{ reason: "no_signups" }>;

/**
 * "Up 12 percent from $1,100.00 on the same days last week", or why there is no comparison.
 * Direction is always a word, never only a color.
 */
export function headlineComparisonText(
  comparison: TrendComparison,
  format: (value: number) => string,
  windows: HeadlineWindowLabel,
  gap: ComparisonGap | null = null,
): string {
  const words = WINDOW_WORDS[windows.kind];
  const previous = windows.complete ? words.completePrevious : words.previous;
  if (comparison.status === "unavailable") {
    if (gap?.reason === "providers" && gap.names.length > 0) {
      return `No comparison: ${formatList(gap.names)} could not report ${previous.name}`;
    }
    if (gap?.reason === "no_signups") return `No comparison: there were no signups ${previous.at} ${previous.name}`;
    return `No comparison: ${previous.name} ${previous.are} unavailable`;
  }
  const from = `${format(comparison.previous)} ${previous.at} ${previous.name}`;
  if (comparison.direction === "same") return `No change from ${from}`;
  const direction = comparison.direction === "up" ? "Up" : "Down";
  if (comparison.percent === null) return `${direction} from ${from}`;
  const rounded = Math.round(comparison.percent);
  return rounded === 0 ? `${direction} less than 1 percent from ${from}` : `${direction} ${rounded} percent from ${from}`;
}

export function formatCount(value: number, singular: string, plural: string): string {
  return formatQuantity(value, value === 1 ? singular : plural);
}

export function moneyFormatter(currency: string): (value: number) => string {
  return (value) => formatMoney(value, currency);
}

/** "PostHog counts signups by whole UTC day, so today is not in its count yet." */
export function wholeDaysNote(names: readonly string[]): string {
  const one = names.length === 1;
  return `${formatList(names)} ${one ? "counts" : "count"} signups by whole UTC day, so today is not in ${one ? "its" : "their"} count yet.`;
}

/** The cost per signup explanation: exactly which providers went into it. */
export function costPerSignupExplanation(figure: CostPerSignupSources): string {
  const parts: string[] = [];
  if (figure.spendFrom.length > 0 && figure.signupsFrom.length > 0) {
    parts.push(`Spend from ${formatList(figure.spendFrom)}, divided by signups from ${formatList(figure.signupsFrom)}.`);
  }
  if (figure.signupsWholeDays.length > 0) parts.push(wholeDaysNote(figure.signupsWholeDays));
  if (figure.spendUnavailable.length > 0) {
    parts.push(`Leaves out spend from ${formatList(figure.spendUnavailable)}, unavailable for this window.`);
  }
  if (figure.signupsUnavailable.length > 0) {
    parts.push(`Leaves out signups from ${formatList(figure.signupsUnavailable)}, unavailable for this window.`);
  }
  parts.push("Each currency on its own, verified and estimated spend apart, rounded once to the currency's smallest unit.");
  return parts.join(" ");
}
