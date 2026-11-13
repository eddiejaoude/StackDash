import Link from "next/link";

import { LiveRegion } from "@/components/ui/live-region";
import type { ActivityBucket } from "@/lib/data/timeline";
import { formatDateTime } from "@/lib/format";
import { timelineHref, type TimelineQuery } from "@/lib/timeline/query";

const FULL_COUNT = new Intl.NumberFormat("en-US");

/** "1 event" or "1,540 events", grouped and pluralized like the provider badges. */
function eventCount(events: number, before = ""): string {
  return `${FULL_COUNT.format(events)} ${before}${events === 1 ? "event" : "events"}`;
}

/** The tallest bar: the `h-12` bar area less the link's bottom padding and the baseline, with room to spare. */
const BAR_MAX_PX = 40;

/**
 * Server-rendered links keep the chart useful without charting JavaScript or a second fetch.
 *
 * A bar's count and period are printed in the caption row while the bar is hovered or has keyboard
 * focus, so the bars stay short at rest and a sighted keyboard user still sees what each bar holds.
 * Touch has no hover, so the selection sentence repeats the selected bar's count. The period is the
 * link's sibling, not its content, so the link's accessible name is all it says (WCAG 2.5.3, label
 * in name). It is positioned against the wrapper around the scrolling chart, so the scroll box does
 * not clip it and it stays put while the chart scrolls. It shares the caption row's layout (two
 * unwrapped lines below `sm`, one row above), so its opaque box covers the caption exactly, and a
 * hovered bar's period stacks above a focused bar's.
 */
export function ActivityOverview({ buckets, query, basePath }: {
  buckets: readonly ActivityBucket[];
  query: TimelineQuery;
  basePath: string;
}) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.events, 0);
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.events));
  const first = buckets.at(0);
  const last = buckets.at(-1);
  // A hand-written range that is not one bar has no count to print, only its period.
  const range = query.timeRange;
  const selectedBucket = range === null ? undefined : buckets.find((bucket) =>
    new Date(bucket.bucket_start).toISOString() === range.from && new Date(bucket.bucket_end).toISOString() === range.toExclusive);
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
                return (
                  // `contents` keeps the link the flex item while the period beside it can be its peer.
                  <div key={timeRange.from} className="contents">
                    <Link
                      href={timelineHref(basePath, { ...query, timeRange }, null)}
                      prefetch={false}
                      scroll={false}
                      aria-label={`Show ${eventCount(bucket.events)} from ${from} to before ${until}`}
                      aria-current={selected ? "true" : undefined}
                      className={`peer group flex min-w-6 flex-1 flex-col justify-end rounded-t px-1 pb-1 outline-offset-2 hover:bg-panel-raised focus-visible:outline-2 focus-visible:outline-accent ${selected ? "bg-panel-raised ring-1 ring-inset ring-accent" : ""}`}
                    >
                      <span
                        aria-hidden="true"
                        className={`block rounded-t group-hover:bg-accent group-focus-visible:bg-accent ${selected ? "bg-accent" : "bg-muted"}`}
                        style={{ height: bucket.events === 0 ? 2 : Math.max(4, bucket.events / peak * BAR_MAX_PX) }}
                      />
                    </Link>
                    <span
                      aria-hidden="true"
                      data-testid="activity-period"
                      className="pointer-events-none absolute inset-x-0 bottom-0 hidden flex-col gap-x-4 whitespace-nowrap bg-panel text-xs text-foreground peer-hover:z-10 peer-hover:flex peer-focus-visible:flex sm:flex-row sm:justify-between"
                    >
                      <span>{`${eventCount(bucket.events)} from ${from}`}</span>
                      <span>Before {until}</span>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          <div data-testid="activity-caption" className="mt-2 flex flex-col gap-x-4 whitespace-nowrap text-xs text-muted sm:flex-row sm:justify-between">
            <time dateTime={first.bucket_start}>{formatDateTime(first.bucket_start)}</time>
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
            : `Selected: ${selectedBucket === undefined ? "" : `${eventCount(selectedBucket.events)} from `}${formatDateTime(range.from)} to before ${formatDateTime(range.toExclusive)}`}
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
