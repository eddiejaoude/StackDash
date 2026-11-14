import Link from "next/link";
import { useId } from "react";

import { LiveRegion } from "@/components/ui/live-region";
import {
  eventCountLabel,
  HEAT_DAY_NAMES,
  HEAT_DAYS,
  HEAT_FILTERS,
  HEAT_STEPS,
  heatCellLabel,
  heatEmptyLabel,
  HEATMAP_DAYS,
  heatSteps,
  hourLabel,
  HOURS_PER_DAY,
  isInRun,
  peakRun,
  peakRunLabel,
  type HeatFilter,
  type HeatGrid,
  type HeatStep,
} from "@/lib/dashboard/heatmap";

// Literal class names, so Tailwind generates each one (src/app/globals.css, --heat-0 to --heat-4).
const STEP_CLASS: Readonly<Record<HeatStep, string>> = {
  0: "bg-heat-0",
  1: "bg-heat-1",
  2: "bg-heat-2",
  3: "bg-heat-3",
  4: "bg-heat-4",
};

// The table's border spacing, which the peak outline spans between its cells.
const GAP_PX = 4;

const HOURS = Array.from({ length: HOURS_PER_DAY }, (_, hour) => hour);

/**
 * "When things happen" (#414): events per London weekday and hour over the last 30 days, like
 * GitHub's contribution tiles. The grid is a real table, so every count is in the page as text:
 * each cell names its count to assistive tech (with its row and column headers) and to hover
 * (`title`), and color is never the only signal. The filter is URL state (`heat`), so the chips
 * are links, like the Trends period links.
 */
export function ActivityHeatmapSection({
  grid,
  filter,
  hrefs,
}: {
  grid: HeatGrid;
  filter: HeatFilter;
  /** One link per filter, keeping the dashboard's scope and other view choices. */
  hrefs: Readonly<Record<HeatFilter, string>>;
}) {
  const titleId = useId();
  const steps = heatSteps(grid);
  const peak = peakRun(grid, steps);
  return (
    <section aria-labelledby={titleId} className="mt-6 min-w-0">
      <div className="rounded-xl border border-line-strong bg-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
              When things happen
            </h2>
            <p className="mt-1 font-mono text-xs text-muted">{`events by hour · last ${HEATMAP_DAYS} days`}</p>
          </div>
          <nav aria-label="Heatmap events" className="flex flex-wrap gap-2">
            {HEAT_FILTERS.map((option) => {
              const current = option === filter;
              return (
                <Link
                  key={option}
                  href={hrefs[option]}
                  scroll={false}
                  aria-current={current ? "page" : undefined}
                  className={`inline-flex min-h-7 items-center rounded-md border px-2.5 font-mono text-xs transition-colors ${
                    current ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:text-foreground"
                  }`}
                >
                  {option}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Negative margins take back the border spacing outside the first and last columns. */}
        <table className="-mx-1 mt-4 w-[calc(100%+0.5rem)] table-fixed border-separate border-spacing-1">
          <caption className="sr-only">
            {`Events per weekday and hour, Europe/London time, last ${HEATMAP_DAYS} days, ${filter === "all" ? "every event" : filter}`}
          </caption>
          <colgroup>
            <col className="w-9" />
            {HOURS.map((hour) => (
              <col key={hour} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className="p-0">
                <span className="sr-only">Day</span>
              </th>
              {HOURS.map((hour) => (
                <th key={hour} scope="col" className="p-0 text-left font-mono text-[9px] leading-3 font-normal text-muted">
                  <span aria-hidden="true">{hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>
                  <span className="sr-only">{hourLabel(hour)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HEAT_DAYS.map((day, dayIndex) => (
              <tr key={day}>
                <th scope="row" className="p-0 text-left font-mono text-[10px] font-normal text-muted">
                  <span aria-hidden="true">{day}</span>
                  <span className="sr-only">{HEAT_DAY_NAMES[dayIndex]}</span>
                </th>
                {HOURS.map((hour) => {
                  const count = grid[dayIndex]?.[hour] ?? 0;
                  const step = steps[dayIndex]?.[hour] ?? 0;
                  const startsPeak = peak !== null && peak.day === dayIndex && peak.startHour === hour;
                  return (
                    <td key={hour} title={heatCellLabel(dayIndex, hour, count)} className="relative p-0">
                      <div aria-hidden="true" className={`h-5.5 rounded-[3px] ${STEP_CLASS[step]}`} />
                      {startsPeak ? (
                        // One outline around the whole run: it starts in the run's first cell and
                        // spans its cells and the gaps between them.
                        <div
                          aria-hidden="true"
                          className="pointer-events-none absolute -inset-y-0.5 -left-0.5 rounded-sm border border-accent"
                          style={{ width: `calc(${peak.endHour - peak.startHour} * 100% + ${(peak.endHour - peak.startHour) * GAP_PX}px)` }}
                        />
                      ) : null}
                      <span className="sr-only">
                        {eventCountLabel(count)}
                        {isInRun(peak, dayIndex, hour) ? ", in the peak" : ""}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 font-mono text-xs">
          <LiveRegion tone="status" as="p">
            {peak === null ? (
              <span className="text-muted">{heatEmptyLabel(filter)}</span>
            ) : (
              <>
                <span className="text-accent">peak</span> {peakRunLabel(peak)}
              </>
            )}
          </LiveRegion>
          <p className="flex items-center gap-1 text-[10px] text-muted">
            <span aria-hidden="true">less</span>
            {HEAT_STEPS.map((step) => (
              <span key={step} aria-hidden="true" className={`size-2.5 rounded-[2px] ${STEP_CLASS[step]}`} />
            ))}
            <span aria-hidden="true">more</span>
            <span className="sr-only">Brighter cells hold more events, on a scale of five steps.</span>
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * Stands in for the heatmap while its counts stream in, shaped like the section (header, chips,
 * the 7 by 24 grid, the footer) so the page does not jump when it arrives.
 */
export function ActivityHeatmapSkeleton() {
  return (
    <LiveRegion tone="status" className="mt-6 min-w-0">
      <span className="sr-only">Loading the activity heatmap</span>
      <div aria-hidden="true" className="rounded-xl border border-line-strong bg-panel p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="h-5 w-40 rounded bg-panel-raised motion-safe:animate-pulse" />
            <div className="mt-1 h-4 w-52 rounded bg-panel-raised motion-safe:animate-pulse" />
          </div>
          <div className="h-7 w-64 rounded-md bg-panel-raised motion-safe:animate-pulse" />
        </div>
        {/* The hour label row (12px) and seven 22px rows with 4px between them. */}
        <div className="mt-4 h-[202px] rounded bg-panel-raised motion-safe:animate-pulse" />
        <div className="mt-4 flex justify-between gap-3">
          <div className="h-4 w-56 rounded bg-panel-raised motion-safe:animate-pulse" />
          <div className="h-4 w-32 rounded bg-panel-raised motion-safe:animate-pulse" />
        </div>
      </div>
    </LiveRegion>
  );
}
