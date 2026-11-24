import "server-only";

import { snapshotWindowStart, type ConnectionInput, type SnapshotInput } from "@/lib/dashboard/aggregate";
import { eventCountBucket, markerTypeIds, markerWindowStart, type EventCountRow, type MarkerCategory } from "@/lib/dashboard/markers";
import { trendCompleteFrom, trendWindowStart, type TrendGranularity } from "@/lib/dashboard/trends";
import { applyScope, type ScopeFilters } from "@/lib/filters/scope";
import { log } from "@/lib/log/logger";
import { createClient } from "@/lib/supabase/server";

import { getWorkspaceScope, loadDashboardSnapshots, loadMonthlySnapshots } from "./dashboard";
import { resolveTimelineScope } from "./timeline";

/** `completeFrom`: the first UTC day from which the chart is whole after its read stopped at the row cap, or null (#336). */
export type TrendData = Readonly<{ connections: ConnectionInput[]; snapshots: SnapshotInput[]; completeFrom: string | null }>;

/**
 * Snapshot history for the trend charts, narrowed to `scope` with the same rules as the dashboard,
 * newest first.
 * - `"daily"` uses only the dashboard window's rows (`snapshotWindowStart`, which holds the 30 day
 *   chart) from `loadDashboardSnapshots`, the read `getDashboardData` already made with the same
 *   `now` (#263), and issues no query of its own. An account with no row in that window has
 *   stopped reporting, and `buildTrends` expects a stopped account only up to its last row in
 *   both views (#308), so leaving its older rows out of the daily read changes nothing.
 * - `"monthly"` reads `loadMonthlySnapshots` from `trendWindowStart(now)`: each account's latest
 *   row per metric and UTC month, grouped in the database (#317). That is every row `buildTrends`
 *   uses for a month (the latest per account, the first month each account reported, and the date
 *   of each account's last row, which is its latest row of its last month and decides whether it
 *   stopped reporting), so the read grows with months instead of days and a long history keeps its
 *   oldest months.
 * The headline strip still reads its money and signup rows on its own (`getHeadlineSnapshots`
 * says why). The unique key `(external_account_id, metric_key, snapshot_date)` means each row is
 * already the latest value of its day. A read stopped at the row cap is whole only from a later
 * day, which `completeFrom` names for the chart. Call only after `requireWorkspace` has confirmed
 * membership.
 */
export async function getTrendData(
  workspaceId: string,
  granularity: TrendGranularity,
  now: Date,
  scope: ScopeFilters,
): Promise<TrendData> {
  const [workspaceScope, read] = await Promise.all([
    getWorkspaceScope(workspaceId),
    granularity === "daily"
      ? loadDashboardSnapshots(workspaceId, snapshotWindowStart(now))
      : loadMonthlySnapshots(workspaceId, trendWindowStart(now)),
  ]);
  const scoped = applyScope({ ...workspaceScope, snapshots: read.rows }, scope);
  return {
    connections: scoped.connections,
    snapshots: scoped.snapshots,
    completeFrom: trendCompleteFrom(read.completeFrom, granularity, now),
  };
}

// The database groups by the chart's bucket, so there is at most one row per bucket and type id
// (each type id belongs to one provider): 30 days or 13 months times about ten types, well under
// PostgREST's 1000 row max_rows. One request; an offset page would run the whole aggregate again.
const EVENT_COUNT_LIMIT = 1000;

/**
 * Event counts for the trend markers (#168) of `categories`, per `granularity` bucket from the first
 * day of its window, filtered by `scope` exactly as the timeline filters it. Counted in the database
 * (`activity_event_counts`), which counts nothing for a non-member. Call only after
 * `requireWorkspace` has confirmed membership.
 */
export async function getTrendEventCounts(
  workspaceId: string,
  granularity: TrendGranularity,
  now: Date,
  scope: ScopeFilters,
  categories: readonly MarkerCategory[],
): Promise<EventCountRow[]> {
  const typeIds = markerTypeIds(categories);
  if (typeIds.length === 0) return [];
  const { providers, accountIds } = await resolveTimelineScope(workspaceId, scope);
  // No account can match, so no event can either.
  if (accountIds !== null && accountIds.length === 0) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("activity_event_counts", {
      p_workspace_id: workspaceId,
      p_since: markerWindowStart(granularity, now),
      p_bucket: eventCountBucket(granularity),
      p_type_ids: typeIds,
      p_providers: [...providers],
      ...(accountIds === null ? {} : { p_account_ids: [...accountIds] }),
    })
    .order("bucket_start", { ascending: false })
    .order("provider", { ascending: true })
    .order("type_id", { ascending: true })
    .limit(EVENT_COUNT_LIMIT);
  if (error) throw new Error("Failed to load event counts for the trend markers", { cause: error });
  // Newest first, so if more types ever push past the limit, the oldest buckets are what is lost.
  if (data.length === EVENT_COUNT_LIMIT) log.warn("dashboard.event_counts_truncated", { workspaceId, granularity, rows: data.length });
  return data;
}
