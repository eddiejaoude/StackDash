import "server-only";

import { cache } from "react";

import { declaredDailyTotals, declaredProjectedSpend } from "@/lib/adapters/registry";
import { addUtcDays, ANOMALY_KINDS, ANOMALY_TYPE_ID, checkedRows } from "@/lib/alerts/anomaly";
import type { ProviderId, SnapshotInput } from "@/lib/dashboard/aggregate";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import { londonDate } from "@/lib/timeline/days";
import { londonDayStart } from "@/lib/timeline/query";

/**
 * Anomaly detection settings and results (#169), read and written as the signed-in user, so row
 * level security (viewer reads, admin writes) and the column grants apply on top of the role check
 * every Server Action makes first. Every write is filtered by `workspace_id`, so an id from another
 * workspace matches nothing and reads exactly like a missing one.
 */

type Tables = Database["public"]["Tables"];

export type AnomalyMuteItem = Pick<Tables["anomaly_mutes"]["Row"], "id" | "provider" | "metric_key" | "created_at">;

export type AnomalyControls = { enabled: boolean; mutes: AnomalyMuteItem[] };

/** A spend or usage metric this workspace reports, which a person can mute. */
export type AnomalyMetric = { provider: ProviderId; metricKey: string; label: string };

/**
 * How many anomaly events the workspace recorded in the window, and the window's first London
 * calendar day (`YYYY-MM-DD`), which the timeline link takes as its `from` date so it lists exactly
 * the events counted (#664). The dashboard lists the days elsewhere (#291).
 */
export type RecentAnomalies = { count: number; from: string };

/**
 * The dashboard's alerts summary counts the anomalies of this many London calendar days, today
 * included: whole days, as the timeline's date filter reads them, so its link can list them.
 * "What changed" checks this many UTC days before today.
 */
export const RECENT_ANOMALY_DAYS = 7;

/** The first London calendar day of the alerts summary's window at `now`: today and the 6 days before. */
export function recentAnomaliesFrom(now: Date): string {
  // Calendar arithmetic on the date itself, so a 23 or 25 hour clock-change day moves nothing.
  return addUtcDays(londonDate(now), 1 - RECENT_ANOMALY_DAYS);
}

// Mutes per workspace: one per metric a person chose to silence, a handful in practice.
const MUTE_LIMIT = 200;
// Rows of each series' newest snapshot date (`snapshot_series_day_rows`): about one per series,
// since most series report on the same day. A workspace past this many keeps its newest dates.
const SERIES_DAY_ROWS_LIMIT = 1000;

// ── Reads ───────────────────────────────────────────────────────────────────────────────────────

/** Whether detection is on, and the muted metrics, oldest mute first. */
export const getAnomalyControls = cache(async (workspaceId: string): Promise<AnomalyControls> => {
  const supabase = await createClient();
  const [workspace, mutes] = await Promise.all([
    supabase.from("workspaces").select("anomaly_detection_enabled").eq("id", workspaceId).single(),
    supabase
      .from("anomaly_mutes")
      .select("id, provider, metric_key, created_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(MUTE_LIMIT),
  ]);
  if (workspace.error) throw new Error("Failed to read the anomaly detection setting", { cause: workspace.error });
  if (mutes.error) throw new Error("Failed to list muted metrics", { cause: mutes.error });
  return { enabled: workspace.data.anomaly_detection_enabled, mutes: mutes.data };
});

/**
 * The spend and usage metrics a person can mute, sorted by label: every series the workspace's
 * snapshots hold, judged by `checkedRows` on the series' newest snapshot date, so a breakdown
 * beside its total (a GitHub SKU), a day inside a billing month (`github.daily_spend.<product>`),
 * a provider's declared projection (#223), or a declared daily total (GitHub's new stars per day)
 * is not offered, because muting it would silence nothing. A series that stopped reporting is
 * offered on purpose, even though detection reads only the last `ANOMALY_WINDOW_DAYS` and skips it
 * for now: a mute holds by provider and metric key, so one set before the series resumes still
 * applies when it does (#319). Read per series in the database, and a non-member gets none.
 */
export const listAnomalyMetrics = cache(async (workspaceId: string): Promise<AnomalyMetric[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("snapshot_series_day_rows", { p_workspace_id: workspaceId, p_kinds: [...ANOMALY_KINDS] })
    .select(
      "id, provider, connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, amount_minor, currency, period_start, period_end, point_at, resets_at, retrieved_at, provenance_source, pricing_source",
    )
    .is("point_at", null)
    .order("snapshot_date", { ascending: false })
    .order("id", { ascending: true })
    .limit(SERIES_DAY_ROWS_LIMIT);
  if (error) throw new Error("Failed to list spend and usage metrics", { cause: error });
  // The function's columns are typed not null; the snapshot columns behind them are nullable.
  const rows: ReadonlyArray<SnapshotInput & Readonly<{ provider: ProviderId }>> = data;
  // The rules run per snapshot date, so a date the limit cut short could keep a row its total
  // would have dropped: leave the oldest date out when the read was full and holds more than one.
  const oldest = rows.at(-1)?.snapshot_date;
  const full = rows.length === SERIES_DAY_ROWS_LIMIT && rows.some((row) => row.snapshot_date !== oldest);
  const scanned = full ? rows.filter((row) => row.snapshot_date !== oldest) : rows;
  const byKey = new Map<string, AnomalyMetric>();
  for (const row of checkedRows(scanned, declaredProjectedSpend, declaredDailyTotals)) {
    const key = `${row.provider} ${row.metric_key}`;
    // Newest first, so the first label seen is the current one.
    if (!byKey.has(key)) byKey.set(key, { provider: row.provider, metricKey: row.metric_key, label: row.label });
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label, "en-US") || a.metricKey.localeCompare(b.metricKey));
});

/**
 * How many anomaly events the workspace recorded from the start of the London calendar day `from`
 * (`YYYY-MM-DD`), for the dashboard's alerts summary. The bound is the instant the timeline's
 * `from` filter starts at (`londonDayStart`), with no end, as that filter has none, so the summary's
 * link lists the events counted here. A count only, so no event row leaves the database. Reads
 * through `activity_events_workspace_timeline_idx` (workspace_id, occurred_at desc, id desc). A
 * read that succeeds with no count reads as 0, as `countUnacknowledgedAlerts` does; a failed read
 * throws.
 */
export const getRecentAnomalies = cache(async (workspaceId: string, from: string): Promise<RecentAnomalies> => {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("activity_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("type_id", ANOMALY_TYPE_ID)
    .gte("occurred_at", londonDayStart(from).toISOString());
  if (error) throw new Error("Failed to count recent anomalies", { cause: error });
  return { count: count ?? 0, from };
});

// ── Writes ──────────────────────────────────────────────────────────────────────────────────────

/** Turns detection on or off. False when row level security refused (the role changed). */
export async function setAnomalyDetectionEnabled(workspaceId: string, enabled: boolean): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .update({ anomaly_detection_enabled: enabled })
    .eq("id", workspaceId)
    .select("id");
  if (error) throw new Error("Failed to change the anomaly detection setting", { cause: error });
  return data.length > 0;
}

/** Mutes one metric. Muting a metric that is already muted is a success that changes nothing. */
export async function muteAnomalyMetric(workspaceId: string, provider: ProviderId, metricKey: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("anomaly_mutes")
    .upsert(
      { workspace_id: workspaceId, provider, metric_key: metricKey },
      { onConflict: "workspace_id,provider,metric_key", ignoreDuplicates: true },
    );
  if (error) throw new Error("Failed to mute the metric", { cause: error });
}

/** Removes a mute. False when no mute with `id` exists in this workspace. */
export async function unmuteAnomalyMetric(workspaceId: string, id: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("anomaly_mutes")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .select("id");
  if (error) throw new Error("Failed to unmute the metric", { cause: error });
  return data.length > 0;
}
