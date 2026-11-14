import "server-only";

import { declaredEventTypes } from "@/lib/adapters/registry";
import { ANOMALY_TYPE_ID } from "@/lib/alerts/anomaly";
import { ALERT_TRIGGERED_TYPE_ID } from "@/lib/alerts/evaluate";
import { heatMatch, heatmapWindowStart, type HeatCountRow, type HeatFilter, type KnownEventType } from "@/lib/dashboard/heatmap";
import type { ScopeFilters } from "@/lib/filters/scope";
import { DAILY_SUMMARY_TYPE_ID } from "@/lib/jobs/daily-summary";
import { ALLOWANCE_RESET_TYPE_ID } from "@/lib/jobs/ingest";
import { SYNC_FAILED_TYPE_ID } from "@/lib/jobs/sync-connection";
import { CHANNEL_NEEDS_ATTENTION_TYPE_ID, NOTIFICATION_FAILED_TYPE_ID } from "@/lib/notifications/dispatch";
import { createClient } from "@/lib/supabase/server";
import { TIMELINE_TIME_ZONE } from "@/lib/timeline/query";

import { resolveTimelineScope } from "./timeline";

/**
 * Every event type the heatmap's filter groups can draw on: what the adapters declare, and
 * DevMacro's own events, which no adapter declares and which carry no category.
 */
const KNOWN_EVENT_TYPES: readonly KnownEventType[] = [
  ...declaredEventTypes,
  ...[
    ALERT_TRIGGERED_TYPE_ID,
    ALLOWANCE_RESET_TYPE_ID,
    ANOMALY_TYPE_ID,
    CHANNEL_NEEDS_ATTENTION_TYPE_ID,
    DAILY_SUMMARY_TYPE_ID,
    NOTIFICATION_FAILED_TYPE_ID,
    SYNC_FAILED_TYPE_ID,
  ].map((id) => ({ id })),
];

/**
 * Event counts per London weekday and hour for the activity heatmap (#414), over the last
 * `HEATMAP_DAYS` days, for the events `filter` groups, narrowed by `scope` exactly as the timeline
 * narrows it: a project resolves to its accounts, so events with no account (DevMacro's own) leave
 * the count once a project or account is chosen. Counted in the database (`activity_heatmap`), at
 * most one row per cell, so 168 rows at most and no paging. Call only after `requireWorkspace` has
 * confirmed membership.
 */
export async function getActivityHeatmap(
  workspaceId: string,
  filter: HeatFilter,
  now: Date,
  scope: ScopeFilters,
): Promise<HeatCountRow[]> {
  const match = heatMatch(filter, KNOWN_EVENT_TYPES);
  // A group with no known type and no severity has nothing to count.
  if (match.kind === "some" && match.typeIds.length === 0 && match.severities.length === 0) return [];
  const { providers, accountIds } = await resolveTimelineScope(workspaceId, scope);
  // No account can match, so no event can either.
  if (accountIds !== null && accountIds.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("activity_heatmap", {
    p_workspace_id: workspaceId,
    p_since: heatmapWindowStart(now),
    p_time_zone: TIMELINE_TIME_ZONE,
    ...(match.kind === "every" ? {} : { p_type_ids: [...match.typeIds], p_severities: [...match.severities] }),
    p_providers: [...providers],
    ...(accountIds === null ? {} : { p_account_ids: [...accountIds] }),
  });
  if (error) throw new Error("Failed to load the activity heatmap", { cause: error });
  return data;
}
