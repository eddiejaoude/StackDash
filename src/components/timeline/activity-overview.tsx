import Link from "next/link";

import type { ActivityBucket } from "@/lib/data/timeline";
import { formatDateTime, formatQuantity } from "@/lib/format";
import { timelineHref, type TimelineQuery } from "@/lib/timeline/query";

/** Server-rendered links keep the chart useful without charting JavaScript or a second fetch. */
export function ActivityOverview({ buckets, query, basePath }: {
  buckets: readonly ActivityBucket[];
  query: TimelineQuery;
  basePath: string;
}) {
  const total = buckets.reduce((sum, bucket) => sum + bucket.events, 0);
  const peak = Math.max(1, ...buckets.map((bucket) => bucket.events));
  const first = buckets.at(0);
  const last = buckets.at(-1);
  return (
    <section aria-labelledby="activity-overview-title" className="my-6 min-w-0 rounded-lg border border-line bg-panel p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="activity-overview-title" className="text-sm font-semibold">Activity overview</h2>
        <p className="text-xs text-muted">{formatQuantity(total, "matching events across all pages")}</p>
      </div>
      <p className="mt-1 text-xs text-muted">Select a time bucket to filter the feed. Counts follow your filters, before time selection.</p>
      {first === undefined || last === undefined ? (
        <p className="mt-3 text-sm text-muted">No activity matches these filters. Change or clear the filters to see activity.</p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto p-1">
            <div className="flex h-28 min-w-max items-stretch gap-1 border-b border-line-strong">
              {buckets.map((bucket) => {
                const timeRange = {
                  from: new Date(bucket.bucket_start).toISOString(),
                  toExclusive: new Date(bucket.bucket_end).toISOString(),
                };
                const selected = query.timeRange?.from === timeRange.from && query.timeRange.toExclusive === timeRange.toExclusive;
                const label = `Show ${bucket.events} events from ${formatDateTime(timeRange.from)} to before ${formatDateTime(timeRange.toExclusive)}`;
                return (
                  <Link
                    key={timeRange.from}
                    href={timelineHref(basePath, { ...query, timeRange }, null)}
                    prefetch={false}
                    scroll={false}
                    aria-label={label}
                    aria-current={selected ? "true" : undefined}
                    title={label}
                    className={`group flex min-w-6 flex-1 flex-col justify-end gap-1 rounded-t px-1 pb-1 text-center outline-offset-2 hover:bg-panel-raised focus-visible:outline-2 focus-visible:outline-accent ${selected ? "bg-panel-raised ring-1 ring-inset ring-accent" : ""}`}
                  >
                    <span aria-hidden="true" className="font-mono text-xs text-muted">{bucket.events}</span>
                    <span
                      aria-hidden="true"
                      className={`block rounded-t group-hover:bg-accent group-focus-visible:bg-accent ${selected ? "bg-accent" : "bg-muted"}`}
                      style={{ height: bucket.events === 0 ? 2 : Math.max(4, bucket.events / peak * 76) }}
                    />
                  </Link>
                );
              })}
            </div>
          </div>
          <div className="mt-2 flex justify-between gap-4 text-xs text-muted">
            <time dateTime={first.bucket_start}>{formatDateTime(first.bucket_start)}</time>
            <span className="text-right">Before <time dateTime={last.bucket_end}>{formatDateTime(last.bucket_end)}</time></span>
          </div>
        </>
      )}
      {query.timeRange === null ? null : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-xs">
          <p role="status">Selected: {formatDateTime(query.timeRange.from)} to before {formatDateTime(query.timeRange.toExclusive)}</p>
          <Link
            href={timelineHref(basePath, { ...query, timeRange: null }, null)}
            prefetch={false}
            scroll={false}
            className="inline-flex min-h-6 items-center font-medium text-foreground underline underline-offset-4"
          >
            Clear time selection
          </Link>
        </div>
      )}
    </section>
  );
}
