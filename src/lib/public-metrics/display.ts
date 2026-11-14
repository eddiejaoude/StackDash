import { formatPercent, formatQuantity } from "@/lib/format";

import {
  ROUNDING_LABELS,
  UNIT_NOUNS,
  type MetricUnit,
  type PublishedMetricDelay,
  type PublishedMetricRounding,
} from "./definitions";
import type { UnavailableReason } from "./engine";

/*
 * How a published value reads. Client-safe: no data access and no adapter or Node module, here or
 * in `definitions.ts` (`display.test.ts` walks the imports), so server pages, share surfaces, and
 * client components format the same way.
 */

/** The step each rounding rounds down to. */
export const ROUNDING_STEP: Record<PublishedMetricRounding, number> = {
  exact: 1,
  tens: 10,
  hundreds: 100,
  thousands: 1000,
};

/** Rounds down to the step, so a rounded value is never more than the stored one. */
export function applyRounding(value: number, rounding: PublishedMetricRounding): number {
  const step = ROUNDING_STEP[rounding];
  return Math.floor(value / step) * step;
}

/**
 * "1,204 stars", "1 deployment", "87%". `atLeast` reads "at least 1,200 stars" for a rounded value
 * or a lower bound, so a coarse number never reads as exact.
 */
export function formatMetricValue(value: number, unit: MetricUnit, atLeast = false): string {
  const text = unit === "percent" ? formatPercent(value) : formatQuantity(value, UNIT_NOUNS[unit][value === 1 ? 0 : 1]);
  return atLeast ? `at least ${text}` : text;
}

/** A published engine value after its rounding, ready to show. */
export function publishedDisplay(
  value: number,
  unit: MetricUnit,
  rounding: PublishedMetricRounding,
  lowerBound: boolean,
): Readonly<{ value: number; text: string }> {
  const rounded = applyRounding(value, rounding);
  return { value: rounded, text: formatMetricValue(rounded, unit, lowerBound || rounding !== "exact") };
}

export const UNAVAILABLE_LABELS: Record<UnavailableReason, string> = {
  not_connected: "Not connected",
  no_data: "No data yet",
  not_enough_history: "Not enough history yet",
  stale: "Not synced in the last 2 days",
  too_many_accounts: "Not computed: too many accounts",
};

/** "Exact, current" or "Rounded down to 100, 7 days late": how a publication is shown. */
export function publicationSummary(rounding: PublishedMetricRounding, delayDays: PublishedMetricDelay): string {
  return `${ROUNDING_LABELS[rounding]}, ${delayDays === 0 ? "current" : `${delayDays} days late`}`;
}

/**
 * What "Unpublish everything" reaches in a workspace (#413): live metric publications, engine and
 * self-reported alike, and published achievements.
 */
export type LivePublicationCounts = Readonly<{ metrics: number; achievements: number }>;

/**
 * "2 metrics and 1 achievement", "1 metric", or "3 achievements": the words the "Unpublish
 * everything" dialog and its result use, as its audit event does. Empty when both are zero.
 */
export function livePublicationsText(counts: LivePublicationCounts): string {
  const parts = [
    ...(counts.metrics > 0 ? [formatQuantity(counts.metrics, counts.metrics === 1 ? "metric" : "metrics")] : []),
    ...(counts.achievements > 0 ? [formatQuantity(counts.achievements, counts.achievements === 1 ? "achievement" : "achievements")] : []),
  ];
  return parts.join(" and ");
}
