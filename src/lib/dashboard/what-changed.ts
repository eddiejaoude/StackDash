/**
 * "What changed" (#270): up to three sentences at the top of the dashboard, each one an unusual
 * day that anomaly detection finds (#169) with the events of the same day (#168), and a link to
 * the timeline for that provider and day. Pure: rows, settings, counts, and `now` in; sentences
 * out. No I/O and no clock.
 *
 * Rules decided here, once:
 * - The anomalies are the ones the daily summary job finds: `findAnomalies` for each of the last
 *   `days` UTC days before today, with the rows that job reads (`anomalySnapshotRange`, spend and
 *   usage over a period), the connections it reads (every one but revoked ones, as
 *   `listSummaryConnections`), the workspace's mutes, and nothing at all when detection is off.
 *   Today is never checked, because its job has not run and a day still going is not a day's
 *   amount. Only anomalies dated within those `days` are kept, so "the last 7 days" is true of
 *   each one.
 * - The comparison sits beside the amount it describes and the day's events come last, so the
 *   ratio is never read as being about the events.
 * - Order: newest day first; then the biggest change, where a rise from a usual of zero (no ratio)
 *   comes before any ratio and a larger ratio before a smaller one; then provider name, label,
 *   and source, so equal inputs always give the same three. At most `WHAT_CHANGED_LIMIT` are kept.
 * - The events named are the anomaly's provider's own marker categories on the anomaly's UTC day,
 *   counted under the dashboard scope like the trend markers. StackDash's own events (triggered
 *   alerts) carry no provider, so the provider filtered link would not list them, and they are
 *   left out: what a sentence counts is what its link shows.
 * - The link is the timeline narrowed to the provider (keeping the rest of the dashboard scope) on
 *   the anomaly's day, through `timelineHref`, the same URL filter a trend marker uses. No type
 *   filter, so everything the provider recorded that day shows. The timeline reads the day as a
 *   London day, one hour off the UTC day in summer time, as decided for the markers on #168.
 */
import {
  ANOMALY_KINDS,
  ANOMALY_WINDOW_DAYS,
  addUtcDays,
  amountWords,
  anomalyEventKey,
  anomalySnapshotRange,
  findAnomalies,
  formatRatio,
  usualDaysWords,
  type Anomaly,
  type AnomalyConnection,
  type AnomalyMute,
  type AnomalyRow,
} from "@/lib/alerts/anomaly";
import type { ScopeFilters } from "@/lib/filters/scope";
import { formatList } from "@/lib/format";
import { providerName } from "@/lib/providers";
import { londonDayLabel } from "@/lib/timeline/days";
import { timelineHref } from "@/lib/timeline/query";

import type { ConnectionInput } from "./aggregate";
import { markerCountText, MARKER_CATEGORIES, type EventBucketCount } from "./markers";
import { formatTrendValue } from "./trends";

/** Most sentences the section shows. */
export const WHAT_CHANGED_LIMIT = 3;

const KINDS: readonly AnomalyRow["kind"][] = ANOMALY_KINDS;

/**
 * Every anomaly the daily summary jobs of the last `days` UTC days before `now` find, from rows of
 * at least those days and the 15 before each (`anomalySnapshotRange`). Empty when detection is off.
 */
export function recentAnomalies(input: {
  now: Date;
  days: number;
  enabled: boolean;
  rows: readonly AnomalyRow[];
  connections: readonly (AnomalyConnection & Pick<ConnectionInput, "status">)[];
  mutes: readonly AnomalyMute[];
  projectedSpend: readonly string[];
  dailyTotals: readonly string[];
}): Anomaly[] {
  if (!input.enabled || input.days < 1) return [];
  const today = input.now.toISOString().slice(0, 10);
  const first = addUtcDays(today, -input.days);
  // The rows the job reads: spend and usage over a period, oldest day first, the order its read
  // hands to `findAnomalies` (which keeps the first of two rows of one day it cannot tell apart).
  const candidates = input.rows
    .filter((row) => KINDS.includes(row.kind) && row.point_at === null && row.snapshot_date >= anomalySnapshotRange(first).from && row.snapshot_date < today)
    .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  // The job reads every connection but revoked ones (`listSummaryConnections`).
  const connections = input.connections.filter((connection) => connection.status !== "revoked");
  const found: Anomaly[] = [];
  for (let back = input.days; back >= 1; back -= 1) {
    const date = addUtcDays(today, -back);
    const range = anomalySnapshotRange(date);
    const rows = candidates.filter((row) => row.snapshot_date >= range.from && row.snapshot_date <= range.to);
    const anomalies = findAnomalies({ date, rows, connections, mutes: input.mutes, projectedSpend: input.projectedSpend, dailyTotals: input.dailyTotals });
    for (const anomaly of anomalies) {
      // A one day period is checked the day before the job's date, so the oldest job reaches one
      // day past the window.
      if (anomaly.date >= first) found.push(anomaly);
    }
  }
  return found;
}

/** Newest day first, then the biggest change, then provider name, label, and source. */
export function compareChanges(a: Anomaly, b: Anomaly): number {
  return (
    b.date.localeCompare(a.date) ||
    (b.ratio ?? Number.POSITIVE_INFINITY) - (a.ratio ?? Number.POSITIVE_INFINITY) ||
    providerName(a.provider).localeCompare(providerName(b.provider)) ||
    a.label.localeCompare(b.label) ||
    a.source.localeCompare(b.source)
  );
}

export type WhatChangedSentence = Readonly<{
  key: string;
  text: string;
  /** The link's text, naming the provider and day it opens. */
  linkText: string;
  href: string;
}>;

export type WhatChanged = Readonly<{
  /** At most `WHAT_CHANGED_LIMIT`, in `compareChanges` order. */
  sentences: readonly WhatChangedSentence[];
  /** Every anomaly found, including the ones past the limit. */
  total: number;
}>;

/** The UTC day `date` (`YYYY-MM-DD`) as an instant: its first moment, which London shows as the same date, for its weekday. */
function dayStart(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/**
 * "Example provider: Spend per day (verified) was $50.00 on Sunday, 2026-11-08, 5 times the usual
 * $10.00 a day (the median of the 14 days from 2026-10-25 to 2026-11-07), with 3 deployments that
 * day."
 */
export function changeSentence(anomaly: Anomaly, events: readonly EventBucketCount[]): string {
  const provider = providerName(anomaly.provider);
  const usual = formatTrendValue(anomaly.usual, anomaly.measure);
  const size = anomaly.ratio === null ? `up from a usual ${usual} a day` : `${formatRatio(anomaly.ratio)} times the usual ${usual} a day`;
  const sameDay = MARKER_CATEGORIES.flatMap((category) =>
    events
      .filter((count) => count.category === category && count.provider === anomaly.provider && count.bucket === anomaly.date)
      .map((count) => markerCountText(category, count.count)),
  );
  const eventWords = sameDay.length === 0 ? "" : `, with ${formatList(sameDay)} that day`;
  const from = addUtcDays(anomaly.date, -ANOMALY_WINDOW_DAYS);
  const to = addUtcDays(anomaly.date, -1);
  return (
    `${provider}: ${anomaly.label} (${anomaly.source}) ${amountWords(anomaly)} on ${londonDayLabel(dayStart(anomaly.date))}, ` +
    `${size} (the median of ${usualDaysWords(anomaly.historyDays)} from ${from} to ${to})${eventWords}.`
  );
}

/** The sentences for `anomalies`, ordered and capped, each linking to its provider's day on the timeline. */
export function whatChanged(
  anomalies: readonly Anomaly[],
  events: readonly EventBucketCount[],
  link: Readonly<{ timelinePath: string; scope: ScopeFilters }>,
): WhatChanged {
  const sentences = [...anomalies]
    .sort(compareChanges)
    .slice(0, WHAT_CHANGED_LIMIT)
    .map((anomaly) => ({
      key: anomalyEventKey(anomaly),
      text: changeSentence(anomaly, events),
      linkText: `Show ${providerName(anomaly.provider)} events on ${anomaly.date}`,
      href: timelineHref(
        link.timelinePath,
        {
          types: [],
          severities: [],
          from: anomaly.date,
          to: anomaly.date,
          timeRange: null,
          search: null,
          cursor: null,
          scope: { ...link.scope, providers: [anomaly.provider] },
        },
        null,
      ),
    }));
  return { sentences, total: anomalies.length };
}
