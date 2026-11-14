/**
 * Event markers on the trend charts (#168): how many deployments, payments, signups, star events,
 * and triggered alerts happened in each trend bucket, and where each count leads on the timeline.
 * Pure: no I/O and no clock; the caller passes `now` and the counts the database returned.
 *
 * Rules decided here, once:
 * - Buckets are the trend buckets (`trendBuckets`): UTC days or UTC months, counted per bucket in
 *   the database. Buckets outside the chart's window are dropped, never moved to an edge bucket.
 * - A provider's events mark that provider's charts only. StackDash's own events (triggered
 *   alerts) carry no provider and mark every chart (decided on #168).
 * - Counts are filtered by the dashboard scope the same way the timeline filters, so a marker's
 *   count is what its timeline link lists. The link opens the bucket's dates, which the timeline
 *   reads as London days; in summer time that is one hour off the UTC bucket (decided on #168).
 * - Which event types belong to a category is listed here, by type id. An id that no adapter
 *   declares fails `markers.test.ts`, so the list cannot drift silently.
 */
import { ALERT_TRIGGERED_TYPE_ID } from "@/lib/alerts/evaluate";
import type { ScopeFilters } from "@/lib/filters/scope";
import type { Database } from "@/lib/supabase/database.types";
import { timelineHref } from "@/lib/timeline/query";

import type { ProviderId } from "./aggregate";
import { bucketLabel, trendBuckets, trendWindowStart, type TrendGranularity } from "./trends";

/** Chart and toggle order. */
export const MARKER_CATEGORIES = ["deployments", "payments", "signups", "stars", "alerts"] as const;

export type MarkerCategory = (typeof MARKER_CATEGORIES)[number];

type CategoryInfo = Readonly<{
  /** Toggle, legend, and table wording. */
  label: string;
  one: string;
  many: string;
  typeIds: readonly string[];
  /** StackDash's own events have no provider, so their links never filter by one. */
  owner: "provider" | "stackdash";
}>;

const CATEGORIES: Readonly<Record<MarkerCategory, CategoryInfo>> = {
  // Finished deployments only: a started deployment has not shipped anything yet. Railway's
  // `crashed` and `removed` say what became of a deployment after it finished, usually one already
  // counted as deployed, so they would count it twice. A GitLab pipeline is a CI run, which may
  // deploy nothing; GitLab records the deployments it does make as their own events. A GitLab or
  // Sentry release is a version, not a deployment: Sentry records deploys of a release separately,
  // and its adapter does not read them.
  deployments: {
    label: "Deployments",
    one: "deployment",
    many: "deployments",
    typeIds: [
      "digitalocean.deployment.failed",
      "digitalocean.deployment.succeeded",
      "fake.deploy.succeeded",
      "gitlab.deployment.failed",
      "gitlab.deployment.succeeded",
      "railway.deployment.deployed",
      "railway.deployment.failed",
      "vercel.deployment.failed",
      "vercel.deployment.succeeded",
    ],
    owner: "provider",
  },
  // Successful charges and paid orders only, renewals included: a failed or refunded charge, a
  // refund, or an invoice issued is not money that came in that day.
  payments: {
    label: "Payments",
    one: "payment",
    many: "payments",
    typeIds: ["polar.order.paid", "stripe.charge.succeeded"],
    owner: "provider",
  },
  // One event per person who signed up. A new Stripe customer counts: it is the only signup signal
  // a Stripe-only workspace has. A started subscription does not (Stripe's or Polar's): an existing
  // customer starts one too. `posthog.signups.daily` and `supabase.auth.daily_summary` stay out: each
  // is one event per project and day holding that day's total, so counting it would read "1 signup"
  // for a day of 40, and Supabase's signups are already counted one by one through
  // `supabase.auth.signup`. Stars count their daily event because that category is labeled "star
  // events"; a signup marker says signups.
  signups: {
    label: "Signups",
    one: "signup",
    many: "signups",
    typeIds: ["fake.signup", "stripe.customer.created", "supabase.auth.signup"],
    owner: "provider",
  },
  // Events, not stars: one daily event can stand for many stars, and the count is of events.
  stars: {
    label: "Stars",
    one: "star event",
    many: "star events",
    typeIds: ["github.stars.daily", "github.stars.milestone"],
    owner: "provider",
  },
  alerts: {
    label: "Triggered alerts",
    one: "triggered alert",
    many: "triggered alerts",
    typeIds: [ALERT_TRIGGERED_TYPE_ID],
    owner: "stackdash",
  },
};

export function isMarkerCategory(value: string): value is MarkerCategory {
  return (MARKER_CATEGORIES as readonly string[]).includes(value);
}

export function markerCategoryLabel(category: MarkerCategory): string {
  return CATEGORIES[category].label;
}

/** Every type id the categories count, in category order. */
export function markerTypeIds(categories: readonly MarkerCategory[]): string[] {
  return MARKER_CATEGORIES.filter((category) => categories.includes(category)).flatMap(
    (category) => CATEGORIES[category].typeIds,
  );
}

// URL state: hidden categories, so the default (every category shown) stays out of the URL.

/** The URL key for a hidden category, repeated per category. */
export const HIDE_MARKER_PARAM = "hide_marker";

/** `hidden` without duplicates, in category order, so equal states have equal URLs. */
export function canonicalHidden(hidden: readonly MarkerCategory[]): MarkerCategory[] {
  return MARKER_CATEGORIES.filter((category) => hidden.includes(category));
}

export function shownCategories(hidden: readonly MarkerCategory[]): MarkerCategory[] {
  return MARKER_CATEGORIES.filter((category) => !hidden.includes(category));
}

/** The hidden list after toggling `category`. */
export function toggleHidden(hidden: readonly MarkerCategory[], category: MarkerCategory): MarkerCategory[] {
  return canonicalHidden(hidden.includes(category) ? hidden.filter((entry) => entry !== category) : [...hidden, category]);
}

// Counting.

// Generated function types mark every returned column non-null; `provider` is null for StackDash's
// own events.
export type EventCountRow = Readonly<
  Pick<Database["public"]["Functions"]["activity_event_counts"]["Returns"][number], "bucket_start" | "type_id" | "event_count"> & {
    provider: ProviderId | null;
  }
>;

/** First UTC date the counts are needed from: the first day of the oldest bucket. */
export function markerWindowStart(granularity: TrendGranularity, now: Date): string {
  return granularity === "daily" ? (trendBuckets("daily", now)[0] ?? "") : trendWindowStart(now);
}

/** The unit `activity_event_counts` groups by for `granularity`. */
export function eventCountBucket(granularity: TrendGranularity): "day" | "month" {
  return granularity === "daily" ? "day" : "month";
}

export type EventBucketCount = Readonly<{
  /** null for StackDash's own events. */
  provider: ProviderId | null;
  category: MarkerCategory;
  /** A trend bucket: `YYYY-MM-DD` or `YYYY-MM`, UTC. */
  bucket: string;
  count: number;
}>;

/**
 * Counts per bucket summed per provider and category for `granularity`. Rows for types in no
 * category, and buckets outside the window, are dropped. Oldest bucket first, then category order.
 */
export function bucketEventCounts(
  rows: readonly EventCountRow[],
  granularity: TrendGranularity,
  now: Date,
): EventBucketCount[] {
  const inWindow = new Set(trendBuckets(granularity, now));
  const totals = new Map<string, { provider: ProviderId | null; category: MarkerCategory; bucket: string; count: number }>();
  for (const row of rows) {
    const category = MARKER_CATEGORIES.find((entry) => CATEGORIES[entry].typeIds.includes(row.type_id));
    const bucket = granularity === "daily" ? row.bucket_start : row.bucket_start.slice(0, 7);
    if (category === undefined || !inWindow.has(bucket) || row.event_count <= 0) continue;
    const key = `${row.provider ?? ""} ${category} ${bucket}`;
    const total = totals.get(key);
    if (total === undefined) totals.set(key, { provider: row.provider, category, bucket, count: row.event_count });
    else total.count += row.event_count;
  }
  const order = (count: EventBucketCount) => MARKER_CATEGORIES.indexOf(count.category);
  return [...totals.values()].sort(
    (a, b) => a.bucket.localeCompare(b.bucket) || order(a) - order(b) || (a.provider ?? "").localeCompare(b.provider ?? ""),
  );
}

// Markers for one chart.

export type TrendMarker = Readonly<{
  category: MarkerCategory;
  bucket: string;
  count: number;
  /** The timeline filtered to the counted events. */
  href: string;
}>;

/** The bucket's first and last UTC date, inclusive. */
function bucketDates(bucket: string, granularity: TrendGranularity): Readonly<{ from: string; to: string }> {
  if (granularity === "daily") return { from: bucket, to: bucket };
  const [year, month] = bucket.split("-").map(Number);
  const last = new Date(Date.UTC(year ?? 0, month ?? 1, 0)).toISOString().slice(0, 10);
  return { from: `${bucket}-01`, to: last };
}

/**
 * The timeline filtered to one marker's events: the category's types (only the chart provider's,
 * for provider events), the bucket's dates, and the dashboard scope narrowed to the provider.
 */
export function markerTimelineHref(
  timelinePath: string,
  marker: Readonly<{ provider: ProviderId; category: MarkerCategory; bucket: string }>,
  granularity: TrendGranularity,
  scope: ScopeFilters,
): string {
  const info = CATEGORIES[marker.category];
  const own = info.owner === "provider";
  const { from, to } = bucketDates(marker.bucket, granularity);
  return timelineHref(
    timelinePath,
    {
      types: own ? info.typeIds.filter((typeId) => typeId.startsWith(`${marker.provider}.`)) : [...info.typeIds],
      severities: [],
      from,
      to,
      timeRange: null,
      search: null,
      cursor: null,
      scope: own ? { ...scope, providers: [marker.provider] } : scope,
    },
    null,
  );
}

/**
 * Markers for one provider's chart, oldest bucket first and then in category order, which is the
 * keyboard order. Only categories in `shown` are included.
 */
export function chartMarkers(
  counts: readonly EventBucketCount[],
  input: Readonly<{
    provider: ProviderId;
    shown: readonly MarkerCategory[];
    granularity: TrendGranularity;
    timelinePath: string;
    scope: ScopeFilters;
  }>,
): TrendMarker[] {
  return counts
    .filter((count) => input.shown.includes(count.category))
    .filter((count) => (CATEGORIES[count.category].owner === "provider" ? count.provider === input.provider : count.provider === null))
    .map((count) => ({
      category: count.category,
      bucket: count.bucket,
      count: count.count,
      href: markerTimelineHref(input.timelinePath, { ...count, provider: input.provider }, input.granularity, input.scope),
    }));
}

// Wording.

const countFormat = new Intl.NumberFormat("en-US");

/** "14 deployments", "1 triggered alert". */
export function markerCountText(category: MarkerCategory, count: number): string {
  const info = CATEGORIES[category];
  return `${countFormat.format(count)} ${count === 1 ? info.one : info.many}`;
}

/** A marker's accessible name: "14 deployments on 2026-10-21", "3 payments in October 2026". */
export function markerLabel(marker: Pick<TrendMarker, "category" | "bucket" | "count">, granularity: TrendGranularity): string {
  const when = granularity === "daily" ? `on ${marker.bucket}` : `in ${bucketLabel(marker.bucket, granularity)}`;
  return `${markerCountText(marker.category, marker.count)} ${when}`;
}
