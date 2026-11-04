import { useId } from "react";

import { SimulatedBadge } from "@/components/connections/simulated-badge";
import {
  bucketLabel,
  comparisonText,
  formatTrendValue,
  seriesTitle,
  trendSummary,
  trendWindowLabel,
  type TrendSeries,
} from "@/lib/dashboard/trends";

// Drawing space in SVG user units; the SVG scales to its container width.
const WIDTH = 640;
const HEIGHT = 180;
const PAD_X = 8;
const PAD_Y = 12;
const GAP_MARK = 6;
const ESTIMATE_DASH = "6 4";

/**
 * One trend series as an inline SVG line chart with a table of the same values. Server rendered
 * and never animated, so reduced motion needs nothing switched off. Meaning never rests on color:
 * estimated values use a dashed line and hollow points, gaps break the line and carry a mark on
 * the baseline, and the legend says so in words. The chart is one image whose accessible name
 * summarizes the trend; the table holds every value.
 */
export function TrendChart({ series }: { series: TrendSeries }) {
  const titleId = useId();
  const { points, measure, granularity } = series;
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const low = Math.min(0, ...values);
  const high = Math.max(...values);
  const span = high > low ? high - low : 1;
  const plotWidth = WIDTH - 2 * PAD_X;
  const plotHeight = HEIGHT - 2 * PAD_Y;
  const x = (index: number) => PAD_X + (points.length > 1 ? (index / (points.length - 1)) * plotWidth : plotWidth / 2);
  const y = (value: number) => PAD_Y + (1 - (value - low) / span) * plotHeight;
  const baseline = HEIGHT - PAD_Y;
  const hasEstimates = points.some((point) => point.value !== null && point.estimated);
  const hasGaps = points.some((point) => point.value === null);
  const first = points[0];
  const last = points.at(-1);

  return (
    <figure aria-labelledby={titleId} className="rounded-xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={titleId} className="font-semibold">
          {seriesTitle(series)}
        </h3>
        {series.simulated ? <SimulatedBadge /> : null}
      </div>
      <p className="mt-1 text-sm text-muted">{comparisonText(series.comparison, measure, granularity)}</p>

      <svg
        role="img"
        aria-label={trendSummary(series)}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-4 h-auto w-full text-accent"
      >
        <line x1={PAD_X} x2={WIDTH - PAD_X} y1={PAD_Y} y2={PAD_Y} className="stroke-line-strong" strokeWidth={1} />
        <line x1={PAD_X} x2={WIDTH - PAD_X} y1={baseline} y2={baseline} className="stroke-line-strong" strokeWidth={1} />
        {points.map((point, index) => {
          const previous = points[index - 1];
          if (index === 0 || previous === undefined || previous.value === null || point.value === null) return null;
          return (
            <line
              key={`segment-${point.bucket}`}
              x1={x(index - 1)}
              y1={y(previous.value)}
              x2={x(index)}
              y2={y(point.value)}
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={previous.estimated || point.estimated ? ESTIMATE_DASH : undefined}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
        {points.map((point, index) =>
          point.value === null ? (
            <line
              key={`gap-${point.bucket}`}
              x1={x(index)}
              x2={x(index)}
              y1={baseline - GAP_MARK}
              y2={baseline}
              className="stroke-muted"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ) : (
            <circle
              key={`point-${point.bucket}`}
              cx={x(index)}
              cy={y(point.value)}
              r={3}
              stroke="currentColor"
              strokeWidth={1.5}
              className={point.estimated ? "fill-panel" : "fill-current"}
              vectorEffect="non-scaling-stroke"
            />
          ),
        )}
      </svg>

      {/* Axis labels are in the table and the chart's name already, so screen readers skip them here. */}
      <div aria-hidden="true" className="mt-1 flex justify-between gap-4 font-mono text-xs text-muted">
        <span>{first === undefined ? "" : bucketLabel(first.bucket, granularity)}</span>
        <span>
          {values.length === 0 ? "" : `High ${formatTrendValue(high, measure)}, low ${formatTrendValue(Math.min(...values), measure)}`}
        </span>
        <span>{last === undefined ? "" : bucketLabel(last.bucket, granularity)}</span>
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <li className="flex items-center gap-2">
          <LegendLine dashed={false} />
          Solid line, filled points: verified
        </li>
        {hasEstimates ? (
          <li className="flex items-center gap-2">
            <LegendLine dashed />
            Dashed line, hollow points: estimated
          </li>
        ) : null}
        {hasGaps ? (
          <li className="flex items-center gap-2">
            <svg width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" className="text-muted">
              <line x1={6} x2={6} y1={4} y2={12} stroke="currentColor" strokeWidth={2} />
            </svg>
            Break in the line, mark on the baseline: unavailable
          </li>
        ) : null}
      </ul>

      <details className="mt-4">
        <summary className="inline-flex min-h-6 cursor-pointer items-center text-sm font-medium underline underline-offset-4">
          Show the values as a table
        </summary>
        <div className="mt-3">
          <table className="w-full text-left text-sm">
            <caption className="mb-2 text-left text-xs text-muted">
              {`${seriesTitle(series)}: ${granularity === "daily" ? "daily" : "monthly"} values for the ${trendWindowLabel(granularity)}`}
            </caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th scope="col" className="py-2 pr-4 font-medium">
                  {granularity === "daily" ? "Day (UTC)" : "Month (UTC)"}
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Value
                </th>
                <th scope="col" className="py-2 font-medium">
                  Source
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.bucket} className="border-b border-line">
                  <th scope="row" className="py-2 pr-4 font-mono font-normal">
                    {bucketLabel(point.bucket, granularity)}
                  </th>
                  <td className="py-2 pr-4 font-mono tabular-nums">
                    {point.value === null ? (
                      <span className="text-muted">Unavailable</span>
                    ) : (
                      formatTrendValue(point.value, measure)
                    )}
                  </td>
                  <td className="py-2">{point.value === null ? "No data" : point.estimated ? "Estimated" : "Verified"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function LegendLine({ dashed }: { dashed: boolean }) {
  return (
    <svg width={28} height={10} viewBox="0 0 28 10" aria-hidden="true" className="text-accent">
      <line x1={2} x2={20} y1={5} y2={5} stroke="currentColor" strokeWidth={2} strokeDasharray={dashed ? "4 3" : undefined} />
      <circle cx={23} cy={5} r={3} stroke="currentColor" strokeWidth={1.5} className={dashed ? "fill-panel" : "fill-current"} />
    </svg>
  );
}
