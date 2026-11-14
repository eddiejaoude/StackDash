import "server-only";

import { z } from "zod";

import { ProviderIdSchema, type ProviderId } from "@/lib/adapters/types";
import { formatQuantity } from "@/lib/format";
import { providerName } from "@/lib/providers";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  formulaPath,
  PUBLIC_METRIC_IDS,
  PUBLISHED_METRIC_ROUNDINGS,
  publicMetricDefinition,
  type MetricProvenance,
  type MetricUnit,
  type PublicMetricId,
  type PublishedMetricDelay,
  type PublishedMetricRounding,
} from "./definitions";
import { publishedDisplay, ROUNDING_STEP, UNAVAILABLE_LABELS } from "./display";
import { computePublicMetrics, type ComputedMetric, type PublicMetricStore, type UnavailableReason } from "./engine";
import { computeMetricHistories, firstEventMilestones, starMilestones, type Milestone } from "./history";
import { createSupabaseMetricStore } from "./supabase-store";
import { computeTrend } from "./trend";

/*
 * The public read API of the metric engine (#148). Badges and cards (#149), public project pages
 * (#150), and the leaderboard read published values only through here:
 *
 * - `loadPublishedProjectMetrics(projectId)`: every live publication of a project, computed now.
 * - `loadPublishedMetric(projectId, metricId)`: one engine metric, for a badge. Takes a
 *   `PublicMetricId`, so a self-reported value can never become a badge.
 * - `loadPublishedMetricCard(projectId, metricId)`: the same, with its trend, for a card.
 * - `loadPublishedProjectHistory(published)`: the 90 day history of what
 *   `loadPublishedProjectMetrics` returned, and the milestones it reveals, for the project page.
 *
 * The first three read `public_published_metrics()` (live rows only) with the service role and
 * compute each value from stored snapshots and events. Nothing here calls a provider, and nothing
 * returned names an account, a repository, or an amount of money. Each of the three returns null
 * for a project that does not exist and for one with nothing published, so a caller cannot tell
 * the two apart. `loadPublishedProjectHistory` takes what `loadPublishedProjectMetrics` returned
 * instead of a project id, so it can only describe what is published. `publishedTrend` (a card's
 * trend) and `computePublishedEngineMetrics` (the in-app settings page) compute against a store
 * their caller built.
 *
 * The yearly card (#151) is private until shared and asks for its own window, so it calls
 * `computePublicMetrics` in engine.ts with `createSupabaseMetricStore` and a `from` instead.
 *
 * Achievements (#413) are read beside them: `loadPublishedAchievements(projectId)` and
 * `loadPublishedAchievement(projectId, achievementId)` read `public_published_achievements()`, the
 * one public read of earned achievements. It returns published ones only, and never a private
 * title, a description, an account, a repository, or an amount.
 */

// Generated types mark every column of a set-returning function as non-null, but a row is either
// an engine metric or a self-reported value (published_metrics_source), so the rows are parsed.
const liveRowShape = {
  id: z.string(),
  workspace_id: z.string(),
  rounding: z.enum(PUBLISHED_METRIC_ROUNDINGS),
  delay_days: z.number(),
  published_at: z.string(),
};
const LiveRowSchema = z.union([
  z.object({
    ...liveRowShape,
    metric_id: z.enum(PUBLIC_METRIC_IDS),
    self_reported_label: z.null(),
    self_reported_value: z.null(),
    self_reported_unit: z.null(),
  }),
  z.object({
    ...liveRowShape,
    metric_id: z.null(),
    self_reported_label: z.string(),
    self_reported_value: z.number(),
    self_reported_unit: z.string(),
  }),
]);
type LiveRow = z.infer<typeof LiveRowSchema>;

export type PublishedValue =
  | Readonly<{
      status: "available";
      /** After the publication's rounding. */
      value: number;
      /** "1,204 stars", or "at least 1,200 stars" when rounded or a lower bound. */
      text: string;
      /** True when the value is rounded down or a lower bound: show it as "at least". */
      atLeast: boolean;
      /** The value is complete up to this sync. Show it beside the value. */
      lastSyncedAt: Date;
      /** Made up by the provider simulator (#131). Never show a simulated value as verified. */
      simulated: boolean;
    }>
  | Readonly<{ status: "unavailable"; reason: UnavailableReason; text: string }>;

export type PublishedEngineMetric = Readonly<{
  kind: "engine";
  /** The `published_metrics` row. */
  publicationId: string;
  metricId: PublicMetricId;
  label: string;
  unit: MetricUnit;
  provenance: MetricProvenance;
  /** Path of this metric's formula on the formulas page. */
  formulaPath: string;
  rounding: PublishedMetricRounding;
  delayDays: PublishedMetricDelay;
  publishedAt: Date;
  /** The moment the value describes: now, or `delayDays` before now. */
  asOf: Date;
  value: PublishedValue;
  /** The connected providers the value counts (`ComputedMetric.providers`), for the project page's icons. */
  providers: readonly ProviderId[];
}>;

/** A value a person typed (#147). Project pages only: never a badge, never on a leaderboard. */
export type PublishedSelfReportedMetric = Readonly<{
  kind: "self_reported";
  publicationId: string;
  label: string;
  unit: string;
  provenance: "self_reported";
  value: number;
  text: string;
  publishedAt: Date;
}>;

export type PublishedMetric = PublishedEngineMetric | PublishedSelfReportedMetric;

export type PublishedProjectMetrics = Readonly<{
  projectId: string;
  workspaceId: string;
  /** Engine metrics in definition order, then self-reported values by label. */
  metrics: readonly PublishedMetric[];
}>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** `delay_days` is checked by the database to be 0 or 7. */
function asDelay(days: number): PublishedMetricDelay {
  if (days === 0 || days === 7) return days;
  throw new Error(`Unexpected published metric delay: ${days}`);
}

export function publishedValue(computed: ComputedMetric, unit: MetricUnit, rounding: PublishedMetricRounding): PublishedValue {
  const { result } = computed;
  if (result.status === "unavailable") {
    return { status: "unavailable", reason: result.reason, text: UNAVAILABLE_LABELS[result.reason] };
  }
  const display = publishedDisplay(result.value, unit, rounding, result.lowerBound);
  return {
    status: "available",
    value: display.value,
    text: display.text,
    atLeast: result.lowerBound || rounding !== "exact",
    lastSyncedAt: result.lastSyncedAt,
    simulated: result.simulated,
  };
}

type EngineRow = Readonly<{
  id: string;
  metricId: PublicMetricId;
  rounding: PublishedMetricRounding;
  delayDays: number;
  publishedAt: string;
}>;

function toPublishedEngineMetrics(rows: readonly EngineRow[], computed: readonly ComputedMetric[]): PublishedEngineMetric[] {
  return rows.map((row, index) => {
    const result = computed[index];
    if (result === undefined) throw new Error("computePublicMetrics returned fewer results than requested");
    const definition = publicMetricDefinition(row.metricId);
    return {
      kind: "engine",
      publicationId: row.id,
      metricId: row.metricId,
      label: definition.label,
      unit: definition.unit,
      provenance: definition.provenance,
      formulaPath: formulaPath(row.metricId),
      rounding: row.rounding,
      delayDays: asDelay(row.delayDays),
      publishedAt: new Date(row.publishedAt),
      asOf: result.asOf,
      value: publishedValue(result, definition.unit, row.rounding),
      providers: result.providers,
    };
  });
}

/** Computes each live engine row at its own delay. Exported for the in-app settings page. */
export async function computePublishedEngineMetrics(
  store: PublicMetricStore,
  rows: readonly EngineRow[],
  now: Date,
): Promise<PublishedEngineMetric[]> {
  const computed = await computePublicMetrics(
    store,
    rows.map((row) => ({ metricId: row.metricId, asOf: new Date(now.getTime() - asDelay(row.delayDays) * DAY_MS) })),
  );
  return toPublishedEngineMetrics(rows, computed);
}

/** Each live engine row with no value, for `reason`: the settings page when nothing can be computed. */
export function unavailablePublishedEngineMetrics(rows: readonly EngineRow[], now: Date, reason: UnavailableReason): PublishedEngineMetric[] {
  return toPublishedEngineMetrics(
    rows,
    rows.map((row) => ({
      metricId: row.metricId,
      asOf: new Date(now.getTime() - asDelay(row.delayDays) * DAY_MS),
      result: { status: "unavailable", reason },
      providers: [],
    })),
  );
}

export function selfReportedMetric(row: Readonly<{ id: string; label: string; value: number; unit: string; publishedAt: string }>): PublishedSelfReportedMetric {
  return {
    kind: "self_reported",
    publicationId: row.id,
    label: row.label,
    unit: row.unit,
    provenance: "self_reported",
    value: row.value,
    text: formatQuantity(row.value, row.unit),
    publishedAt: new Date(row.publishedAt),
  };
}

// One request holds every live row: the unique indexes keep engine rows at one per definition, and
// publish_self_reported_metric keeps self-reported rows at SELF_REPORTED_LIVE_MAX per project, so a
// project has far fewer than PostgREST's max_rows (#220).
async function liveRows(projectId: string): Promise<LiveRow[]> {
  const { data, error } = await createAdminClient().rpc("public_published_metrics", { p_project_id: projectId });
  if (error) throw new Error("Failed to load published metrics", { cause: error });
  return z.array(LiveRowSchema).parse(data);
}

/** Every live publication of the project, computed at `now`, or null when nothing is published. */
export async function loadPublishedProjectMetrics(projectId: string, now: Date): Promise<PublishedProjectMetrics | null> {
  const rows = await liveRows(projectId);
  const first = rows[0];
  if (first === undefined) return null;

  const engineRows: EngineRow[] = [];
  const selfReported: PublishedSelfReportedMetric[] = [];
  for (const row of rows) {
    if (row.metric_id === null) {
      selfReported.push(
        selfReportedMetric({ id: row.id, label: row.self_reported_label, value: row.self_reported_value, unit: row.self_reported_unit, publishedAt: row.published_at }),
      );
    } else {
      engineRows.push({ id: row.id, metricId: row.metric_id, rounding: row.rounding, delayDays: row.delay_days, publishedAt: row.published_at });
    }
  }
  engineRows.sort((a, b) => PUBLIC_METRIC_IDS.indexOf(a.metricId) - PUBLIC_METRIC_IDS.indexOf(b.metricId));
  selfReported.sort((a, b) => a.label.localeCompare(b.label, "en-US"));
  const store = createSupabaseMetricStore(createAdminClient(), first.workspace_id, projectId);
  const engine = await computePublishedEngineMetrics(store, engineRows, now);
  return { projectId, workspaceId: first.workspace_id, metrics: [...engine, ...selfReported] };
}

/** The live publication row of one engine metric in the project, or undefined. */
async function liveEngineRow(projectId: string, metricId: PublicMetricId): Promise<(LiveRow & { metric_id: PublicMetricId }) | undefined> {
  for (const row of await liveRows(projectId)) {
    if (row.metric_id === metricId) return { ...row, metric_id: row.metric_id };
  }
  return undefined;
}

function engineRow(row: LiveRow & { metric_id: PublicMetricId }): EngineRow {
  return { id: row.id, metricId: row.metric_id, rounding: row.rounding, delayDays: row.delay_days, publishedAt: row.published_at };
}

/** One published engine metric of the project, computed at `now`, or null when it is not published. */
export async function loadPublishedMetric(projectId: string, metricId: PublicMetricId, now: Date): Promise<PublishedEngineMetric | null> {
  const row = await liveEngineRow(projectId, metricId);
  if (row === undefined) return null;
  const store = createSupabaseMetricStore(createAdminClient(), row.workspace_id, projectId);
  const [metric] = await computePublishedEngineMetrics(store, [engineRow(row)], now);
  return metric ?? null;
}

/** One day of a published metric's trend: the public value at `at`, or null when it had none. */
export type TrendPoint = Readonly<{ at: Date; value: number | null }>;

/**
 * The published value at the same moment on each of the `days` days before `metric.asOf`, oldest
 * first, ending with the value itself. Each point is computed by the engine as a value published
 * that day would have been, with the publication's rounding, so a rounded metric's trend never
 * reveals the exact numbers and a delayed one never reaches past its own `asOf`. The rows behind
 * every point are read once (`computeTrend` in trend.ts), so a card costs the same few queries
 * whatever `days` is.
 */
export async function publishedTrend(store: PublicMetricStore, metric: PublishedEngineMetric, days: number): Promise<TrendPoint[]> {
  const moments = Array.from({ length: days + 1 }, (_, index) => new Date(metric.asOf.getTime() - (days - index) * DAY_MS));
  const computed = await computeTrend(store, metric.metricId, moments);
  return moments.map((at, index) => {
    const point = computed[index];
    const value = point === null || point === undefined ? null : publishedValue(point, metric.unit, metric.rounding);
    return { at, value: value?.status === "available" ? value.value : null };
  });
}

export type PublishedMetricCard = Readonly<{ metric: PublishedEngineMetric; trend: readonly TrendPoint[] }>;

/** A published engine metric with its trend over `trendDays`, for its card (#149), or null. */
export async function loadPublishedMetricCard(
  projectId: string,
  metricId: PublicMetricId,
  now: Date,
  trendDays: number,
): Promise<PublishedMetricCard | null> {
  const row = await liveEngineRow(projectId, metricId);
  if (row === undefined) return null;
  const store = createSupabaseMetricStore(createAdminClient(), row.workspace_id, projectId);
  const [metric] = await computePublishedEngineMetrics(store, [engineRow(row)], now);
  if (metric === undefined) return null;
  return { metric, trend: await publishedTrend(store, metric, trendDays) };
}

export type PublishedHistoryPoint = Readonly<{ asOf: Date; value: PublishedValue }>;

export type PublishedMetricHistory = Readonly<{
  publicationId: string;
  metricId: PublicMetricId;
  label: string;
  /** One point per day, oldest first, ending at the publication's `asOf` with its rounding. */
  points: readonly PublishedHistoryPoint[];
}>;

export type PublishedProjectHistory = Readonly<{
  /** One per published engine metric, in the order of `metrics`. */
  histories: readonly PublishedMetricHistory[];
  /** Oldest first. */
  milestones: readonly Milestone[];
}>;

/**
 * The daily history of each published engine metric in `published`, each ending at its own
 * `asOf` (so a delayed publication stays delayed) and rounded the same way, plus the milestones
 * those publications reveal. It takes what `loadPublishedProjectMetrics` returned rather than a
 * project id, so it can only ever describe what is published. Self-reported values have no history.
 */
export async function loadPublishedProjectHistory(published: PublishedProjectMetrics): Promise<PublishedProjectHistory> {
  const engine = published.metrics.filter((metric): metric is PublishedEngineMetric => metric.kind === "engine");
  if (engine.length === 0) return { histories: [], milestones: [] };
  const store = createSupabaseMetricStore(createAdminClient(), published.workspaceId, published.projectId);
  const requests = engine.map((metric) => ({ metricId: metric.metricId, asOf: metric.asOf, roundingStep: ROUNDING_STEP[metric.rounding] }));
  const [computed, firsts] = await Promise.all([computeMetricHistories(store, requests), firstEventMilestones(store, requests)]);

  const histories = engine.map((metric, index): PublishedMetricHistory => ({
    publicationId: metric.publicationId,
    metricId: metric.metricId,
    label: metric.label,
    points: (computed[index] ?? []).map((point) => ({ asOf: point.asOf, value: publishedValue(point, metric.unit, metric.rounding) })),
  }));
  const stars = engine.flatMap((metric, index) => {
    const history = histories[index];
    if (metric.metricId !== "github-stars" || history === undefined) return [];
    const values = history.points.map((point) => ({
      asOf: point.asOf,
      value: point.value.status === "available" ? point.value.value : null,
    }));
    return starMilestones(values, ROUNDING_STEP[metric.rounding]);
  });
  const milestones = [...firsts, ...stars].sort((a, b) => a.at.getTime() - b.at.getTime());
  return { histories, milestones };
}

// Generated types call every column of a set-returning function non-null; the threshold is null
// for an achievement with no count behind it ("Night owl").
const PublishedAchievementRowSchema = z.object({
  achievement_id: z.string(),
  provider: ProviderIdSchema,
  public_title: z.string(),
  earned_at: z.string(),
  earned_precision: z.enum(["instant", "day"]),
  evidence: z.enum(["crossed", "at_least"]),
  threshold: z.number().nullable(),
  simulated: z.boolean(),
  published_at: z.string(),
});

/** A published achievement (#413) as public surfaces show it. Nothing private is in it. */
export type PublishedAchievement = Readonly<{
  achievementId: string;
  provider: ProviderId;
  /** The provider's display name, the badge's label ("Vercel"). */
  providerName: string;
  publicTitle: string;
  earnedAt: Date;
  /** `day`: earned on a whole UTC day (a daily total), stored at 00:00 UTC; show the date only. */
  earnedPrecision: "instant" | "day";
  /** `at_least`: StackDash first saw the value at or above `threshold`, not the crossing itself. */
  evidence: "crossed" | "at_least";
  threshold: number | null;
  /** Earned from data the provider simulator (#131) made up. Never show it as earned from real data. */
  simulated: boolean;
  publishedAt: Date;
}>;

/** Every published achievement of the project, oldest first; empty for an unknown project. */
export async function loadPublishedAchievements(projectId: string): Promise<PublishedAchievement[]> {
  const { data, error } = await createAdminClient().rpc("public_published_achievements", { p_project_id: projectId });
  if (error) throw new Error("Failed to load published achievements", { cause: error });
  return z
    .array(PublishedAchievementRowSchema)
    .parse(data)
    .map((row) => ({
      achievementId: row.achievement_id,
      provider: row.provider,
      providerName: providerName(row.provider),
      publicTitle: row.public_title,
      earnedAt: new Date(row.earned_at),
      earnedPrecision: row.earned_precision,
      evidence: row.evidence,
      threshold: row.threshold,
      simulated: row.simulated,
      publishedAt: new Date(row.published_at),
    }));
}

/**
 * One published achievement of the project, for its badge and card, or null when it is unknown,
 * not earned, or not published, alike. A project has a few dozen achievements at most, so the
 * project's published list is read and searched rather than adding a second database function.
 */
export async function loadPublishedAchievement(projectId: string, achievementId: string): Promise<PublishedAchievement | null> {
  const achievements = await loadPublishedAchievements(projectId);
  return achievements.find((achievement) => achievement.achievementId === achievementId) ?? null;
}
