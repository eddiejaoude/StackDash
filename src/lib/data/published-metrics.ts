import "server-only";

import { cache } from "react";

import { formatUtcDate } from "@/lib/format";
import { log } from "@/lib/log/logger";
import {
  formulaPath,
  PUBLIC_METRICS,
  type MetricProvenance,
  type MetricUnit,
  type PublicMetricId,
} from "@/lib/public-metrics/definitions";
import type { LivePublicationCounts } from "@/lib/public-metrics/display";
import { computePublicMetrics, type ComputedMetric } from "@/lib/public-metrics/engine";
import {
  computePublishedEngineMetrics,
  publishedValue,
  selfReportedMetric,
  unavailablePublishedEngineMetrics,
  type PublishedEngineMetric,
  type PublishedSelfReportedMetric,
  type PublishedValue,
} from "@/lib/public-metrics/published";
import type { ShareSurface } from "@/lib/public-metrics/requests";
import { AccountBoundError, createSupabaseMetricStore } from "@/lib/public-metrics/supabase-store";
import { createClient } from "@/lib/supabase/server";

/*
 * The public metrics settings page of one project (#148). Reads run as the signed-in member, so row
 * level security limits them to the workspace; publishing goes through the Server Actions beside
 * the page.
 */

/** One engine metric: its current value as it would be published exactly, and its publication. */
export type ProjectMetricStatus = Readonly<{
  metricId: PublicMetricId;
  label: string;
  unit: MetricUnit;
  provenance: MetricProvenance;
  formulaPath: string;
  current: PublishedValue;
  publication: PublishedEngineMetric | null;
  /** Times StackDash served the metric's badge and card in the last `VIEW_WINDOW_DAYS` UTC days. */
  views: Readonly<Record<ShareSurface, number>>;
}>;

export type ProjectPublications = Readonly<{
  project: Readonly<{ id: string; name: string }>;
  metrics: readonly ProjectMetricStatus[];
  selfReported: readonly PublishedSelfReportedMetric[];
  /**
   * The project has more included accounts than public metrics read (ACCOUNTS_LIMIT), so every
   * engine metric is unavailable here and wherever it is published (#220).
   */
  tooManyAccounts: boolean;
}>;

// One live row per engine metric (the unique indexes keep that part at the number of definitions)
// plus at most SELF_REPORTED_LIVE_MAX self-reported values, which publish_self_reported_metric
// enforces (#220).
const LIVE_ROWS_LIMIT = 200;

/** The share dialog's "in the last 7 days", today (UTC) included. */
export const VIEW_WINDOW_DAYS = 7;
// One row per metric, surface, and day: 13 metrics, 2 surfaces, 7 days.
const VIEW_ROWS_LIMIT = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Null when the project is not in the workspace (or does not exist): one answer for both. */
export const loadProjectPublications = cache(
  async (workspaceId: string, projectId: string, now: Date): Promise<ProjectPublications | null> => {
    const supabase = await createClient();
    const [project, live, views] = await Promise.all([
      supabase.from("projects").select("id, name").eq("workspace_id", workspaceId).eq("id", projectId).maybeSingle(),
      supabase
        .from("published_metrics")
        .select("id, metric_id, self_reported_label, self_reported_value, self_reported_unit, rounding, delay_days, published_at")
        .eq("workspace_id", workspaceId)
        .eq("project_id", projectId)
        .is("revoked_at", null)
        .order("published_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(LIVE_ROWS_LIMIT),
      // Served by the primary key (project_id, metric_id, surface, view_date).
      supabase
        .from("published_metric_views")
        .select("metric_id, surface, views")
        .eq("workspace_id", workspaceId)
        .eq("project_id", projectId)
        .gte("view_date", formatUtcDate(new Date(now.getTime() - (VIEW_WINDOW_DAYS - 1) * DAY_MS)))
        .limit(VIEW_ROWS_LIMIT),
    ]);
    if (project.error) throw new Error("Failed to load the project", { cause: project.error });
    if (live.error) throw new Error("Failed to load published metrics", { cause: live.error });
    if (views.error) throw new Error("Failed to load published metric views", { cause: views.error });
    if (project.data === null) return null;

    const engineRows = live.data.flatMap((row) =>
      row.metric_id === null
        ? []
        : [{ id: row.id, metricId: row.metric_id, rounding: row.rounding, delayDays: row.delay_days, publishedAt: row.published_at }],
    );
    const selfReported = live.data.flatMap((row) =>
      row.metric_id !== null || row.self_reported_label === null || row.self_reported_value === null || row.self_reported_unit === null
        ? []
        : [
            selfReportedMetric({
              id: row.id,
              label: row.self_reported_label,
              value: row.self_reported_value,
              unit: row.self_reported_unit,
              publishedAt: row.published_at,
            }),
          ],
    );

    const store = createSupabaseMetricStore(supabase, workspaceId, projectId);
    const currentRequests = PUBLIC_METRICS.map((definition) => ({ metricId: definition.id, asOf: now }));
    let current: readonly ComputedMetric[];
    let published: readonly PublishedEngineMetric[];
    let tooManyAccounts = false;
    try {
      [current, published] = await Promise.all([
        computePublicMetrics(store, currentRequests),
        computePublishedEngineMetrics(store, engineRows, now),
      ]);
    } catch (error) {
      // Past the account read's bound nothing may be computed (#220), but this page holds every
      // Unpublish control, so the owner keeps it, with each engine metric unavailable and the
      // reason. Any other failure is still the page's error.
      if (!(error instanceof AccountBoundError)) throw error;
      log.warn("public_metrics.settings_accounts_over_limit", { workspaceId, projectId });
      tooManyAccounts = true;
      current = currentRequests.map((request) => ({ ...request, result: { status: "unavailable", reason: "too_many_accounts" }, providers: [] }));
      published = unavailablePublishedEngineMetrics(engineRows, now, "too_many_accounts");
    }
    const publications = new Map(published.map((publication) => [publication.metricId, publication]));
    const viewCounts = new Map<string, number>();
    for (const row of views.data) {
      const key = `${row.metric_id}:${row.surface}`;
      viewCounts.set(key, (viewCounts.get(key) ?? 0) + row.views);
    }

    const metrics = PUBLIC_METRICS.map((definition, index): ProjectMetricStatus => {
      const computed = current[index];
      if (computed === undefined) throw new Error("computePublicMetrics returned fewer results than requested");
      return {
        metricId: definition.id,
        label: definition.label,
        unit: definition.unit,
        provenance: definition.provenance,
        formulaPath: formulaPath(definition.id),
        current: publishedValue(computed, definition.unit, "exact"),
        publication: publications.get(definition.id) ?? null,
        views: {
          badge: viewCounts.get(`${definition.id}:badge`) ?? 0,
          card: viewCounts.get(`${definition.id}:card`) ?? 0,
        },
      };
    });
    return {
      project: project.data,
      metrics,
      selfReported: selfReported.sort((a, b) => a.label.localeCompare(b.label, "en-US")),
      tooManyAccounts,
    };
  },
);

/**
 * What the workspace has public, for the "Unpublish everything" control: live metric publications
 * and published achievements (#413), the two things `unpublish_all_metrics` takes down. The
 * achievement count uses project_achievement_publications_workspace_idx.
 */
export const countLivePublications = cache(async (workspaceId: string): Promise<LivePublicationCounts> => {
  const supabase = await createClient();
  const [metrics, achievements] = await Promise.all([
    supabase
      .from("published_metrics")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null),
    supabase
      .from("project_achievement_publications")
      .select("project_achievement_id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId),
  ]);
  if (metrics.error) throw new Error("Failed to count published metrics", { cause: metrics.error });
  if (achievements.error) throw new Error("Failed to count published achievements", { cause: achievements.error });
  if (metrics.count === null || achievements.count === null) throw new Error("Live publication count missing from the response");
  return { metrics: metrics.count, achievements: achievements.count };
});
