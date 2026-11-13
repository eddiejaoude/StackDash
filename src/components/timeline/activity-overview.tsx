import Link from "next/link";

import { LiveRegion } from "@/components/ui/live-region";
import type { ActivityBucket } from "@/lib/data/timeline";
import { formatDateTime } from "@/lib/format";
import { selectedActivityBucket, severityBadge, timelineHref, type TimelineQuery } from "@/lib/timeline/query";

const FULL_COUNT = new Intl.NumberFormat("en-US");

/** "1 event" or "1,540 events", grouped and pluralized like the provider badges. */
function eventCount(events: number, before = ""): string {
  return `${FULL_COUNT.format(events)} ${before}${events === 1 ? "event" : "events"}`;
}

/** "2 critical, 1 warning" for the severities a bar holds, or null when it holds neither. */
function severityCounts(bucket: ActivityBucket): string | null {
  const counts = [
    ...(bucket.critical_events > 0 ? [`${FULL_COUNT.format(bucket.critical_events)} critical`] : []),
    ...(bucket.warning_events > 0
      ? [`${FULL_COUNT.format(bucket.warning_events)} ${bucket.warning_events === 1 ? "warning" : "warnings"}`]
      : []),
  ];
  return counts.length === 0 ? null : counts.join(", ");
}

/** "5 events" or "5 events, 2 critical, 1 warning,", ready for " from ..." to follow. */
function bucketSummary(bucket: ActivityBucket): string {
  const severities = severityCounts(bucket);
  return severities === null ? eventCount(bucket.events) : `${eventCount(bucket.events)}, ${severities},`;
}

/** The tallest bar: the `h-12` bar area less the link's bottom padding and the baseline, with room to spare. */
const BAR_MAX_PX = 40;
/** The shortest a segment gets, so one critical event among thousands still shows. */
const SEGMENT_MIN_PX = 2;
/** The panel-colored gap between two segments, so each meets the panel on its own. */
const SEGMENT_GAP_PX = 1;

type Segment = Readonly<{ key: "other" | "warning" | "critical"; events: number; className: string }>;

/**
 * A bar's stacked segments, top to bottom: everything else, then warning, then critical on the
 * baseline, where bars compare most easily. Empty segments are left out, and an empty bar is one
 * stub. Only the uncolored segment takes the hover, focus, and selected color, so the severity
 * colors always mean the same thing.
 */
function barSegments(bucket: ActivityBucket, selected: boolean): Segment[] {
  const other: Segment = {
    key: "other",
    events: bucket.events - bucket.critical_events - bucket.warning_events,
    className: `group-hover:bg-foreground group-focus-visible:bg-foreground ${selected ? "bg-foreground" : "bg-muted"}`,
  };
  const segments = [
    other,
    { key: "warning", events: bucket.warning_events, className: "bg-warning" },
    { key: "critical", events: bucket.critical_events, className: "bg-danger" },
  ] satisfies Segment[];
  const shown = segments.filter((segment) => segment.events > 0);
  return shown.length === 0 ? [{ ...other, events: 1 }] : shown;
}

/**
 * Server-rendered links keep the chart useful without charting JavaScript or a second fetch.
 *
 * Each bar stacks its critical and warning events in the `--danger` and `--warning` colors, so a
 * burst of failures shows before anyone reads a row. Color is never the only carrier: the bar's
 * accessible name, the period row, and the selection sentence say the counts, and the caption row
 * names the colors.
 *
 * A bar's count and period are printed in the caption row while the bar is hovered or has keyboard
 * focus, so the bars stay short at rest and a sighted keyboard user still sees what each bar holds.
 * Touch has no hover, so the selection sentence repeats the selected bar's counts. The period is
 * the link's sibling, not its content, so the link's accessible name is all it says (WCAG 2.5.3,
 * label in name). It is positioned against the wrapper around the scrolling chart, so the scroll
 * box does not clip it and it stays put while the chart scrolls. It shares the caption row's layout
 * (unwrapped lines stacked on a narrow screen, one row on a wide one), so its opaque box covers the
 * caption exactly, and a hovered bar's period stacks above a focused bar's. With severities in
 * view, both rows gain a middle part (the legend, and the bar's severity counts), and stay stacked
 * up to `md`, where three parts first fit on one row.
 */
export function ActivityOverview({ buckets, query, basePath }: {
  buckets: readonly ActivityBucket[];
  query: TimelineQuery;
  basePath: string;
}) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.events, 0);
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.events));
  const severe = buckets.some((bucket) => bucket.critical_events + bucket.warning_events > 0);
  const rowLayout = severe ? "md:flex-row md:justify-between" : "sm:flex-row sm:justify-between";
  const first = buckets.at(0);
  const last = buckets.at(-1);
  // A hand-written range that is not one bar has no count to print, only its period.
  const range = query.timeRange;
  const selectedBucket = selectedActivityBucket(buckets, range);
  return (
    <section aria-labelledby="activity-overview-title" className="my-6 min-w-0 rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="activity-overview-title" className="text-sm font-semibold">Activity overview</h2>
        <p className="text-xs text-muted">{`${eventCount(total, "matching ")} across all pages`}</p>
      </div>
      {first === undefined || last === undefined ? (
        <p className="mt-3 text-sm text-muted">No activity matches these filters. Change or clear the filters to see activity.</p>
      ) : (
        <div className="relative mt-3">
          <div className="overflow-x-auto p-1">
            <div className="flex h-12 min-w-max items-stretch gap-1 border-b border-line-strong">
              {buckets.map((bucket) => {
                const timeRange = {
                  from: new Date(bucket.bucket_start).toISOString(),
                  toExclusive: new Date(bucket.bucket_end).toISOString(),
                };
                const selected = bucket === selectedBucket;
                const from = formatDateTime(timeRange.from);
                const until = formatDateTime(timeRange.toExclusive);
                const segments = barSegments(bucket, selected);
                const fitsSegments = segments.length * (SEGMENT_MIN_PX + SEGMENT_GAP_PX) - SEGMENT_GAP_PX;
                return (
                  // `contents` keeps the link the flex item while the period beside it can be its peer.
                  <div key={timeRange.from} className="contents">
                    <Link
                      href={timelineHref(basePath, { ...query, timeRange }, null)}
                      prefetch={false}
                      scroll={false}
                      aria-label={`Show ${bucketSummary(bucket)} from ${from} to before ${until}`}
                      aria-current={selected ? "true" : undefined}
                      className={`peer group flex min-w-6 flex-1 flex-col justify-end rounded-t px-1 pb-1 outline-offset-2 hover:bg-panel-raised focus-visible:outline-2 focus-visible:outline-accent ${selected ? "bg-panel-raised ring-1 ring-inset ring-accent" : ""}`}
                    >
                      {/* Flex shares the bar's height by count, and no segment shrinks below its minimum. */}
                      <span
                        aria-hidden="true"
                        className="flex flex-col overflow-hidden rounded-t"
                        style={{
                          gap: SEGMENT_GAP_PX,
                          height: bucket.events === 0 ? SEGMENT_MIN_PX : Math.max(4, fitsSegments, bucket.events / peak * BAR_MAX_PX),
                        }}
                      >
                        {segments.map((segment) => (
                          <span
                            key={segment.key}
                            data-testid={`activity-segment-${segment.key}`}
                            className={`block ${segment.className}`}
                            style={{ flexGrow: segment.events, flexBasis: 0, minHeight: SEGMENT_MIN_PX }}
                          />
                        ))}
                      </span>
                    </Link>
                    <span
                      aria-hidden="true"
                      data-testid="activity-period"
                      className={`pointer-events-none absolute inset-x-0 bottom-0 hidden flex-col gap-x-4 whitespace-nowrap bg-panel text-xs text-foreground peer-hover:z-10 peer-hover:flex peer-focus-visible:flex ${rowLayout}`}
                    >
                      <span>{`${eventCount(bucket.events)} from ${from}`}</span>
                      {severe ? <span>{severityCounts(bucket) ?? "No critical or warning events"}</span> : null}
                      <span>Before {until}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div data-testid="activity-caption" className={`mt-2 flex flex-col gap-x-4 whitespace-nowrap text-xs text-muted ${rowLayout}`}>
            <time dateTime={first.bucket_start}>{formatDateTime(first.bucket_start)}</time>
            {severe ? (
              <span className="flex gap-3">
                {(["critical", "warning"] as const).map((severity) => (
                  <span key={severity} className="inline-flex items-center gap-1">
                    <span aria-hidden="true" className={`size-2 rounded-sm ${severity === "critical" ? "bg-danger" : "bg-warning"}`} />
                    {severityBadge(severity)}
                  </span>
                ))}
              </span>
            ) : null}
            <span>Before <time dateTime={last.bucket_end}>{formatDateTime(last.bucket_end)}</time></span>
          </div>
        </div>
      )}
      {/* The region stays mounted while its sentence comes and goes, so selecting a bar is announced. */}
      <div
        className={`flex flex-wrap items-center justify-between gap-2 text-xs ${query.timeRange === null ? "" : "mt-3 border-t border-line pt-3"}`}
      >
        <LiveRegion tone="status" as="p">
          {range === null
            ? null
            : `Selected: ${selectedBucket === undefined ? "" : `${bucketSummary(selectedBucket)} from `}${formatDateTime(range.from)} to before ${formatDateTime(range.toExclusive)}`}
        </LiveRegion>
        {query.timeRange === null ? null : (
          <Link
            href={timelineHref(basePath, { ...query, timeRange: null }, null)}
            prefetch={false}
            scroll={false}
            className="inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-4"
          >
            Clear time selection
          </Link>
        )}
      </div>
    </section>
  );
}
