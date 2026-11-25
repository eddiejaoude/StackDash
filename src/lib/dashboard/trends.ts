/**
 * Pure reductions from stored snapshots to trend series: daily for the last 30 UTC days and
 * monthly for the last 13 UTC months, per provider and metric. No I/O and no clock: the caller
 * passes `now`.
 *
 * Rules decided here, once:
 * - A series is one provider, one metric key, and one currency or unit. Currencies and units are
 *   never mixed in a series; the same metric reported in two currencies is two series.
 * - Each account contributes its latest row in a bucket (day or month). A bucket's value is the
 *   sum over the series' accounts. If any account expected in the bucket has no row in it, the
 *   bucket is unavailable (null), never zero and never a partial sum.
 * - An account is expected in a bucket from its first row on. One that has stopped reporting (no
 *   row since `snapshotWindowStart(now)`, the dashboard's window) is expected only up to the
 *   bucket of its last row, in both granularities (#308), so a stopped account never makes a
 *   later day or month unavailable, and the daily and monthly views agree about it. The cost, in
 *   the monthly view only: the comparison across that account's last month compares a sum that
 *   includes it with one that no longer does, so it can show a fall that is only the account
 *   leaving. A stopped account's last day is more than 45 days back, outside the 30 day chart.
 * - A point is estimated when any row behind it is estimated. A series is simulated when any
 *   connection behind a point in the window was made by the provider simulator (#131).
 * - The comparison is the last bucket against the one before it. A missing bucket on either side
 *   means no comparison; a previous value of zero gives a direction but no percent.
 * - The default set (#263, option A2): per provider, the money behind the dashboard's spending and
 *   revenue cards, by the rules those cards and the headline strip apply. Every other series opens
 *   on demand, one disclosure per provider.
 */
import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { formatMoney, formatQuantity, formatUtcMonth } from "@/lib/format";
import { providerName } from "@/lib/providers";

import { ACCUMULATING_KINDS, countedSnapshots, isCurrentPeriod, isEstimated, snapshotWindowStart, type ProviderId, type SnapshotInput } from "./aggregate";

export type TrendGranularity = "daily" | "monthly";

export const TREND_DAYS = 30;
export const TREND_MONTHS = 13;

const DAY_MS = 86_400_000;

export type TrendRow = Pick<
  SnapshotInput,
  | "connection_id"
  | "external_account_id"
  | "metric_key"
  | "kind"
  | "label"
  | "snapshot_date"
  | "value"
  | "unit"
  | "amount_minor"
  | "currency"
  | "retrieved_at"
  | "provenance_source"
>;

export type TrendConnection = Readonly<{ id: string; provider: ProviderId; granted_scopes: readonly string[] }>;

export type TrendMeasure = Readonly<{ type: "money"; currency: string }> | Readonly<{ type: "quantity"; unit: string }>;

export type TrendPoint = Readonly<{
  /** `YYYY-MM-DD` for a day, `YYYY-MM` for a month, both UTC. */
  bucket: string;
  /** Minor units for money. null when unavailable. */
  value: number | null;
  estimated: boolean;
}>;

export type TrendComparison =
  | Readonly<{ status: "unavailable"; missing: "current" | "previous" }>
  | Readonly<{
      status: "change";
      direction: "up" | "down" | "same";
      /** Absolute change as a share of the previous value, 0 to 100 and beyond; null when the previous value is zero. */
      percent: number | null;
      previous: number;
    }>;

export type TrendSeries = Readonly<{
  key: string;
  provider: ProviderId;
  metricKey: string;
  label: string;
  measure: TrendMeasure;
  granularity: TrendGranularity;
  points: readonly TrendPoint[];
  /** True when any connection behind a point was made by the provider simulator (#131). */
  simulated: boolean;
  comparison: TrendComparison;
}>;

function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** First UTC date of the oldest month a monthly trend shows; the daily window is always inside it. */
export function trendWindowStart(now: Date): string {
  return isoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1), 1));
}

/** Buckets oldest first, ending with today (daily) or the current month (monthly), in UTC. */
export function trendBuckets(granularity: TrendGranularity, now: Date): string[] {
  if (granularity === "daily") {
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    return Array.from({ length: TREND_DAYS }, (_, index) => isoDate(today - (TREND_DAYS - 1 - index) * DAY_MS));
  }
  return Array.from({ length: TREND_MONTHS }, (_, index) =>
    isoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (TREND_MONTHS - 1 - index), 1)).slice(0, 7),
  );
}

/**
 * The first UTC day from which a trend chart is whole (#336), from `completeFrom`, the first day its
 * read holds in full, or null when every bucket the chart shows is whole. A bucket is whole only
 * when every day of it is, so a month is whole from the first day of the month after a partly
 * read one.
 */
export function trendCompleteFrom(completeFrom: string | null, granularity: TrendGranularity, now: Date): string | null {
  if (completeFrom === null) return null;
  const [firstBucket = ""] = trendBuckets(granularity, now);
  if (granularity === "daily") return completeFrom > firstBucket ? completeFrom : null;
  const day = new Date(`${completeFrom}T00:00:00.000Z`);
  const month = day.getUTCDate() === 1 ? completeFrom : isoDate(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1));
  return month.slice(0, 7) > firstBucket ? month : null;
}

function measureOf(row: TrendRow): TrendMeasure | null {
  if (row.currency !== null && row.amount_minor !== null) return { type: "money", currency: row.currency };
  if (row.unit !== null && row.value !== null) return { type: "quantity", unit: row.unit };
  return null;
}

function seriesKey(provider: ProviderId, metricKey: string, measure: TrendMeasure): string {
  return `${provider} ${metricKey} ${measure.type === "money" ? `money:${measure.currency}` : `quantity:${measure.unit}`}`;
}

function newer(a: TrendRow, b: TrendRow): boolean {
  return a.snapshot_date > b.snapshot_date || (a.snapshot_date === b.snapshot_date && Date.parse(a.retrieved_at) > Date.parse(b.retrieved_at));
}

type SeriesBuilder = {
  provider: ProviderId;
  metricKey: string;
  measure: TrendMeasure;
  latest: TrendRow;
  /** First and last date each account reported this metric, within the loaded rows. */
  spans: Map<string, { first: string; last: string }>;
  /** Bucket, then account, then that account's latest row in the bucket. */
  cells: Map<string, Map<string, TrendRow>>;
  simulated: boolean;
};

/** `current` against `previous`; a missing value on either side means no comparison. */
export function compareValues(current: number | null, previous: number | null): TrendComparison {
  if (current === null) return { status: "unavailable", missing: "current" };
  if (previous === null) return { status: "unavailable", missing: "previous" };
  const direction = current > previous ? "up" : current < previous ? "down" : "same";
  const percent = previous === 0 ? null : (Math.abs(current - previous) / Math.abs(previous)) * 100;
  return { status: "change", direction, percent, previous };
}

/** Last bucket against the one before it. */
export function compareToPrevious(points: readonly TrendPoint[]): TrendComparison {
  return compareValues(points.at(-1)?.value ?? null, points.at(-2)?.value ?? null);
}

/**
 * Trend series for `granularity`, from rows already narrowed to the scope filter. Rows of
 * connections not in `connections` are ignored. Series with no value in the window are left out.
 * Sorted by provider name, then label, then currency or unit.
 */
export function buildTrends(
  rows: readonly TrendRow[],
  connections: readonly TrendConnection[],
  granularity: TrendGranularity,
  now: Date,
): TrendSeries[] {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const buckets = trendBuckets(granularity, now);
  const reportingSince = snapshotWindowStart(now);
  const inWindow = new Set(buckets);
  const builders = new Map<string, SeriesBuilder>();

  for (const row of rows) {
    const connection = byId.get(row.connection_id);
    const measure = measureOf(row);
    if (connection === undefined || measure === null) continue;
    const { provider } = connection;
    const key = seriesKey(provider, row.metric_key, measure);
    let builder = builders.get(key);
    if (builder === undefined) {
      builder = { provider, metricKey: row.metric_key, measure, latest: row, spans: new Map(), cells: new Map(), simulated: false };
      builders.set(key, builder);
    }
    if (newer(row, builder.latest)) builder.latest = row;
    const span = builder.spans.get(row.external_account_id);
    if (span === undefined) builder.spans.set(row.external_account_id, { first: row.snapshot_date, last: row.snapshot_date });
    else if (row.snapshot_date < span.first) span.first = row.snapshot_date;
    else if (row.snapshot_date > span.last) span.last = row.snapshot_date;

    const bucket = granularity === "daily" ? row.snapshot_date : row.snapshot_date.slice(0, 7);
    if (!inWindow.has(bucket)) continue;
    builder.simulated ||= isSimulatedConnection(connection);
    let cell = builder.cells.get(bucket);
    if (cell === undefined) {
      cell = new Map();
      builder.cells.set(bucket, cell);
    }
    const current = cell.get(row.external_account_id);
    if (current === undefined || newer(row, current)) cell.set(row.external_account_id, row);
  }

  const series: TrendSeries[] = [];
  for (const [key, builder] of builders) {
    const points = buckets.map((bucket): TrendPoint => {
      const bucketStart = granularity === "daily" ? bucket : `${bucket}-01`;
      // "YYYY-MM-31" sorts after every real date in the month, so it stands for the month's end.
      const bucketEnd = granularity === "daily" ? bucket : `${bucket}-31`;
      const expected = [...builder.spans]
        .filter(([, { first, last }]) => first <= bucketEnd && (last >= reportingSince || last >= bucketStart))
        .map(([account]) => account);
      const cell = builder.cells.get(bucket);
      let value = 0;
      let estimated = false;
      for (const account of expected) {
        const row = cell?.get(account);
        if (row === undefined) return { bucket, value: null, estimated: false };
        value += (builder.measure.type === "money" ? row.amount_minor : row.value) ?? 0;
        estimated ||= isEstimated(row);
      }
      return expected.length === 0 ? { bucket, value: null, estimated: false } : { bucket, value, estimated };
    });
    if (points.every((point) => point.value === null)) continue;
    series.push({
      key,
      provider: builder.provider,
      metricKey: builder.metricKey,
      label: builder.latest.label,
      measure: builder.measure,
      granularity,
      points,
      simulated: builder.simulated,
      comparison: compareToPrevious(points),
    });
  }
  return series.sort(
    (a, b) =>
      providerName(a.provider).localeCompare(providerName(b.provider)) ||
      a.label.localeCompare(b.label) ||
      measureName(a.measure).localeCompare(measureName(b.measure)),
  );
}

/**
 * Keys of the series shown on first load, decided on #263 (option A2): per provider, the money
 * series (`ACCUMULATING_KINDS`: verified spend, estimated spend, revenue) behind the spending and
 * revenue cards, read exactly as the cards read them: `countedSnapshots` (declared projections
 * left out, the latest row per account and metric, breakdowns and sub-windows dropped), then
 * `isCurrentPeriod`. So the trends, the cards, and the headline strip never disagree. Breakdowns
 * (GitHub's SKUs and days, DigitalOcean's SKU days), finished periods (an invoice), rolling
 * windows (Stripe's last 30 days), usage, allowances, and projections are left for the
 * provider's disclosure. A breakdown is dropped only beside its total in the same account, so
 * another account's only figure stays. Keys match `buildTrends`.
 */
export function defaultSeriesKeys(
  rows: readonly SnapshotInput[],
  connections: readonly TrendConnection[],
  projectedSpend: readonly string[],
  now: Date,
): Set<string> {
  const byId = new Map(connections.map((connection) => [connection.id, connection]));
  const money = rows.filter((row) => ACCUMULATING_KINDS.has(row.kind));
  const keys = new Set<string>();
  for (const row of countedSnapshots(money, projectedSpend)) {
    const connection = byId.get(row.connection_id);
    const measure = measureOf(row);
    if (connection === undefined || measure === null || !isCurrentPeriod(row, now)) continue;
    keys.add(seriesKey(connection.provider, row.metric_key, measure));
  }
  return keys;
}

/** One provider's trends: the default set, and the rest behind its disclosure. */
export type ProviderTrends = Readonly<{
  provider: ProviderId;
  defaults: readonly TrendSeries[];
  more: readonly TrendSeries[];
}>;

/** `series` per provider, in the order `buildTrends` sorted them, split by `defaultKeys`. */
export function groupTrends(series: readonly TrendSeries[], defaultKeys: ReadonlySet<string>): ProviderTrends[] {
  const groups = new Map<ProviderId, { defaults: TrendSeries[]; more: TrendSeries[] }>();
  for (const entry of series) {
    let group = groups.get(entry.provider);
    if (group === undefined) {
      group = { defaults: [], more: [] };
      groups.set(entry.provider, group);
    }
    (defaultKeys.has(entry.key) ? group.defaults : group.more).push(entry);
  }
  return [...groups].map(([provider, { defaults, more }]) => ({ provider, defaults, more }));
}

/** The repeated search param naming each provider whose disclosure is open. */
export const EXPAND_TRENDS_PARAM = "expand";

/** `expanded` without duplicates and sorted, so equal states have equal URLs. */
export function canonicalExpanded(expanded: readonly ProviderId[]): ProviderId[] {
  return [...new Set(expanded)].sort();
}

/** The open providers after toggling `provider`'s disclosure. */
export function toggleExpanded(expanded: readonly ProviderId[], provider: ProviderId): ProviderId[] {
  return canonicalExpanded(expanded.includes(provider) ? expanded.filter((entry) => entry !== provider) : [...expanded, provider]);
}

// Formatting. US English; days are UTC dates because snapshot days are UTC.

export function measureName(measure: TrendMeasure): string {
  return measure.type === "money" ? measure.currency : measure.unit;
}

export function formatTrendValue(value: number, measure: TrendMeasure): string {
  return measure.type === "money" ? formatMoney(value, measure.currency) : formatQuantity(value, measure.unit);
}

/** "2026-10-31" for a day, "October 2026" for a month. */
export function bucketLabel(bucket: string, granularity: TrendGranularity): string {
  return granularity === "daily" ? bucket : formatUtcMonth(`${bucket}-01T00:00:00Z`);
}

const PERIOD_WORDS = {
  daily: { current: "today", previous: "the previous day", window: "last 30 days", unit: "day", units: "days" },
  monthly: { current: "this month", previous: "last month", window: "last 13 months", unit: "month", units: "months" },
} as const satisfies Record<TrendGranularity, Record<string, string>>;

export function trendWindowLabel(granularity: TrendGranularity): string {
  return PERIOD_WORDS[granularity].window;
}

/** "Up 12 percent from last month", "Up from $0.00 last month", or why there is no comparison. */
export function comparisonText(comparison: TrendComparison, measure: TrendMeasure, granularity: TrendGranularity): string {
  const words = PERIOD_WORDS[granularity];
  if (comparison.status === "unavailable") {
    return `No comparison: ${comparison.missing === "current" ? words.current : words.previous} is unavailable`;
  }
  if (comparison.direction === "same") return `No change from ${words.previous}`;
  const direction = comparison.direction === "up" ? "Up" : "Down";
  if (comparison.percent === null) return `${direction} from ${formatTrendValue(comparison.previous, measure)} ${words.previous}`;
  const rounded = Math.round(comparison.percent);
  return rounded === 0
    ? `${direction} less than 1 percent from ${words.previous}`
    : `${direction} ${rounded} percent from ${words.previous}`;
}

/** "Spend this month (Example provider, USD)". */
export function seriesTitle(series: TrendSeries): string {
  return `${series.label} (${providerName(series.provider)}, ${measureName(series.measure)})`;
}

/** The chart's accessible name: the whole trend in one or two sentences. */
export function trendSummary(series: TrendSeries): string {
  const words = PERIOD_WORDS[series.granularity];
  const available = series.points.filter((point) => point.value !== null);
  const first = available[0];
  const last = available.at(-1);
  const parts = [`${seriesTitle(series)}, ${words.window}.`];
  if (first !== undefined && last !== undefined && first.value !== null && last.value !== null) {
    parts.push(
      `From ${formatTrendValue(first.value, series.measure)} on ${bucketLabel(first.bucket, series.granularity)} to ${formatTrendValue(last.value, series.measure)} on ${bucketLabel(last.bucket, series.granularity)}.`,
    );
  }
  parts.push(`${comparisonText(series.comparison, series.measure, series.granularity)}.`);
  const gaps = series.points.length - available.length;
  if (gaps > 0) parts.push(`${gaps} ${gaps === 1 ? words.unit : words.units} unavailable.`);
  if (available.some((point) => point.estimated)) parts.push("Includes estimated values.");
  return parts.join(" ");
}
